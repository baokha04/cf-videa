import type { Ctx } from '../http/guard';
import { pathParam, readJson, requireUser } from '../http/guard';
import { notFound } from '../http/response';
import * as ideasDb from '../db/ideas';
import * as likesDb from '../db/likes';
import { setIdeaTags, tagsForIdeas } from '../db/tags';
import { hooksForIdeas, setIdeaHooks } from '../db/hooks';
import { buildEmbedText, contentHash } from '../vec/embeddings';
import { deleteIdeaVectors, metaSignature, queueGc } from '../vec/index';
import { invalidateTasteVector } from '../vec/profile';
import { syncIdea } from '../vec/sync';
import { enforce, LIMITS } from '../auth/ratelimit';
import { badRequest } from '../http/response';
import {
  IDEA_KINDS,
  IDEA_STATUSES,
  PLATFORMS,
  type IdeaDto,
  type IdeaKind,
  type IdeaRow,
  type IdeaStatus,
  type Platform,
} from '../types';
import {
  clampLimit,
  normText,
  oneOf,
  parseHooks,
  parseTags,
  requiredText,
} from '../util/validate';

/**
 * Danh sách trắng các trường được ghi. user_id, id, created_at, content_hash,
 * embedded_hash KHÔNG nằm ở đây và không bao giờ đọc từ request — quyền sở hữu
 * luôn lấy từ phiên đăng nhập.
 */
function parseIdeaInput(body: Record<string, unknown>, base?: IdeaRow): ideasDb.IdeaInput {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const kind = has('kind') || !base
    ? oneOf<IdeaKind>(body['kind'], IDEA_KINDS, 'kind', 'origin')
    : base.kind;
  const parentRaw = has('parent_id') || !base ? body['parent_id'] : base.parent_id;
  const parentId = normText(parentRaw ?? '', 64, 'parent_id') || null;

  return {
    title: has('title') || !base
      ? requiredText(body['title'], 200, 'title')
      : base.title,
    hook: has('hook') || !base ? normText(body['hook'], 500, 'hook') : base.hook,
    script_outline: has('script_outline') || !base
      ? normText(body['script_outline'], 8000, 'script_outline')
      : base.script_outline,
    source_idea: has('source_idea') || !base
      ? normText(body['source_idea'], 8000, 'source_idea')
      : base.source_idea,
    prompt_recipe: has('prompt_recipe') || !base
      ? normText(body['prompt_recipe'], 4000, 'prompt_recipe')
      : base.prompt_recipe,
    negative_prompt: has('negative_prompt') || !base
      ? normText(body['negative_prompt'], 2000, 'negative_prompt')
      : base.negative_prompt,
    platform: has('platform') || !base
      ? oneOf<Platform>(body['platform'], PLATFORMS, 'platform', 'tiktok')
      : base.platform,
    niche: has('niche') || !base ? normText(body['niche'], 100, 'niche') : base.niche,
    status: has('status') || !base
      ? oneOf<IdeaStatus>(body['status'], IDEA_STATUSES, 'status', 'idea')
      : base.status,
    // Một biến thể không có cha thì không phải biến thể. Chuẩn hoá ngay ở đây để
    // tầng dưới không bao giờ nhận được cặp (kind, parent_id) mâu thuẫn.
    kind: kind === 'variant' && parentId ? 'variant' : 'origin',
    parent_id: kind === 'variant' ? parentId : null,
  };
}

/**
 * Kiểm tra hàng cha TRƯỚC khi ghi, chỉ để có thông báo lỗi tử tế.
 *
 * Bản thân câu lệnh INSERT/UPDATE đã tự ràng buộc (xem PARENT_SQL trong
 * src/db/ideas.ts) nên đây không phải lớp bảo vệ — nếu bỏ hàm này đi thì dữ liệu vẫn
 * đúng, chỉ là người dùng nhận được một ý tưởng gốc trong im lặng thay vì biết vì sao.
 */
async function checkParent(
  c: Ctx,
  userId: string,
  input: ideasDb.IdeaInput,
  selfId?: string,
): Promise<void> {
  if (input.kind !== 'variant' || !input.parent_id) return;
  if (input.parent_id === selfId) {
    throw badRequest('invalid_parent', 'Một ý tưởng không thể là biến thể của chính nó.');
  }
  const parent = await ideasDb.getById(c.env, userId, input.parent_id);
  if (!parent) throw notFound('Không tìm thấy ý tưởng gốc.');
  if (parent.kind !== 'origin') {
    throw badRequest(
      'invalid_parent',
      'Biến thể chỉ mọc ra từ ý tưởng gốc, không mọc tiếp từ một biến thể khác.',
    );
  }
  if (selfId && (await ideasDb.hasVariants(c.env, userId, selfId))) {
    throw badRequest(
      'has_variants',
      'Ý tưởng này đang có biến thể của riêng nó nên không thể trở thành biến thể.',
    );
  }
}

function toDto(
  row: IdeaRow,
  tags: string[],
  hooks: string[],
  variantCount: number,
  liked: boolean,
  score?: number,
): IdeaDto {
  return {
    id: row.id,
    title: row.title,
    hook: row.hook,
    script_outline: row.script_outline,
    source_idea: row.source_idea,
    prompt_recipe: row.prompt_recipe,
    negative_prompt: row.negative_prompt,
    platform: row.platform,
    niche: row.niche,
    status: row.status,
    visibility: row.visibility,
    kind: row.kind,
    parent_id: row.parent_id,
    tags,
    hooks,
    variant_count: variantCount,
    liked,
    // "Đã index" nghĩa là vector trên Vectorize khớp CẢ nội dung LẪN metadata.
    indexed:
      row.embedded_hash === row.content_hash &&
      row.indexed_meta_hash === metaSignature(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(score !== undefined ? { score } : {}),
  };
}

/**
 * Gắn tag, danh mục hook, số biến thể và trạng thái like cho một loạt hàng.
 *
 * Bốn truy vấn cho N hàng, không phải 4N: mọi thứ đi theo lô. Đếm biến thể chỉ hỏi
 * cho những hàng LÀ ý tưởng gốc — một biến thể theo định nghĩa không có con.
 */
export async function hydrate(
  c: Ctx,
  userId: string,
  rows: IdeaRow[],
  scores?: Map<string, number>,
): Promise<IdeaDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const originIds = rows.filter((r) => r.kind === 'origin').map((r) => r.id);
  const [tagMap, hookMap, variantMap, liked] = await Promise.all([
    tagsForIdeas(c.env, ids),
    hooksForIdeas(c.env, ids),
    ideasDb.variantCounts(c.env, userId, originIds),
    likesDb.likedSet(c.env, userId, ids),
  ]);
  return rows.map((r) =>
    toDto(
      r,
      tagMap.get(r.id) ?? [],
      hookMap.get(r.id) ?? [],
      variantMap.get(r.id) ?? 0,
      liked.has(r.id),
      scores?.get(r.id),
    ),
  );
}

export async function listIdeas(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const q = c.req.query();
  const limit = clampLimit(q['limit'] ?? null);
  const { rows, nextCursor } = await ideasDb.list(
    c.env,
    user.id,
    {
      ...(q['status'] ? { status: oneOf<IdeaStatus>(q['status'], IDEA_STATUSES, 'status') } : {}),
      ...(q['platform'] ? { platform: oneOf<Platform>(q['platform'], PLATFORMS, 'platform') } : {}),
      ...(q['niche'] ? { niche: normText(q['niche'], 100, 'niche') } : {}),
      ...(q['tag'] ? { tag: normText(q['tag'], 50, 'tag').toLowerCase() } : {}),
      ...(q['kind'] ? { kind: oneOf<IdeaKind>(q['kind'], IDEA_KINDS, 'kind') } : {}),
      ...(q['parent'] ? { parentId: normText(q['parent'], 64, 'parent') } : {}),
      ...(q['q'] ? { q: normText(q['q'], 200, 'q') } : {}),
      ...(q['liked'] === '1' ? { likedOnly: true } : {}),
    },
    limit,
    ideasDb.decodeCursor(q['cursor'] ?? null),
  );
  return c.json({ items: await hydrate(c, user.id, rows), next_cursor: nextCursor });
}

/**
 * Tạo ý tưởng — CHỈ ghi D1.
 *
 * Cố ý không nhúng và không đụng Vectorize ở đây. Lý do: nhúng tốn một lời gọi
 * Workers AI và vài trăm mili giây cho mỗi lần lưu, trong khi người dùng thường sửa
 * đi sửa lại vài lần trước khi ưng — mỗi lần như vậy đều đốt một lời gọi cho một bản
 * nháp sẽ bị ghi đè ngay sau đó. Nên việc index dồn lại và do người dùng bấm nút
 * "Đồng bộ index" khi họ thấy đã xong.
 *
 * Hàng vừa tạo tự động là "bẩn" (embedded_hash NULL), nên nút đồng bộ sẽ thấy nó.
 */
export async function createIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);
  const input = parseIdeaInput(body);
  const tags = parseTags(body['tags']);
  const hooks = parseHooks(body['hooks']);
  await checkParent(c, user.id, input);

  const hash = await contentHash(buildEmbedText({ ...input }, tags, hooks));
  const row = await ideasDb.create(c.env, user.id, input, hash);
  if (tags.length) await setIdeaTags(c.env, user.id, row.id, tags);
  if (hooks.length) await setIdeaHooks(c.env, user.id, row.id, hooks);

  return c.json({ idea: toDto(row, tags, hooks, 0, false), indexed: false }, 201);
}

/**
 * Tạo một ý tưởng biến thể TỪ một ý tưởng gốc.
 *
 * Biến thể kế thừa sẵn nguyên liệu của bản gốc — ý tưởng gốc, công thức prompt,
 * negative prompt, niche, nền tảng, tag — vì đó chính là điều làm nó là "biến thể"
 * chứ không phải một ý tưởng mới tinh. Body có thể ghi đè bất kỳ trường nào.
 *
 * Cố ý KHÔNG chép danh mục hook: hook là thứ người ta muốn thử KHÁC đi ở mỗi biến
 * thể, chép sang thì lần nào cũng phải xoá đi trước khi viết cái mới.
 */
export async function createVariant(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const parentId = pathParam(c, 'id');
  const parent = await ideasDb.getById(c.env, user.id, parentId);
  if (!parent) throw notFound('Không tìm thấy ý tưởng.');
  if (parent.kind !== 'origin') {
    throw badRequest(
      'invalid_parent',
      'Biến thể chỉ mọc ra từ ý tưởng gốc, không mọc tiếp từ một biến thể khác.',
    );
  }

  const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
  const parentTags = (await tagsForIdeas(c.env, [parentId])).get(parentId) ?? [];
  const seeded: Record<string, unknown> = {
    title: `${parent.title} — biến thể`,
    hook: parent.hook,
    script_outline: parent.script_outline,
    source_idea: parent.source_idea,
    prompt_recipe: parent.prompt_recipe,
    negative_prompt: parent.negative_prompt,
    platform: parent.platform,
    niche: parent.niche,
    status: 'idea',
    tags: parentTags,
    ...body,
    // Hai trường này KHÔNG cho body ghi đè: endpoint này chỉ làm đúng một việc.
    kind: 'variant',
    parent_id: parentId,
  };

  const input = parseIdeaInput(seeded);
  const tags = parseTags(seeded['tags']);
  const hooks = parseHooks(seeded['hooks']);
  const hash = await contentHash(buildEmbedText({ ...input }, tags, hooks));
  const row = await ideasDb.create(c.env, user.id, input, hash);
  if (tags.length) await setIdeaTags(c.env, user.id, row.id, tags);
  if (hooks.length) await setIdeaHooks(c.env, user.id, row.id, hooks);

  return c.json({ idea: toDto(row, tags, hooks, 0, false), indexed: false }, 201);
}

/** Danh mục ý tưởng biến thể của một ý tưởng gốc. */
export async function listVariants(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  // Đọc hàng cha trước để phân biệt "không có biến thể nào" với "ý tưởng không tồn
  // tại" — trả mảng rỗng cho cả hai là nói dối về trường hợp thứ hai.
  const parent = await ideasDb.getById(c.env, user.id, id);
  if (!parent) throw notFound('Không tìm thấy ý tưởng.');
  const limit = clampLimit(c.req.query('limit') ?? null, 50, 100);
  const rows = await ideasDb.listVariants(c.env, user.id, id, limit);
  return c.json({ items: await hydrate(c, user.id, rows) });
}

/**
 * Nút "đồng bộ index" của RIÊNG một ý tưởng.
 *
 * Có nút cho cả kho rồi mà vẫn cần nút riêng, vì hai thao tác khác nhau: nút cả kho
 * chạy theo lô và không nói được ý tưởng nào đã xong, còn ở đây người dùng vừa sửa
 * xong đúng một ý tưởng và muốn thấy riêng nó lên tìm kiếm ngay.
 */
export async function reindexIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  await enforce(
    c.env,
    `sync:user:${user.id}`,
    LIMITS.syncIdea,
    'Bạn đang đồng bộ quá nhanh. Vui lòng chờ một chút.',
  );

  const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
  const result = await syncIdea(c.env, user.id, id, body['force'] === true);
  if (!result) throw notFound('Không tìm thấy ý tưởng.');
  return c.json(result);
}

export async function getIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const row = await ideasDb.getById(c.env, user.id, pathParam(c, 'id'));
  if (!row) throw notFound('Không tìm thấy ý tưởng.');
  const [dto] = await hydrate(c, user.id, [row]);
  return c.json({ idea: dto });
}

export async function updateIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const existing = await ideasDb.getById(c.env, user.id, id);
  if (!existing) throw notFound('Không tìm thấy ý tưởng.');

  const body = await readJson(c);
  const input = parseIdeaInput(body, existing);
  await checkParent(c, user.id, input, id);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const [tagMap, hookMap] = await Promise.all([
    tagsForIdeas(c.env, [id]),
    hooksForIdeas(c.env, [id]),
  ]);
  const tags = has('tags') ? parseTags(body['tags']) : (tagMap.get(id) ?? []);
  const hooks = has('hooks') ? parseHooks(body['hooks']) : (hookMap.get(id) ?? []);

  const hash = await contentHash(buildEmbedText({ ...input }, tags, hooks));
  const ok = await ideasDb.update(c.env, user.id, id, input, hash);
  if (!ok) throw notFound('Không tìm thấy ý tưởng.');
  if (has('tags')) await setIdeaTags(c.env, user.id, id, tags);
  if (has('hooks')) await setIdeaHooks(c.env, user.id, id, hooks);

  const fresh = await ideasDb.getById(c.env, user.id, id);
  if (!fresh) throw notFound('Không tìm thấy ý tưởng.');

  // Như createIdea: chỉ ghi D1, không đụng Vectorize.
  //
  // Đổi mỗi trạng thái cũng phải được nút đồng bộ nhìn thấy, dù content_hash không
  // đổi — nếu không, metadata trên Vectorize mốc lại và /api/search?status=… lọc sai.
  // Cột indexed_meta_hash lo việc đó (xem migrations/0004), nên ở đây không cần
  // phân biệt loại thay đổi nào cả.
  const [dto] = await hydrate(c, user.id, [fresh]);
  if (!dto) throw notFound('Không tìm thấy ý tưởng.');
  return c.json({ idea: dto, indexed: dto.indexed });
}

export async function deleteIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');

  // Danh sách biến thể phải lấy TRƯỚC khi xoá. Khoá ngoại ON DELETE CASCADE xoá
  // chúng khỏi D1, nhưng Vectorize không biết gì về cascade — không gom id lại ở đây
  // thì vector của các biến thể ở lại vĩnh viễn và chiếm chỗ trong topK về sau.
  const doomed = [id, ...(await ideasDb.childIds(c.env, user.id, id))];

  const ok = await ideasDb.remove(c.env, user.id, id);
  if (!ok) throw notFound('Không tìm thấy ý tưởng.');

  // Xoá vector có thể hoãn: vector mồ côi không rò rỉ được vì tầng hydrate luôn
  // lọc theo user_id, nó chỉ chiếm một chỗ trong topK cho tới khi cron dọn.
  c.executionCtx.waitUntil(
    deleteIdeaVectors(c.env, doomed).catch(async (err) => {
      console.error('deleteIdeaVectors failed', doomed, err);
      await queueGc(c.env, doomed, user.id).catch(() => {});
    }),
  );
  c.executionCtx.waitUntil(invalidateTasteVector(c.env, user.id).catch(() => {}));
  return c.body(null, 204);
}

export async function likeIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  // Kiểm tra quyền sở hữu trước khi ghi, nếu không sẽ tạo được like trỏ tới
  // ý tưởng của người khác.
  const row = await ideasDb.getById(c.env, user.id, id);
  if (!row) throw notFound('Không tìm thấy ý tưởng.');
  await likesDb.like(c.env, user.id, id);
  await invalidateTasteVector(c.env, user.id);
  return c.body(null, 204);
}

export async function unlikeIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  await likesDb.unlike(c.env, user.id, pathParam(c, 'id'));
  await invalidateTasteVector(c.env, user.id);
  return c.body(null, 204);
}

export async function listTagsRoute(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const { listTags } = await import('../db/tags');
  return c.json({ tags: await listTags(c.env, user.id) });
}
