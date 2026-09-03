import type { Env } from '../types';
import { newId, now } from '../util/id';

/**
 * Biến thể của một ý tưởng gốc: cùng chủ đề, khác góc triển khai.
 *
 * Biến thể KHÔNG giữ hook. Hook được chọn lúc sinh prompt, nên n biến thể × m hook
 * cho ra n×m prompt mà không phải nhân bản gì.
 */

export interface VariantRow {
  id: string;
  idea_id: string;
  user_id: string;
  title: string;
  angle: string;
  /** Để trống thì prompt dùng dàn ý của ý tưởng gốc. Có thì ghi đè. */
  script_outline: string;
  sort_order: number;
  content_hash: string;
  embedded_hash: string | null;
  indexed_meta_hash: string | null;
  embedding_model: string | null;
  embedded_at: number | null;
  embed_attempts: number;
  created_at: number;
  updated_at: number;
}

/**
 * Điều kiện "biến thể cần đồng bộ lại". Phải khớp CHÍNH XÁC mệnh đề WHERE của
 * idx_variants_dirty trong migrations/0007.
 *
 * idea_id không đổi được nên vế metadata trên thực tế không bao giờ khớp sai. Vẫn giữ
 * cho đối xứng với hai bảng kia: thêm một trường vào metadata mà quên vế này thì lại
 * dính đúng lỗi im lặng mà migrations/0004 đã phải vá.
 */
export const VARIANT_DIRTY_SQL = `(
  embedded_hash IS NULL
  OR embedded_hash <> content_hash
  OR indexed_meta_hash IS NULL
  OR indexed_meta_hash <> 'variant' || '|' || idea_id
)`;

/** Bản TS của biểu thức SQL ngay trên. Hai chỗ này phải cho cùng một chuỗi. */
export function variantMetaSignature(v: Pick<VariantRow, 'idea_id'>): string {
  return `variant|${v.idea_id}`;
}

export function variantNeedsEmbedding(row: VariantRow): boolean {
  return row.embedded_hash === null || row.embedded_hash !== row.content_hash;
}

export interface VariantInput {
  title: string;
  angle: string;
  script_outline: string;
  sort_order: number;
}

export async function listForIdea(
  env: Env,
  userId: string,
  ideaId: string,
): Promise<VariantRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM idea_variants WHERE user_id = ?1 AND idea_id = ?2
      ORDER BY sort_order, created_at`,
  )
    .bind(userId, ideaId)
    .all<VariantRow>();
  return results;
}

/** Gom biến thể cho nhiều ý tưởng bằng một truy vấn — dùng khi dựng văn bản nhúng. */
export async function listForIdeas(
  env: Env,
  ideaIds: string[],
): Promise<Map<string, VariantRow[]>> {
  const map = new Map<string, VariantRow[]>();
  if (ideaIds.length === 0) return map;
  const ph = ideaIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT * FROM idea_variants WHERE idea_id IN (${ph}) ORDER BY sort_order, created_at`,
  )
    .bind(...ideaIds)
    .all<VariantRow>();
  for (const r of results) {
    const list = map.get(r.idea_id) ?? [];
    list.push(r);
    map.set(r.idea_id, list);
  }
  return map;
}

export async function getById(
  env: Env,
  userId: string,
  id: string,
): Promise<VariantRow | null> {
  return env.DB.prepare(`SELECT * FROM idea_variants WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<VariantRow>();
}

/**
 * Trả về null nếu ý tưởng gốc không tồn tại hoặc không thuộc người dùng này.
 * Kiểm tra ở đây chứ không dựa vào khoá ngoại: khoá ngoại chỉ bảo đảm ý tưởng TỒN
 * TẠI, không bảo đảm nó là của ai.
 */
export async function create(
  env: Env,
  userId: string,
  ideaId: string,
  input: VariantInput,
  contentHash: string,
): Promise<VariantRow | null> {
  const owns = await env.DB.prepare(`SELECT id FROM ideas WHERE id = ?1 AND user_id = ?2`)
    .bind(ideaId, userId)
    .first();
  if (!owns) return null;

  const t = now();
  const row: VariantRow = {
    id: newId(),
    idea_id: ideaId,
    user_id: userId,
    ...input,
    content_hash: contentHash,
    embedded_hash: null,
    indexed_meta_hash: null,
    embedding_model: null,
    embedded_at: null,
    embed_attempts: 0,
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO idea_variants (id, idea_id, user_id, title, angle, script_outline,
                                sort_order, content_hash, embed_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)`,
  )
    .bind(row.id, ideaId, userId, input.title, input.angle, input.script_outline,
          input.sort_order, contentHash, t)
    .run();
  return row;
}

export async function update(
  env: Env,
  userId: string,
  id: string,
  input: VariantInput,
  contentHash: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE idea_variants
        SET title = ?3, angle = ?4, script_outline = ?5, sort_order = ?6,
            content_hash = ?7, updated_at = ?8
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId, input.title, input.angle, input.script_outline, input.sort_order,
          contentHash, now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// --- Kế toán đồng bộ Vectorize ----------------------------------------------
// Đối xứng hoàn toàn với src/db/ideas.ts.

export async function markEmbedded(
  env: Env,
  id: string,
  contentHash: string,
  model: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE idea_variants
        SET embedded_hash = ?2, embedding_model = ?3, embedded_at = ?4, embed_attempts = 0,
            indexed_meta_hash = 'variant' || '|' || idea_id
      WHERE id = ?1 AND content_hash = ?2`,
  )
    .bind(id, contentHash, model, now())
    .run();
}

export async function markMetaSynced(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE idea_variants
        SET indexed_meta_hash = 'variant' || '|' || idea_id, embed_attempts = 0
      WHERE id = ?1`,
  )
    .bind(id)
    .run();
}

export async function markEmbedFailed(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE idea_variants SET embed_attempts = embed_attempts + 1 WHERE id = ?1`,
  )
    .bind(id)
    .run();
}

export async function listDirty(env: Env, limit: number, userId?: string): Promise<VariantRow[]> {
  const sql = userId
    ? `SELECT * FROM idea_variants WHERE ${VARIANT_DIRTY_SQL} AND user_id = ?2
        ORDER BY updated_at LIMIT ?1`
    : `SELECT * FROM idea_variants WHERE ${VARIANT_DIRTY_SQL} ORDER BY updated_at LIMIT ?1`;
  const stmt = userId ? env.DB.prepare(sql).bind(limit, userId) : env.DB.prepare(sql).bind(limit);
  const { results } = await stmt.all<VariantRow>();
  return results;
}

export async function countDirty(env: Env, userId?: string): Promise<number> {
  const sql = userId
    ? `SELECT COUNT(*) AS n FROM idea_variants WHERE ${VARIANT_DIRTY_SQL} AND user_id = ?1`
    : `SELECT COUNT(*) AS n FROM idea_variants WHERE ${VARIANT_DIRTY_SQL}`;
  const stmt = userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql);
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

export async function markAllDirty(env: Env, userId?: string): Promise<number> {
  const sql = userId
    ? `UPDATE idea_variants SET embedded_hash = NULL, indexed_meta_hash = NULL WHERE user_id = ?1`
    : `UPDATE idea_variants SET embedded_hash = NULL, indexed_meta_hash = NULL`;
  const stmt = userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql);
  const res = await stmt.run();
  return res.meta.changes ?? 0;
}

export async function remove(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM idea_variants WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function countForIdeas(
  env: Env,
  userId: string,
  ideaIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ideaIds.length === 0) return map;
  const ph = ideaIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT idea_id, COUNT(*) AS n FROM idea_variants
      WHERE user_id = ?1 AND idea_id IN (${ph}) GROUP BY idea_id`,
  )
    .bind(userId, ...ideaIds)
    .all<{ idea_id: string; n: number }>();
  for (const r of results) map.set(r.idea_id, r.n);
  return map;
}
