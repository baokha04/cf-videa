import type { Env, IdeaRow } from './types';
import * as ideasDb from './db/ideas';
import * as variantsDb from './db/variants';
import * as hooksDb from './db/hooks';
import { setIdeaTags, tagsForIdeas } from './db/tags';
import { ideaEmbedText } from './content';
import { contentHash } from './vec/embeddings';
import { buildPrompt, getTemplate } from './prompt';

/**
 * KẾT HỢP: ý tưởng gốc + biến thể + hook → một Ý TƯỞNG GỐC MỚI trong kho.
 *
 * Khác hẳn `GET /api/prompt`, vốn chỉ ghép ra chuỗi prompt rồi thôi. Ở đây kết quả
 * được LƯU thành một hàng `ideas` mới, có lineage trỏ về ba thứ đã sinh ra nó, và từ
 * đó sống đời sống riêng: sửa được, index được, tự có nút Index của nó.
 *
 * Tách khỏi routes/ vì đây là điều phối nghiệp vụ chứ không phải chuyện HTTP — và vì
 * tách ra thì kiểm thử được thẳng, không phải dựng phiên đăng nhập giả.
 */

export interface CombineInput {
  ideaId: string;
  variantId: string;
  hookId: string | null;
  /** Bỏ trống thì lấy "<tiêu đề gốc> — <tiêu đề biến thể>". */
  title?: string | undefined;
}

export type CombineError =
  | 'idea_not_found'
  | 'variant_not_found'
  | 'hook_not_found'
  | 'variant_mismatch';

export type CombineOutcome =
  | { ok: true; row: IdeaRow; tags: string[]; prompt: string }
  | { ok: false; error: CombineError };

/** Giới hạn của cột script_outline, giống hệt ràng buộc ở parseIdeaInput. */
const MAX_SCRIPT = 8000;
const MAX_TITLE = 200;

export async function combine(
  env: Env,
  userId: string,
  input: CombineInput,
): Promise<CombineOutcome> {
  // Cả ba đều đọc kèm ràng buộc user_id, nên của người khác cho ra "không tìm thấy"
  // chứ không phải "không có quyền" — không xác nhận sự tồn tại của hàng người khác.
  const idea = await ideasDb.getById(env, userId, input.ideaId);
  if (!idea) return { ok: false, error: 'idea_not_found' };

  const variant = await variantsDb.getById(env, userId, input.variantId);
  if (!variant) return { ok: false, error: 'variant_not_found' };

  // Biến thể phải thuộc đúng ý tưởng gốc được chọn. Ràng buộc này là cố ý: quy tắc kế
  // thừa dàn ý ({{script}} ở src/prompt.ts) chỉ có nghĩa khi hai thứ đó là một cặp.
  // Muốn cho phép trộn chéo biến thể của ý tưởng khác thì bỏ đúng phép kiểm tra này.
  if (variant.idea_id !== input.ideaId) return { ok: false, error: 'variant_mismatch' };

  let hook: hooksDb.HookRow | null = null;
  let hookCategoryName: string | null = null;
  if (input.hookId) {
    hook = await hooksDb.getHook(env, userId, input.hookId);
    if (!hook) return { ok: false, error: 'hook_not_found' };
    if (hook.category_id) {
      const cats = await hooksDb.listCategories(env, userId);
      hookCategoryName = cats.find((x) => x.id === hook?.category_id)?.name ?? null;
    }
  }

  const tagMap = await tagsForIdeas(env, [idea.id]);
  const tags = tagMap.get(idea.id) ?? [];

  const ideaInput: ideasDb.IdeaInput = {
    title: (input.title?.trim() || `${idea.title} — ${variant.title}`).slice(0, MAX_TITLE),
    script_outline: mergedScript(idea, variant, hook),
    platform: idea.platform,
    niche: idea.niche,
    // Luôn quay về 'idea': bản kết hợp là một khởi đầu mới, kể cả khi ý tưởng nguồn
    // đã quay xong và đăng rồi.
    status: 'idea',
    negative_prompt: idea.negative_prompt,
  };

  // Ý tưởng mới chưa có biến thể nào, nên văn bản nhúng chỉ gồm chính nó và tag.
  const hash = await contentHash(ideaEmbedText(ideaInput, tags, []));
  const row = await ideasDb.create(env, userId, ideaInput, hash, {
    source_idea_id: input.ideaId,
    source_variant_id: input.variantId,
    source_hook_id: input.hookId,
  });
  if (tags.length) await setIdeaTags(env, userId, row.id, tags);

  // Vẫn trả prompt đã ghép: người dùng thường muốn chép nó đem đi dùng ngay, chứ không
  // chỉ muốn có thêm một hàng trong kho.
  const template = await getTemplate(env, userId);
  const prompt = buildPrompt(template, { idea, variant, hook, hookCategoryName, tags });

  return { ok: true, row, tags, prompt };
}

/**
 * Dàn ý của ý tưởng mới là VĂN BẢN THUẦN, không phải chuỗi prompt đã ghép.
 *
 * Nhãn cấu trúc của mẫu ("## Style notes", "Vertical 9:16"…) là chỉ dẫn cho công cụ
 * dựng video. Nhét chúng vào đây thì mọi ý tưởng kết hợp đều mang cùng một khối chữ,
 * và vector của chúng xúm lại quanh một điểm — tìm kiếm ngữ nghĩa không phân biệt nổi
 * cái nào với cái nào nữa.
 *
 * Hook đi vào dàn ý vì bảng `ideas` không còn cột hook từ migration 0005. Đặt nó ở đây
 * cũng có nghĩa hook trở thành một phần văn bản đem đi nhúng của ý tưởng kết hợp —
 * đúng như mong đợi: hook chính là thứ làm nó khác với ý tưởng nguồn.
 */
function mergedScript(
  idea: IdeaRow,
  variant: variantsDb.VariantRow,
  hook: hooksDb.HookRow | null,
): string {
  // Dàn ý riêng của biến thể GHI ĐÈ dàn ý gốc; để trống thì kế thừa. Cùng quy tắc với
  // {{script}} lúc sinh prompt, và cố ý giữ giống nhau.
  const script = variant.script_outline.trim() || idea.script_outline;
  return [
    hook ? `Hook: ${hook.text}` : '',
    variant.angle ? `Góc nhìn: ${variant.angle}` : '',
    script,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_SCRIPT);
}
