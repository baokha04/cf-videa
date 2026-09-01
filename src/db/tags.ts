import type { Env } from '../types';
import { newId, now } from '../util/id';

/**
 * Tag thuộc về từng user (UNIQUE(user_id, name)) nên không có rò rỉ từ vựng
 * giữa các tài khoản.
 */

/** Bảo đảm các tag tồn tại và trả về id của chúng. Dùng batch vì D1 không có transaction. */
export async function ensureTags(env: Env, userId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const t = now();
  const inserts = names.map((name) =>
    env.DB.prepare(
      `INSERT INTO tags (id, user_id, name, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, name) DO NOTHING`,
    ).bind(newId(), userId, name, t),
  );
  await env.DB.batch(inserts);

  const ph = names.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id FROM tags WHERE user_id = ?1 AND name IN (${ph})`,
  )
    .bind(userId, ...names)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Thay toàn bộ tag của một ý tưởng. Gọi sau khi đã xác thực quyền sở hữu. */
export async function setIdeaTags(
  env: Env,
  userId: string,
  ideaId: string,
  names: string[],
): Promise<void> {
  const tagIds = await ensureTags(env, userId, names);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM idea_tags WHERE idea_id = ?1`).bind(ideaId),
  ];
  for (const tagId of tagIds) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO idea_tags (idea_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING`,
      ).bind(ideaId, tagId),
    );
  }
  await env.DB.batch(stmts);
}

/**
 * Hàm này KHÔNG nhận userId, vì nó cũng phục vụ đối soát toàn hệ thống (chạy trên
 * ý tưởng của nhiều người cùng lúc). Thay vào đó, phép join `i.user_id = t.user_id`
 * ràng buộc ngay trong câu lệnh rằng tag phải thuộc cùng chủ sở hữu với ý tưởng —
 * nên không thể rò rỉ tag chéo tài khoản dù người gọi có truyền id gì đi nữa.
 * Bảo đảm bằng cấu trúc, không phải bằng quy ước gọi hàm.
 */
export async function tagsForIdeas(
  env: Env,
  ideaIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ideaIds.length === 0) return map;
  const ph = ideaIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT it.idea_id, t.name
       FROM idea_tags it
       JOIN tags  t ON t.id = it.tag_id
       JOIN ideas i ON i.id = it.idea_id AND i.user_id = t.user_id
      WHERE it.idea_id IN (${ph})
      ORDER BY t.name`,
  )
    .bind(...ideaIds)
    .all<{ idea_id: string; name: string }>();
  for (const r of results) {
    const list = map.get(r.idea_id) ?? [];
    list.push(r.name);
    map.set(r.idea_id, list);
  }
  return map;
}

export async function listTags(
  env: Env,
  userId: string,
): Promise<Array<{ id: string; name: string; count: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, COUNT(it.idea_id) AS count
       FROM tags t
       LEFT JOIN idea_tags it ON it.tag_id = t.id
      WHERE t.user_id = ?1
      GROUP BY t.id, t.name
      ORDER BY count DESC, t.name ASC`,
  )
    .bind(userId)
    .all<{ id: string; name: string; count: number }>();
  return results;
}
