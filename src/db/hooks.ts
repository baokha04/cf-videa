import type { Env } from '../types';
import { newId, now } from '../util/id';

/**
 * Thư viện hook, có nhóm danh mục.
 *
 * Cùng quy tắc như src/db/ideas.ts: mọi hàm nhận userId làm tham số đầu tiên và ràng
 * buộc user_id NGAY TRONG câu lệnh. Không khớp thì coi như không tồn tại.
 */

export interface HookCategoryRow {
  id: string;
  user_id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

export interface HookRow {
  id: string;
  user_id: string;
  category_id: string | null;
  text: string;
  note: string;
  created_at: number;
  updated_at: number;
}

// --- Danh mục ---------------------------------------------------------------

export async function listCategories(env: Env, userId: string): Promise<HookCategoryRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM hook_categories WHERE user_id = ?1 ORDER BY sort_order, name`,
  )
    .bind(userId)
    .all<HookCategoryRow>();
  return results;
}

/** Trả về null khi trùng tên — bắt lỗi UNIQUE thay vì kiểm tra trước, tránh đua. */
export async function createCategory(
  env: Env,
  userId: string,
  name: string,
  sortOrder: number,
): Promise<HookCategoryRow | null> {
  const row: HookCategoryRow = {
    id: newId(),
    user_id: userId,
    name,
    sort_order: sortOrder,
    created_at: now(),
  };
  try {
    await env.DB.prepare(
      `INSERT INTO hook_categories (id, user_id, name, sort_order, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(row.id, userId, name, sortOrder, row.created_at)
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) return null;
    throw err;
  }
  return row;
}

export async function renameCategory(
  env: Env,
  userId: string,
  id: string,
  name: string,
  sortOrder: number,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE hook_categories SET name = ?3, sort_order = ?4 WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId, name, sortOrder)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Hook trong danh mục KHÔNG bị xoá theo — chúng rơi về nhóm chưa phân loại. */
export async function deleteCategory(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM hook_categories WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// --- Hook -------------------------------------------------------------------

export async function listHooks(
  env: Env,
  userId: string,
  categoryId?: string | null,
): Promise<HookRow[]> {
  // categoryId === null nghĩa là "chỉ nhóm chưa phân loại", khác hẳn với undefined
  // nghĩa là "tất cả". Hai trường hợp này rất dễ bị gộp nhầm thành một.
  if (categoryId === undefined) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM hooks WHERE user_id = ?1 ORDER BY updated_at DESC`,
    )
      .bind(userId)
      .all<HookRow>();
    return results;
  }
  const sql = categoryId === null
    ? `SELECT * FROM hooks WHERE user_id = ?1 AND category_id IS NULL ORDER BY updated_at DESC`
    : `SELECT * FROM hooks WHERE user_id = ?1 AND category_id = ?2 ORDER BY updated_at DESC`;
  const stmt = categoryId === null
    ? env.DB.prepare(sql).bind(userId)
    : env.DB.prepare(sql).bind(userId, categoryId);
  const { results } = await stmt.all<HookRow>();
  return results;
}

export async function getHook(env: Env, userId: string, id: string): Promise<HookRow | null> {
  return env.DB.prepare(`SELECT * FROM hooks WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<HookRow>();
}

/**
 * Danh mục phải thuộc cùng người dùng. Kiểm tra ở đây chứ không dựa vào khoá ngoại:
 * khoá ngoại chỉ bảo đảm danh mục TỒN TẠI, không bảo đảm nó là của ai — nếu không
 * kiểm thì gán được hook của mình vào danh mục của người khác.
 */
async function assertCategoryOwned(
  env: Env,
  userId: string,
  categoryId: string | null,
): Promise<boolean> {
  if (categoryId === null) return true;
  const row = await env.DB.prepare(
    `SELECT id FROM hook_categories WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(categoryId, userId)
    .first();
  return row !== null;
}

export async function createHook(
  env: Env,
  userId: string,
  input: { text: string; note: string; category_id: string | null },
): Promise<HookRow | null> {
  if (!(await assertCategoryOwned(env, userId, input.category_id))) return null;
  const t = now();
  const row: HookRow = {
    id: newId(),
    user_id: userId,
    category_id: input.category_id,
    text: input.text,
    note: input.note,
    created_at: t,
    updated_at: t,
  };
  await env.DB.prepare(
    `INSERT INTO hooks (id, user_id, category_id, text, note, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(row.id, userId, row.category_id, row.text, row.note, t)
    .run();
  return row;
}

export async function updateHook(
  env: Env,
  userId: string,
  id: string,
  input: { text: string; note: string; category_id: string | null },
): Promise<boolean> {
  if (!(await assertCategoryOwned(env, userId, input.category_id))) return false;
  const res = await env.DB.prepare(
    `UPDATE hooks SET text = ?3, note = ?4, category_id = ?5, updated_at = ?6
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId, input.text, input.note, input.category_id, now())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function deleteHook(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM hooks WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function countByCategory(
  env: Env,
  userId: string,
): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(category_id, '') AS cid, COUNT(*) AS n
       FROM hooks WHERE user_id = ?1 GROUP BY cid`,
  )
    .bind(userId)
    .all<{ cid: string; n: number }>();
  return new Map(results.map((r) => [r.cid, r.n]));
}
