import type { Env, HookRow } from '../types';
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
 *
 * QUY TẮC KHÔNG NGOẠI LỆ, giống hệt bảng ideas: mọi hàm sửa đổi đều nhận userId và
 * ràng buộc nó NGAY TRONG câu lệnh. Không hàm nào tin rằng người gọi đã kiểm tra
 * quyền sở hữu, và không khớp thì trả về false/null để route hoá thành 404.
 *
 * LƯU Ý VỚI MỌI THAY ĐỔI Ở ĐÂY: hook nằm trong văn bản đem đi nhúng, nên thêm, xoá
 * hay sửa một hook đều làm nội dung của ý tưởng cha đổi theo. Route phải gọi
 * rehashIdea() (src/vec/sync.ts) sau mỗi thao tác, nếu không vector trên Vectorize
 * sẽ mốc lại mà không có dấu hiệu gì.
 */

/** Đủ để một trang quản lý hiển thị và sắp xếp: có id nên sửa/xoá được từng dòng. */
export async function listHooks(
  env: Env,
  userId: string,
  ideaId: string,
): Promise<HookRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, text, position FROM idea_hooks
      WHERE idea_id = ?1 AND user_id = ?2
      ORDER BY position, rowid`,
  )
    .bind(ideaId, userId)
    .all<HookRow>();
  return results;
}

export async function countHooks(env: Env, userId: string, ideaId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM idea_hooks WHERE idea_id = ?1 AND user_id = ?2`,
  )
    .bind(ideaId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Thêm một hook vào cuối danh mục.
 *
 * `position` lấy từ MAX hiện có + 1 tính THẲNG TRONG câu lệnh, không đọc-rồi-ghi:
 * hai request thêm cùng lúc mà tính ở tầng ứng dụng thì cả hai nhận cùng một số.
 * Mệnh đề EXISTS là chốt quyền sở hữu — ý tưởng không phải của user thì không chèn
 * được hàng nào và hàm trả null.
 */
export async function addHook(
  env: Env,
  userId: string,
  ideaId: string,
  text: string,
): Promise<HookRow | null> {
  const row = await env.DB.prepare(
    `INSERT INTO idea_hooks (id, idea_id, user_id, text, position, created_at)
     SELECT ?1, ?2, ?3, ?4,
            (SELECT COALESCE(MAX(h.position), -1) + 1 FROM idea_hooks h WHERE h.idea_id = ?2),
            ?5
      WHERE EXISTS (SELECT 1 FROM ideas WHERE id = ?2 AND user_id = ?3)
     RETURNING id, text, position`,
  )
    .bind(newId(), ideaId, userId, text, now())
    .first<HookRow>();
  return row;
}

/** Sửa nội dung một hook. false = không có hàng nào khớp (không tồn tại hoặc của người khác). */
export async function updateHook(
  env: Env,
  userId: string,
  ideaId: string,
  hookId: string,
  text: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE idea_hooks SET text = ?4 WHERE id = ?1 AND idea_id = ?2 AND user_id = ?3`,
  )
    .bind(hookId, ideaId, userId, text)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function removeHook(
  env: Env,
  userId: string,
  ideaId: string,
  hookId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM idea_hooks WHERE id = ?1 AND idea_id = ?2 AND user_id = ?3`,
  )
    .bind(hookId, ideaId, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Đổi chỗ một hook lên trên hoặc xuống dưới một bậc.
 *
 * Cách làm: đọc cả danh mục theo đúng thứ tự đang hiển thị, hoán vị trong bộ nhớ,
 * rồi ghi lại TOÀN BỘ position bằng một batch. Dài dòng hơn việc hoán đổi hai hàng,
 * nhưng nó cũng chuẩn hoá luôn các position bị trùng hoặc thủng lỗ do lịch sử để
 * lại — mà hoán đổi hai hàng thì không sửa được, thậm chí còn kẹt vĩnh viễn khi hai
 * hàng cạnh nhau có cùng position.
 *
 * Trả false nếu hook không thuộc user này, hoặc nó đã ở đầu/cuối danh mục.
 */
export async function moveHook(
  env: Env,
  userId: string,
  ideaId: string,
  hookId: string,
  dir: 'up' | 'down',
): Promise<boolean> {
  const rows = await listHooks(env, userId, ideaId);
  const i = rows.findIndex((r) => r.id === hookId);
  if (i < 0) return false;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= rows.length) return false;

  const a = rows[i];
  const b = rows[j];
  if (!a || !b) return false;
  rows[i] = b;
  rows[j] = a;

  await env.DB.batch(
    rows.map((r, k) =>
      env.DB.prepare(
        `UPDATE idea_hooks SET position = ?4 WHERE id = ?1 AND idea_id = ?2 AND user_id = ?3`,
      ).bind(r.id, ideaId, userId, k),
    ),
  );
  return true;
}

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
