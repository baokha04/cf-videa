import type { Env } from '../types';
import { newId, now } from '../util/id';

/**
 * Danh mục video hook: nhiều cách mở đầu cho cùng một ý tưởng.
 *
 * Cột `ideas.hook` vẫn là hook ĐANG DÙNG (thứ hiện trên thẻ ý tưởng và trong tìm
 * kiếm từ khoá); bảng này giữ những cách mở đầu khác đã nghĩ ra, để thử qua thử lại
 * mà không mất bản cũ.
 *
 * Thứ tự do người dùng quyết định và được giữ nguyên qua cột `position`, chứ không
 * sắp theo bảng chữ cái như tag: hook đầu danh sách thường là hook đang ưng nhất.
 */

/** Thay toàn bộ danh mục hook của một ý tưởng. Gọi sau khi đã xác thực quyền sở hữu. */
export async function setIdeaHooks(
  env: Env,
  userId: string,
  ideaId: string,
  texts: string[],
): Promise<void> {
  const t = now();
  const stmts: D1PreparedStatement[] = [
    // Ràng buộc user_id ngay trong lệnh xoá: kể cả người gọi truyền nhầm ideaId của
    // người khác thì cũng không xoá được gì của họ.
    env.DB.prepare(`DELETE FROM idea_hooks WHERE idea_id = ?1 AND user_id = ?2`).bind(
      ideaId,
      userId,
    ),
  ];
  texts.forEach((text, i) => {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO idea_hooks (id, idea_id, user_id, text, position, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE EXISTS (SELECT 1 FROM ideas WHERE id = ?2 AND user_id = ?3)`,
      ).bind(newId(), ideaId, userId, text, i, t),
    );
  });
  await env.DB.batch(stmts);
}

/**
 * Hàm này KHÔNG nhận userId, vì nó cũng phục vụ đối soát toàn hệ thống (chạy trên ý
 * tưởng của nhiều người cùng lúc) — giống hệt tagsForIdeas. Phép join
 * `i.user_id = h.user_id` ràng buộc ngay trong câu lệnh rằng hook phải thuộc cùng
 * chủ sở hữu với ý tưởng, nên không rò rỉ chéo tài khoản dù truyền id gì đi nữa.
 */
export async function hooksForIdeas(
  env: Env,
  ideaIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ideaIds.length === 0) return map;
  const ph = ideaIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT h.idea_id, h.text
       FROM idea_hooks h
       JOIN ideas i ON i.id = h.idea_id AND i.user_id = h.user_id
      WHERE h.idea_id IN (${ph})
      ORDER BY h.position, h.rowid`,
  )
    .bind(...ideaIds)
    .all<{ idea_id: string; text: string }>();
  for (const r of results) {
    const list = map.get(r.idea_id) ?? [];
    list.push(r.text);
    map.set(r.idea_id, list);
  }
  return map;
}
