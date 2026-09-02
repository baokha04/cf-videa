import type { Ctx } from '../http/guard';
import { pathParam, readJson, requireUser } from '../http/guard';
import { notFound } from '../http/response';
import * as ideasDb from '../db/ideas';
import * as likesDb from '../db/likes';
import { setIdeaTags, tagsForIdeas } from '../db/tags';
import { buildEmbedText, contentHash } from '../vec/embeddings';
import { deleteIdeaVectors, metaSignature, queueGc } from '../vec/index';
import { invalidateTasteVector } from '../vec/profile';
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
    hook: has('hook') || !base ? normText(body['hook'], 500, 'hook') : base.hook,
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
  };
}

function toDto(row: IdeaRow, tags: string[], liked: boolean, score?: number): IdeaDto {
  return {
    id: row.id,
    title: row.title,
    hook: row.hook,
    script_outline: row.script_outline,
    platform: row.platform,
    niche: row.niche,
    status: row.status,
    visibility: row.visibility,
    tags,
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

/** Gắn tag + trạng thái like cho một loạt hàng bằng đúng hai truy vấn. */
export async function hydrate(
  c: Ctx,
  userId: string,
  rows: IdeaRow[],
  scores?: Map<string, number>,
): Promise<IdeaDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [tagMap, liked] = await Promise.all([
    tagsForIdeas(c.env, ids),
    likesDb.likedSet(c.env, userId, ids),
  ]);
  return rows.map((r) =>
    toDto(r, tagMap.get(r.id) ?? [], liked.has(r.id), scores?.get(r.id)),
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
 * "Đồng bộ index" khi họ thấy đã xong.
 *
 * Hàng vừa tạo tự động là "bẩn" (embedded_hash NULL), nên nút đồng bộ sẽ thấy nó.
 */
export async function createIdea(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);
  const input = parseIdeaInput(body);
  const tags = parseTags(body['tags']);

  const hash = await contentHash(buildEmbedText({ ...input }, tags));
  const row = await ideasDb.create(c.env, user.id, input, hash);
  if (tags.length) await setIdeaTags(c.env, user.id, row.id, tags);

  return c.json({ idea: toDto(row, tags, false), indexed: false }, 201);
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

  const hash = await contentHash(buildEmbedText({ ...input }, tags));
  const ok = await ideasDb.update(c.env, user.id, id, input, hash);
  if (!ok) throw notFound('Không tìm thấy ý tưởng.');
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
    await setIdeaTags(c.env, user.id, id, tags);
  }

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
  const ok = await ideasDb.remove(c.env, user.id, id);
  if (!ok) throw notFound('Không tìm thấy ý tưởng.');

  // Xoá vector có thể hoãn: vector mồ côi không rò rỉ được vì tầng hydrate luôn
  // lọc theo user_id, nó chỉ chiếm một chỗ trong topK cho tới khi cron dọn.
  c.executionCtx.waitUntil(
    deleteIdeaVectors(c.env, [id]).catch(async (err) => {
      console.error('deleteIdeaVectors failed', id, err);
      await queueGc(c.env, [id], user.id).catch(() => {});
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
