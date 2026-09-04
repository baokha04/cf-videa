import type { Ctx } from '../http/guard';
import { pathParam, readJson, requireUser } from '../http/guard';
import { badRequest, notFound } from '../http/response';
import * as ideasDb from '../db/ideas';
import * as likesDb from '../db/likes';
import * as variantsDb from '../db/variants';
import { setIdeaTags, tagsForIdeas } from '../db/tags';
import { ideaEmbedText } from '../content';
import { contentHash } from '../vec/embeddings';
import { deleteVectors, metaSignature, queueGc, vectorId } from '../vec/index';
import { indexOne } from '../vec/sync';
import { invalidateTasteVector } from '../vec/profile';
import { combine } from '../combine';
import {
  IDEA_STATUSES,
  PLATFORMS,
  type IdeaDto,
  type IdeaRow,
  type IdeaStatus,
  type Platform,
} from '../types';
import {
  clampLimit,
  normText,
  oneOf,
  parseTags,
  requiredText,
} from '../util/validate';

/**
 * Danh sách trắng các trường được ghi. user_id, id, created_at, content_hash,
 * embedded_hash KHÔNG nằm ở đây và không bao giờ đọc từ request — quyền sở hữu
 * luôn lấy từ phiên đăng nhập.
 */
function parseIdeaInput(body: Record<string, unknown>, base?: IdeaRow) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  return {
    title: has('title') || !base
      ? requiredText(body['title'], 200, 'title')
      : base.title,
    script_outline: has('script_outline') || !base
      ? normText(body['script_outline'], 8000, 'script_outline')
      : base.script_outline,
    platform: has('platform') || !base
      ? oneOf<Platform>(body['platform'], PLATFORMS, 'platform', 'tiktok')
      : base.platform,
    niche: has('niche') || !base ? normText(body['niche'], 100, 'niche') : base.niche,
    status: has('status') || !base
      ? oneOf<IdeaStatus>(body['status'], IDEA_STATUSES, 'status', 'idea')
      : base.status,
    negative_prompt: has('negative_prompt') || !base
      ? normText(body['negative_prompt'], 2000, 'negative_prompt')
      : base.negative_prompt,
  };
}

function toDto(
  row: IdeaRow,
  tags: string[],
  liked: boolean,
  variantCount: number,
  score?: number,
): IdeaDto {
  return {
    id: row.id,
    title: row.title,
    script_outline: row.script_outline,
    platform: row.platform,
    niche: row.niche,
    status: row.status,
    visibility: row.visibility,
    negative_prompt: row.negative_prompt,
    source_idea_id: row.source_idea_id,
    source_variant_id: row.source_variant_id,
    source_hook_id: row.source_hook_id,
    tags,
    liked,
    variant_count: variantCount,
    // "Đã index" nghĩa là vector trên Vectorize khớp CẢ nội dung LẪN metadata.
    indexed:
      row.embedded_hash === row.content_hash &&
      row.indexed_meta_hash === metaSignature(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(score !== undefined ? { score } : {}),
  };
}

/** Gắn tag + trạng thái like cho một loạt hàng bằng đúng hai truy vấn. */
export async function hydrate(
  c: Ctx,
  userId: string,
  rows: IdeaRow[],
  scores?: Map<string, number>,
): Promise<IdeaDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [tagMap, liked, variantCounts] = await Promise.all([
    tagsForIdeas(c.env, ids),
    likesDb.likedSet(c.env, userId, ids),
    variantsDb.countForIdeas(c.env, userId, ids),
  ]);
  return rows.map((r) =>
    toDto(r, tagMap.get(r.id) ?? [], liked.has(r.id), variantCounts.get(r.id) ?? 0,
          scores?.get(r.id)),
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
 * "Index" của chính ý tưởng đó khi họ thấy đã xong.
 *
 * Hàng vừa tạo tự động là "bẩn" (embedded_hash NULL), nên nó hiện ra là chưa index.
 */
export async function createIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);
  const input = parseIdeaInput(body);
  const tags = parseTags(body['tags']);

  // Ý tưởng mới chưa có biến thể nào.
  const hash = await contentHash(ideaEmbedText({ ...input }, tags, []));
  const row = await ideasDb.create(c.env, user.id, input, hash);
  if (tags.length) await setIdeaTags(c.env, user.id, row.id, tags);

  return c.json({ idea: toDto(row, tags, false, 0), indexed: false }, 201);
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
  const tagMap = await tagsForIdeas(c.env, [id]);
  const tags = Object.prototype.hasOwnProperty.call(body, 'tags')
    ? parseTags(body['tags'])
    : (tagMap.get(id) ?? []);

  // Phải gộp cả biến thể hiện có, nếu không mỗi lần sửa ý tưởng sẽ vô tình xoá chúng
  // khỏi văn bản nhúng và tìm kiếm ngữ nghĩa mất dấu các góc triển khai.
  const variants = await variantsDb.listForIdea(c.env, user.id, id);
  const hash = await contentHash(ideaEmbedText({ ...input }, tags, variants));
  const ok = await ideasDb.update(c.env, user.id, id, input, hash);
  if (!ok) throw notFound('Không tìm thấy ý tưởng.');
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
    await setIdeaTags(c.env, user.id, id, tags);
  }

  const fresh = await ideasDb.getById(c.env, user.id, id);
  if (!fresh) throw notFound('Không tìm thấy ý tưởng.');

  // Như createIdea: chỉ ghi D1, không đụng Vectorize.
  //
  // Đổi mỗi trạng thái cũng phải làm hàng bẩn trở lại, dù content_hash không
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
  const ok = await ideasDb.remove(c.env, user.id, id);
  if (!ok) throw notFound('Không tìm thấy ý tưởng.');

  // Xoá vector có thể hoãn: vector mồ côi không rò rỉ được vì tầng hydrate luôn
  // lọc theo user_id, nó chỉ chiếm một chỗ trong topK cho tới khi cron dọn.
  const vid = vectorId('idea', id);
  c.executionCtx.waitUntil(
    deleteVectors(c.env, [vid]).catch(async (err) => {
      console.error('deleteVectors failed', vid, err);
      await queueGc(c.env, [vid], user.id).catch(() => {});
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

/**
 * Danh sách id + tiêu đề mọi ý tưởng, cho ô chọn "ý tưởng gốc" ở kho biến thể.
 *
 * Trần 500: đủ rộng cho một người dùng thật, và khi chạm trần thì `truncated` bật lên
 * để giao diện nói thẳng thay vì lặng lẽ thiếu.
 */
const TITLES_LIMIT = 500;

export async function listIdeaTitles(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const { rows, truncated } = await ideasDb.listTitles(c.env, user.id, TITLES_LIMIT);
  return c.json({ ideas: rows, truncated, limit: TITLES_LIMIT });
}

export async function listTagsRoute(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const { listTags } = await import('../db/tags');
  return c.json({ tags: await listTags(c.env, user.id) });
}

/**
 * Index đúng ý tưởng này, ngay bây giờ — nút "Index" trên từng thẻ.
 *
 * POST chứ không GET: nó gọi Workers AI và ghi lên Vectorize. Xem quy tắc ở
 * src/http/guard.ts.
 *
 * Phản hồi có thể mang `duplicates`: những ý tưởng khác của CHÍNH bạn mà vector vừa
 * nhúng gần trùng. Đây là cảnh báo, không phải lỗi — việc index vẫn xong, và giữ hay
 * bỏ là quyết định của người dùng.
 */
export async function indexIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const result = await indexOne(c.env, user.id, 'idea', id);
  if (!result) throw notFound('Không tìm thấy ý tưởng.');

  const fresh = await ideasDb.getById(c.env, user.id, id);
  if (!fresh) throw notFound('Không tìm thấy ý tưởng.');
  const [dto] = await hydrate(c, user.id, [fresh]);
  return c.json({ idea: dto, indexed: result.indexed, duplicates: result.duplicates });
}

/**
 * Kết hợp gốc + biến thể + hook thành một ý tưởng gốc MỚI.
 *
 * POST vì nó ghi dữ liệu — GET không được phép, xem src/http/guard.ts. Toàn bộ nghiệp
 * vụ nằm ở src/combine.ts; ở đây chỉ đọc request và dịch mã lỗi sang HTTP.
 */
export async function combineIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);

  const hookRaw = body['hook_id'];
  const result = await combine(c.env, user.id, {
    ideaId: requiredText(body['idea_id'], 100, 'idea_id'),
    variantId: requiredText(body['variant_id'], 100, 'variant_id'),
    hookId: hookRaw === null || hookRaw === undefined || hookRaw === ''
      ? null
      : requiredText(hookRaw, 100, 'hook_id'),
    ...(body['title'] === undefined ? {} : { title: normText(body['title'], 200, 'title') }),
  });

  if (!result.ok) {
    if (result.error === 'variant_mismatch') {
      throw badRequest('variant_mismatch', 'Biến thể này không thuộc ý tưởng gốc đã chọn.');
    }
    throw notFound({
      idea_not_found: 'Không tìm thấy ý tưởng gốc.',
      variant_not_found: 'Không tìm thấy biến thể.',
      hook_not_found: 'Không tìm thấy hook.',
    }[result.error]);
  }

  // Hàng mới sinh ra đã "bẩn" (embedded_hash NULL) nên nút Index của nó sáng ngay.
  return c.json(
    { idea: toDto(result.row, result.tags, false, 0), prompt: result.prompt, indexed: false },
    201,
  );
}
