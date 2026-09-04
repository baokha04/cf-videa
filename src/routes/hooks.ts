import type { Ctx } from '../http/guard';
import { pathParam, readJson, requireUser } from '../http/guard';
import { badRequest, notFound } from '../http/response';
import * as hooksDb from '../db/hooks';
import { computeHookHash } from '../content';
import { deleteVectors, queueGc, vectorId } from '../vec/index';
import { indexOne } from '../vec/sync';
import { normText, requiredText } from '../util/validate';

/** Thư viện hook có nhóm danh mục. Hook không gắn cứng vào biến thể nào. */

/**
 * Trần độ dài nội dung hook. Cột `hooks.text` là TEXT thuần nên SQLite không chặn gì
 * cả — trần THẬT nằm ở đây và ở `maxlength` của ô nhập, không phải ở schema.
 *
 * 2000 chứ không phải hơn: `hookEmbedText` gộp text + note rồi cắt ở MAX_EMBED_CHARS
 * (4000). Giữ 2000 + 300 dưới ngưỡng đó nghĩa là mọi hook hợp lệ đều được nhúng TRỌN
 * VẸN — hook dài hơn trần nhúng sẽ bị cắt lặng lẽ và tìm kiếm ngữ nghĩa không bao giờ
 * thấy phần đuôi.
 */
const HOOK_TEXT_MAX = 2000;
const HOOK_NOTE_MAX = 300;

/** Xem chú thích ở routes/variants.ts — cùng một lý do. */
function toDto(row: hooksDb.HookRow) {
  const {
    content_hash, embedded_hash, indexed_meta_hash, embedding_model, embedded_at,
    embed_attempts, ...rest
  } = row;
  void content_hash; void embedding_model; void embedded_at; void embed_attempts;
  return {
    ...rest,
    indexed:
      embedded_hash === row.content_hash &&
      indexed_meta_hash === hooksDb.hookMetaSignature(row),
  };
}

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
  return c.json({ hooks: rows.map(toDto) });
}

export async function createHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);
  const input = {
    text: requiredText(body['text'], HOOK_TEXT_MAX, 'text'),
    note: normText(body['note'], HOOK_NOTE_MAX, 'note'),
    category_id: parseCategoryId(body['category_id']),
  };
  // Như ý tưởng: chỉ tính hash và ghi D1. Không nhúng, không đụng Vectorize —
  // việc đó để người dùng bấm nút Index của chính hook này.
  const row = await hooksDb.createHook(c.env, user.id, input, await computeHookHash(input));
  // null ở đây nghĩa là danh mục không thuộc người dùng này — trả 404 chứ không phải
  // 403, để không xác nhận rằng danh mục đó tồn tại.
  if (!row) throw notFound('Không tìm thấy danh mục.');
  return c.json({ hook: toDto(row) }, 201);
}

export async function updateHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const existing = await hooksDb.getHook(c.env, user.id, id);
  if (!existing) throw notFound('Không tìm thấy hook.');
  const body = await readJson(c);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const input = {
    text: has('text') ? requiredText(body['text'], HOOK_TEXT_MAX, 'text') : existing.text,
    note: has('note') ? normText(body['note'], HOOK_NOTE_MAX, 'note') : existing.note,
    category_id: has('category_id') ? parseCategoryId(body['category_id']) : existing.category_id,
  };
  // Đổi mỗi danh mục cũng phải được nhìn thấy, dù content_hash không đổi: danh mục nằm
  // trong metadata của vector, và cột indexed_meta_hash lo việc đó (migrations/0007).
  const ok = await hooksDb.updateHook(c.env, user.id, id, input, await computeHookHash(input));
  if (!ok) throw notFound('Không tìm thấy hook hoặc danh mục.');
  const fresh = await hooksDb.getHook(c.env, user.id, id);
  return c.json({ hook: fresh ? toDto(fresh) : null });
}

export async function deleteHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const ok = await hooksDb.deleteHook(c.env, user.id, id);
  if (!ok) throw notFound('Không tìm thấy hook.');

  // Từ khi hook có vector riêng, xoá hàng mà không xoá vector là để lại một vector mồ
  // côi chiếm suất topK mãi mãi. Hoãn được, nhưng không bỏ được.
  const vid = vectorId('hook', id);
  c.executionCtx.waitUntil(
    deleteVectors(c.env, [vid]).catch(async (err) => {
      console.error('deleteVectors failed', vid, err);
      await queueGc(c.env, [vid], user.id).catch(() => {});
    }),
  );
  return c.body(null, 204);
}

/** Nút "Index" của riêng một hook. Xem chú thích ở ideas.indexIdea. */
export async function indexHook(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const result = await indexOne(c.env, user.id, 'hook', id);
  if (!result) throw notFound('Không tìm thấy hook.');
  const fresh = await hooksDb.getHook(c.env, user.id, id);
  return c.json({ hook: fresh ? toDto(fresh) : null, indexed: result.indexed });
}
