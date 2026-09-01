import type { Ctx } from '../http/guard';
import { pathParam, requireUser } from '../http/guard';
import { badRequest, notFound } from '../http/response';
import { enforce, LIMITS } from '../auth/ratelimit';
import * as ideasDb from '../db/ideas';
import { embedOne } from '../vec/embeddings';
import { getVectors, queryIdeas } from '../vec/index';
import { hydrate } from './ideas';
import { clampLimit, normText, oneOf } from '../util/validate';
import { IDEA_STATUSES, PLATFORMS, type IdeaStatus, type Platform } from '../types';

const MAX_QUERY_CHARS = 512;

/**
 * Tìm kiếm ngữ nghĩa: nhúng câu hỏi → Vectorize lọc theo user_id → nạp lại từ D1.
 *
 * Bước nạp lại từ D1 CHÍNH LÀ bảo đảm cách ly. Kể cả nếu metadata filter bị bỏ sót
 * vì một lỗi về sau, hoặc còn sót vector của tài khoản đã xoá, câu lệnh hydrate vẫn
 * lọc theo user_id và âm thầm bỏ qua. Vectorize chỉ là gợi ý về thứ hạng; D1 mới là
 * nơi quyết định ai sở hữu cái gì.
 */
export async function search(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const raw = c.req.query('q') ?? '';
  const q = normText(raw, MAX_QUERY_CHARS, 'q');
  if (!q) throw badRequest('missing_query', 'Vui lòng nhập nội dung cần tìm.');

  // Giới hạn này bảo vệ cả hạn mức Workers AI, không chỉ chống lạm dụng.
  await enforce(c.env, `search:user:${user.id}`, LIMITS.searchUser,
    'Bạn đang tìm kiếm quá nhanh. Vui lòng chờ một chút.');

  const limit = clampLimit(c.req.query('limit') ?? null);
  const statusQ = c.req.query('status');
  const platformQ = c.req.query('platform');

  let matches;
  try {
    const vector = await embedOne(c.env, q);
    matches = await queryIdeas(c.env, vector, {
      userId: user.id,
      topK: Math.min(limit * 2, 100),
      ...(statusQ ? { status: [oneOf<IdeaStatus>(statusQ, IDEA_STATUSES, 'status')] } : {}),
      ...(platformQ ? { platform: oneOf<Platform>(platformQ, PLATFORMS, 'platform') } : {}),
    });
  } catch (err) {
    // Workers AI hoặc Vectorize hỏng thì vẫn phải tìm được — lùi về LIKE trên D1.
    console.error('semantic search failed, falling back to keyword', err);
    const { rows } = await ideasDb.list(c.env, user.id, { q }, limit, null);
    return c.json({ items: await hydrate(c, user.id, rows), mode: 'fallback' });
  }

  const ids = matches.map((m) => m.id);
  const rowMap = await ideasDb.getManyByIds(c.env, user.id, ids);
  const scores = new Map(matches.map((m) => [m.id, m.score]));

  // Giữ nguyên thứ tự theo điểm của Vectorize, bỏ id nào D1 không trả về.
  const rows = ids
    .map((id) => rowMap.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .slice(0, limit);

  return c.json({ items: await hydrate(c, user.id, rows, scores), mode: 'vector' });
}

/** Ý tưởng tương tự: dùng lại vector đã lưu thay vì nhúng lại — rẻ hơn hẳn. */
export async function similar(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const row = await ideasDb.getById(c.env, user.id, id);
  if (!row) throw notFound('Không tìm thấy ý tưởng.');

  const limit = clampLimit(c.req.query('limit') ?? null, 10, 50);
  let vector: number[] | undefined;
  try {
    vector = (await getVectors(c.env, [id])).get(id);
  } catch (err) {
    console.error('similar: không lấy được vector', err);
    vector = undefined;
  }
  if (!vector) {
    return c.json({
      items: [],
      mode: 'not_indexed',
      message: 'Ý tưởng này chưa được index. Hãy thử đồng bộ lại rồi quay lại sau ít phút.',
    });
  }

  let matches;
  try {
    matches = await queryIdeas(c.env, vector, {
      userId: user.id,
      topK: Math.min(limit + 1, 100),
    });
  } catch (err) {
    console.error('similar: truy vấn Vectorize thất bại', err);
    return c.json({
      items: [],
      mode: 'unavailable',
      message: 'Tính năng tìm ý tưởng tương tự tạm thời không dùng được.',
    });
  }
  const ids = matches.map((m) => m.id).filter((x) => x !== id);
  const rowMap = await ideasDb.getManyByIds(c.env, user.id, ids);
  const scores = new Map(matches.map((m) => [m.id, m.score]));
  const rows = ids
    .map((x) => rowMap.get(x))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .slice(0, limit);

  return c.json({ items: await hydrate(c, user.id, rows, scores), mode: 'vector' });
}
