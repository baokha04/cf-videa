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
  created_at: number;
  updated_at: number;
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
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO idea_variants (id, idea_id, user_id, title, angle, script_outline,
                                sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  )
    .bind(row.id, ideaId, userId, input.title, input.angle, input.script_outline,
          input.sort_order, t)
    .run();
  return row;
}

export async function update(
  env: Env,
  userId: string,
  id: string,
  input: VariantInput,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE idea_variants
        SET title = ?3, angle = ?4, script_outline = ?5, sort_order = ?6, updated_at = ?7
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId, input.title, input.angle, input.script_outline, input.sort_order, now())
    .run();
  return (res.meta.changes ?? 0) > 0;
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
