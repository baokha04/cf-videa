import type { Ctx } from '../http/guard';
import { pathParam, readJson, requireUser } from '../http/guard';
import { badRequest, notFound } from '../http/response';
import * as variantsDb from '../db/variants';
import * as ideasDb from '../db/ideas';
import * as hooksDb from '../db/hooks';
import { tagsForIdeas } from '../db/tags';
import { touchIdeaContent } from '../content';
import { buildPrompt, getTemplate } from '../prompt';
import { normText, requiredText } from '../util/validate';

function parseInput(body: Record<string, unknown>, base?: variantsDb.VariantRow) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const n = Number(body['sort_order'] ?? base?.sort_order ?? 0);
  return {
    title: has('title') || !base ? requiredText(body['title'], 200, 'title') : base.title,
    angle: has('angle') || !base ? normText(body['angle'], 1000, 'angle') : base.angle,
    script_outline: has('script_outline') || !base
      ? normText(body['script_outline'], 8000, 'script_outline')
      : base.script_outline,
    sort_order: Number.isFinite(n) ? Math.trunc(n) : 0,
  };
}

export async function listVariants(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ideaId = pathParam(c, 'id');
  const idea = await ideasDb.getById(c.env, user.id, ideaId);
  if (!idea) throw notFound('Không tìm thấy ý tưởng.');
  return c.json({ variants: await variantsDb.listForIdea(c.env, user.id, ideaId) });
}

export async function createVariant(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const ideaId = pathParam(c, 'id');
  const body = await readJson(c);
  const row = await variantsDb.create(c.env, user.id, ideaId, parseInput(body));
  if (!row) throw notFound('Không tìm thấy ý tưởng.');
  // Tiêu đề và góc nhìn của biến thể nằm trong văn bản đem đi nhúng, nên ý tưởng gốc
  // phải trở lại trạng thái "chưa đồng bộ" — nếu không, tìm kiếm ngữ nghĩa sẽ không
  // bao giờ thấy biến thể mới.
  await touchIdeaContent(c.env, user.id, ideaId);
  return c.json({ variant: row }, 201);
}

export async function updateVariant(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const existing = await variantsDb.getById(c.env, user.id, id);
  if (!existing) throw notFound('Không tìm thấy biến thể.');
  const body = await readJson(c);
  const ok = await variantsDb.update(c.env, user.id, id, parseInput(body, existing));
  if (!ok) throw notFound('Không tìm thấy biến thể.');
  await touchIdeaContent(c.env, user.id, existing.idea_id);
  const fresh = await variantsDb.getById(c.env, user.id, id);
  return c.json({ variant: fresh });
}

export async function deleteVariant(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  const existing = await variantsDb.getById(c.env, user.id, id);
  if (!existing) throw notFound('Không tìm thấy biến thể.');
  await variantsDb.remove(c.env, user.id, id);
  await touchIdeaContent(c.env, user.id, existing.idea_id);
  return c.body(null, 204);
}

/**
 * Sinh prompt cho một cặp (biến thể × hook).
 *
 * GET chứ không POST: đây là thao tác đọc thuần tuý, không đổi gì cả — và như vậy
 * cũng không dính quy tắc "endpoint GET không được thay đổi dữ liệu" ở guard.ts.
 * Hook để trống là hợp lệ: prompt vẫn ghép được, chỉ là phần Hook bỏ trống.
 */
export async function generatePrompt(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const variantId = c.req.query('variant_id');
  if (!variantId) throw badRequest('missing_variant', 'Thiếu variant_id.');

  const variant = await variantsDb.getById(c.env, user.id, variantId);
  if (!variant) throw notFound('Không tìm thấy biến thể.');

  const idea = await ideasDb.getById(c.env, user.id, variant.idea_id);
  if (!idea) throw notFound('Không tìm thấy ý tưởng gốc.');

  const hookId = c.req.query('hook_id');
  let hook = null;
  let hookCategoryName: string | null = null;
  if (hookId) {
    hook = await hooksDb.getHook(c.env, user.id, hookId);
    if (!hook) throw notFound('Không tìm thấy hook.');
    if (hook.category_id) {
      const cats = await hooksDb.listCategories(c.env, user.id);
      hookCategoryName = cats.find((x) => x.id === hook!.category_id)?.name ?? null;
    }
  }

  const [tagMap, template] = await Promise.all([
    tagsForIdeas(c.env, [idea.id]),
    getTemplate(c.env, user.id),
  ]);

  const prompt = buildPrompt(template, {
    idea,
    variant,
    hook,
    hookCategoryName,
    tags: tagMap.get(idea.id) ?? [],
  });
  return c.json({ prompt, idea_title: idea.title, variant_title: variant.title });
}
