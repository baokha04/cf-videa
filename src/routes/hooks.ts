import type { Ctx } from '../http/guard';
import { pathParam, readJson, requireUser } from '../http/guard';
import { badRequest, notFound } from '../http/response';
import * as ideasDb from '../db/ideas';
import * as hooksDb from '../db/hooks';
import { rehashIdea } from '../vec/sync';
import { normText, requiredText } from '../util/validate';

/**
 * Quản lý danh mục video hook: thêm, sửa, xoá và đổi thứ tự từng mục.
 *
 * VÌ SAO TÁCH KHỎI FORM Ý TƯỞNG: trước đây cả danh mục là một ô nhiều dòng gửi kèm
 * khi bấm "Lưu". Cách đó không có khái niệm "một hook" — sửa một dòng là ghi đè cả
 * danh mục, và hai tab mở cùng lúc thì tab lưu sau xoá sạch việc của tab kia. Mỗi
 * hook giờ có id riêng nên sửa đúng dòng đó, và hai người sửa hai hook khác nhau
 * không giẫm lên nhau.
 *
 * BẤT BIẾN PHẢI GIỮ: hook nằm trong văn bản đem đi nhúng, nên MỌI route ở đây phải
 * gọi rehashIdea() sau khi ghi. Quên một chỗ thì content_hash không đổi, hàng vẫn
 * hiện là "đã index", và vector trên Vectorize mốc lại mà không có dấu hiệu gì.
 */

const MAX_HOOKS = 30;
const MAX_HOOK_CHARS = 500;

/**
 * Xác thực ý tưởng cha thuộc về người đang đăng nhập, TRƯỚC mọi thao tác.
 *
 * Các hàm ở db/hooks.ts đều đã tự ràng buộc user_id trong câu lệnh, nên đây không
 * phải lớp bảo vệ — nó chỉ để phân biệt "ý tưởng không tồn tại" với "danh mục rỗng",
 * và để trả 404 thay vì âm thầm không làm gì.
 */
async function ownedIdea(c: Ctx, userId: string, ideaId: string): Promise<void> {
  const row = await ideasDb.getById(c.env, userId, ideaId);
  if (!row) throw notFound('Không tìm thấy ý tưởng.');
}

export async function listHooks(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ideaId = pathParam(c, 'id');
  await ownedIdea(c, user.id, ideaId);
  return c.json({ items: await hooksDb.listHooks(c.env, user.id, ideaId) });
}

export async function addHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ideaId = pathParam(c, 'id');
  await ownedIdea(c, user.id, ideaId);

  const body = await readJson(c);
  const text = requiredText(body['text'], MAX_HOOK_CHARS, 'text');

  if ((await hooksDb.countHooks(c.env, user.id, ideaId)) >= MAX_HOOKS) {
    throw badRequest('too_many_hooks', `Tối đa ${MAX_HOOKS} hook cho mỗi ý tưởng.`);
  }

  const hook = await hooksDb.addHook(c.env, user.id, ideaId, text);
  if (!hook) throw notFound('Không tìm thấy ý tưởng.');
  await rehashIdea(c.env, user.id, ideaId);
  return c.json({ hook, indexed: false }, 201);
}

export async function updateHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ideaId = pathParam(c, 'id');
  const hookId = pathParam(c, 'hookId');
  await ownedIdea(c, user.id, ideaId);

  const body = await readJson(c);
  const text = requiredText(body['text'], MAX_HOOK_CHARS, 'text');
  if (!(await hooksDb.updateHook(c.env, user.id, ideaId, hookId, text))) {
    throw notFound('Không tìm thấy hook này.');
  }
  await rehashIdea(c.env, user.id, ideaId);
  return c.json({ items: await hooksDb.listHooks(c.env, user.id, ideaId), indexed: false });
}

export async function removeHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ideaId = pathParam(c, 'id');
  await ownedIdea(c, user.id, ideaId);

  if (!(await hooksDb.removeHook(c.env, user.id, ideaId, pathParam(c, 'hookId')))) {
    throw notFound('Không tìm thấy hook này.');
  }
  await rehashIdea(c.env, user.id, ideaId);
  return c.body(null, 204);
}

/**
 * Đổi thứ tự. Thứ tự có nghĩa thật (dòng đầu là hook đang ưng nhất) và nó nằm trong
 * văn bản đem đi nhúng, nên đây cũng là một thay đổi nội dung — vẫn phải rehash.
 */
export async function moveHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ideaId = pathParam(c, 'id');
  const hookId = pathParam(c, 'hookId');
  await ownedIdea(c, user.id, ideaId);

  const body = await readJson(c);
  const dir = normText(body['dir'], 10, 'dir');
  if (dir !== 'up' && dir !== 'down') {
    throw badRequest('invalid_field', 'Trường dir phải là up hoặc down.');
  }

  // Đã ở đầu hoặc cuối danh mục thì không phải lỗi, chỉ là không có gì để làm —
  // và cũng không được rehash, vì nội dung không hề đổi.
  const moved = await hooksDb.moveHook(c.env, user.id, ideaId, hookId, dir);
  if (moved) await rehashIdea(c.env, user.id, ideaId);
  return c.json({
    items: await hooksDb.listHooks(c.env, user.id, ideaId),
    moved,
    ...(moved ? { indexed: false } : {}),
  });
}
