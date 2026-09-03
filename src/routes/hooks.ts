import type { Ctx } from '../http/guard';
import { pathParam, readJson, requireUser } from '../http/guard';
import { badRequest, notFound } from '../http/response';
import * as hooksDb from '../db/hooks';
import { normText, requiredText } from '../util/validate';

/** Thư viện hook có nhóm danh mục. Hook không gắn cứng vào biến thể nào. */

function parseSortOrder(raw: unknown): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Chuỗi rỗng và null đều nghĩa là "chưa phân loại". */
function parseCategoryId(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw badRequest('invalid_field', 'Danh mục không hợp lệ.');
  }
  return raw;
}

export async function listCategories(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const [cats, counts] = await Promise.all([
    hooksDb.listCategories(c.env, user.id),
    hooksDb.countByCategory(c.env, user.id),
  ]);
  return c.json({
    categories: cats.map((x) => ({
      id: x.id,
      name: x.name,
      sort_order: x.sort_order,
      count: counts.get(x.id) ?? 0,
    })),
    // Nhóm ảo cho hook không thuộc danh mục nào — luôn trả về để giao diện hiển thị
    // được cả khi người dùng chưa tạo danh mục nào.
    uncategorized: counts.get('') ?? 0,
  });
}

export async function createCategory(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);
  const name = requiredText(body['name'], 60, 'name');
  const row = await hooksDb.createCategory(c.env, user.id, name, parseSortOrder(body['sort_order']));
  if (!row) throw badRequest('duplicate_category', 'Đã có danh mục trùng tên.');
  return c.json({ category: { ...row, count: 0 } }, 201);
}

export async function updateCategory(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const body = await readJson(c);
  const ok = await hooksDb.renameCategory(
    c.env, user.id, id,
    requiredText(body['name'], 60, 'name'),
    parseSortOrder(body['sort_order']),
  );
  if (!ok) throw notFound('Không tìm thấy danh mục.');
  return c.body(null, 204);
}

export async function deleteCategory(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ok = await hooksDb.deleteCategory(c.env, user.id, pathParam(c, 'id'));
  if (!ok) throw notFound('Không tìm thấy danh mục.');
  return c.body(null, 204);
}

export async function listHooks(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const raw = c.req.query('category');
  // 'none' lọc riêng nhóm chưa phân loại; bỏ trống là lấy tất cả.
  const filter = raw === undefined ? undefined : raw === 'none' ? null : raw;
  const rows = await hooksDb.listHooks(c.env, user.id, filter);
  return c.json({ hooks: rows });
}

export async function createHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);
  const row = await hooksDb.createHook(c.env, user.id, {
    text: requiredText(body['text'], 500, 'text'),
    note: normText(body['note'], 300, 'note'),
    category_id: parseCategoryId(body['category_id']),
  });
  // null ở đây nghĩa là danh mục không thuộc người dùng này — trả 404 chứ không phải
  // 403, để không xác nhận rằng danh mục đó tồn tại.
  if (!row) throw notFound('Không tìm thấy danh mục.');
  return c.json({ hook: row }, 201);
}

export async function updateHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const existing = await hooksDb.getHook(c.env, user.id, id);
  if (!existing) throw notFound('Không tìm thấy hook.');
  const body = await readJson(c);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const ok = await hooksDb.updateHook(c.env, user.id, id, {
    text: has('text') ? requiredText(body['text'], 500, 'text') : existing.text,
    note: has('note') ? normText(body['note'], 300, 'note') : existing.note,
    category_id: has('category_id') ? parseCategoryId(body['category_id']) : existing.category_id,
  });
  if (!ok) throw notFound('Không tìm thấy hook hoặc danh mục.');
  const fresh = await hooksDb.getHook(c.env, user.id, id);
  return c.json({ hook: fresh });
}

export async function deleteHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ok = await hooksDb.deleteHook(c.env, user.id, pathParam(c, 'id'));
  if (!ok) throw notFound('Không tìm thấy hook.');
  return c.body(null, 204);
}
