import type { Env } from '../types';
import { now } from '../util/id';

/**
 * Like là nguồn duy nhất cho "vector sở thích" ở src/vec/profile.ts.
 * Cả hai chiều đều idempotent: bấm hai lần không gây lỗi.
 */

export async function like(env: Env, userId: string, ideaId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO idea_likes (user_id, idea_id, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT DO NOTHING`,
  )
    .bind(userId, ideaId, now())
    .run();
}

export async function unlike(env: Env, userId: string, ideaId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM idea_likes WHERE user_id = ?1 AND idea_id = ?2`)
    .bind(userId, ideaId)
    .run();
}

export async function likedIds(env: Env, userId: string, limit = 50): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT idea_id FROM idea_likes WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<{ idea_id: string }>();
  return results.map((r) => r.idea_id);
}

export async function likedSet(
  env: Env,
  userId: string,
  ideaIds: string[],
): Promise<Set<string>> {
  if (ideaIds.length === 0) return new Set();
  const ph = ideaIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT idea_id FROM idea_likes WHERE user_id = ?1 AND idea_id IN (${ph})`,
  )
    .bind(userId, ...ideaIds)
    .all<{ idea_id: string }>();
  return new Set(results.map((r) => r.idea_id));
}
