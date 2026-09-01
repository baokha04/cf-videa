import type { Env, IdeaRow } from '../types';
import { now } from '../util/id';
import { DIMENSIONS } from './embeddings';

/**
 * CÁCH LY ĐA NGƯỜI DÙNG: dùng metadata filter theo user_id, KHÔNG dùng
 * namespace-per-user. Lý do quyết định: mỗi index chỉ chứa được 1.000 namespace,
 * nên namespace-per-user biến 1.000 người dùng thành trần kiến trúc. Metadata
 * filter không giới hạn số giá trị và kết hợp được nhiều điều kiện trong một truy vấn.
 *
 * CHÚ Ý KHI VẬN HÀNH: metadata index phải được tạo TRƯỚC lần upsert đầu tiên.
 * Vector ghi trước khi index tồn tại sẽ KHÔNG nằm trong index đó, và cách sửa duy
 * nhất là upsert lại toàn bộ. Xem README, phần "Khởi tạo hạ tầng".
 */

export interface IdeaVectorMeta extends Record<string, VectorizeVectorMetadataValue> {
  user_id: string;
  status: string;
  platform: string;
  visibility: string;
  updated_at: number;
}

export function metaFor(idea: IdeaRow): IdeaVectorMeta {
  return {
    user_id: idea.user_id,
    status: idea.status,
    platform: idea.platform,
    visibility: idea.visibility,
    updated_at: idea.updated_at,
  };
}

export async function upsertIdeas(
  env: Env,
  items: Array<{ idea: IdeaRow; values: number[] }>,
): Promise<void> {
  if (items.length === 0) return;
  for (const { values } of items) {
    if (values.length !== DIMENSIONS) {
      throw new Error(`Vector có ${values.length} chiều, index cần ${DIMENSIONS}`);
    }
  }
  await env.VEC.upsert(
    items.map(({ idea, values }) => ({ id: idea.id, values, metadata: metaFor(idea) })),
  );
}

export async function deleteIdeaVectors(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await env.VEC.deleteByIds(ids);
}

/** Xoá vector thất bại → xếp hàng để /api/admin/cron rút dần. */
export async function queueGc(env: Env, ids: string[], userId: string): Promise<void> {
  if (ids.length === 0) return;
  const t = now();
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        `INSERT INTO vector_gc (vector_id, user_id, queued_at, attempts) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(vector_id) DO NOTHING`,
      ).bind(id, userId, t),
    ),
  );
}

export interface QueryOpts {
  userId: string;
  topK: number;
  status?: string[];
  platform?: string;
}

export interface Match {
  id: string;
  score: number;
}

/**
 * topK tối đa là 100, nhưng tụt xuống 50 khi bật returnValues hoặc
 * returnMetadata:'all'. Ở đây không cần cả hai — nội dung thật lấy từ D1 — nên
 * cứ để 'none' và giữ khoảng cách an toàn với trần.
 */
export async function queryIdeas(
  env: Env,
  vector: number[],
  opts: QueryOpts,
): Promise<Match[]> {
  const filter: Record<string, unknown> = { user_id: { $eq: opts.userId } };
  if (opts.status && opts.status.length > 0) {
    filter['status'] = opts.status.length === 1 ? { $eq: opts.status[0] } : { $in: opts.status };
  }
  if (opts.platform) filter['platform'] = { $eq: opts.platform };

  const res = await env.VEC.query(vector, {
    topK: Math.min(opts.topK, 100),
    returnMetadata: 'none',
    returnValues: false,
    filter: filter as VectorizeVectorMetadataFilter,
  });
  return res.matches.map((m) => ({ id: m.id, score: m.score }));
}

/** Lấy lại vector đã lưu — dùng cho "ý tưởng tương tự" và cho vector sở thích,
 *  rẻ hơn nhiều so với embed lại. */
export async function getVectors(env: Env, ids: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (ids.length === 0) return out;
  const rows = await env.VEC.getByIds(ids);
  for (const r of rows) {
    if (Array.isArray(r.values) && r.values.length === DIMENSIONS) {
      out.set(r.id, r.values as number[]);
    }
  }
  return out;
}
