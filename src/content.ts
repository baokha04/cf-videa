import type { Env, IdeaRow } from './types';
import type { VariantRow } from './db/variants';
import type { HookRow } from './db/hooks';
import * as variantsDb from './db/variants';
import { tagsForIdeas } from './db/tags';
import { contentHash, MAX_EMBED_CHARS, MODEL_ID } from './vec/embeddings';
import { now } from './util/id';

/**
 * Định nghĩa DUY NHẤT về "nội dung có thể index của một ý tưởng".
 *
 * Tách ra khỏi vec/embeddings vì nó không nói về nhúng hay AI, mà nói về việc những
 * gì trong D1 hợp thành phần văn bản đại diện cho một ý tưởng — nay trải trên ba
 * bảng: ideas, idea_variants và tags.
 *
 * Hook KHÔNG nằm trong đây. Hook là thư viện dùng chung, chọn lúc sinh prompt, không
 * thuộc về ý tưởng nào — nên nó không được ảnh hưởng tới việc tìm kiếm ý tưởng. Hook có
 * vector RIÊNG của nó (xem hookEmbedText bên dưới), tìm trong kho hook chứ không lẫn
 * vào kết quả tìm ý tưởng.
 *
 * negative_prompt cũng KHÔNG nằm trong đây, và đó là điều bắt buộc: nhúng một danh sách
 * "không được xuất hiện" thì embedding đọc dấu trừ thành dấu cộng — ý tưởng sẽ khớp với
 * đúng thứ nó muốn tránh.
 */
export function ideaEmbedText(
  idea: Pick<IdeaRow, 'title' | 'script_outline' | 'niche' | 'platform'>,
  tags: string[],
  variants: Array<Pick<VariantRow, 'title' | 'angle'>>,
): string {
  const parts = [
    idea.title,
    idea.script_outline,
    idea.niche ? `Niche: ${idea.niche}` : '',
    `Nền tảng: ${idea.platform}`,
    tags.length ? `Tags: ${tags.join(', ')}` : '',
    // Biến thể góp mặt để tìm kiếm ngữ nghĩa thấy được ý tưởng qua chính góc triển
    // khai của nó, chứ không chỉ qua tiêu đề gốc.
    ...variants.map((v) => [v.title, v.angle].filter(Boolean).join(' — ')),
  ].filter(Boolean);
  return parts.join('\n').slice(0, MAX_EMBED_CHARS);
}

/** Tính lại content_hash của một ý tưởng từ trạng thái hiện tại trong D1. */
export async function computeIdeaHash(env: Env, idea: IdeaRow): Promise<string> {
  const [tagMap, variants] = await Promise.all([
    tagsForIdeas(env, [idea.id]),
    variantsDb.listForIdea(env, idea.user_id, idea.id),
  ]);
  return contentHash(ideaEmbedText(idea, tagMap.get(idea.id) ?? [], variants));
}

/**
 * Tính lại và ghi content_hash sau khi có thứ gì đó ảnh hưởng văn bản nhúng thay đổi
 * — sửa tag, hoặc thêm/sửa/xoá biến thể.
 *
 * Không có hàm này thì một biến thể mới sẽ không làm ý tưởng "bẩn", nút Index của ý
 * tưởng coi như đã xong, và tìm kiếm ngữ nghĩa vĩnh viễn không biết biến thể đó tồn tại.
 */
export async function touchIdeaContent(
  env: Env,
  userId: string,
  ideaId: string,
): Promise<void> {
  const idea = await env.DB.prepare(`SELECT * FROM ideas WHERE id = ?1 AND user_id = ?2`)
    .bind(ideaId, userId)
    .first<IdeaRow>();
  if (!idea) return;
  const hash = await computeIdeaHash(env, idea);
  if (hash === idea.content_hash) return;
  await env.DB.prepare(`UPDATE ideas SET content_hash = ?3, updated_at = ?4
                         WHERE id = ?1 AND user_id = ?2`)
    .bind(ideaId, userId, hash, now())
    .run();
}

export { MODEL_ID };

/**
 * Văn bản nhúng của một HOOK.
 *
 * Hàm THUẦN của đúng một hàng `hooks`. Tên danh mục cố ý không có mặt: nếu có thì đổi
 * tên một danh mục sẽ làm bẩn mọi hook bên trong nó, và một thao tác sắp xếp lại biến
 * thành một loạt lời gọi Workers AI. Danh mục đi vào METADATA của vector
 * (`category_id`), nơi lọc được mà không tốn lần nhúng nào.
 */
export function hookEmbedText(hook: Pick<HookRow, 'text' | 'note'>): string {
  return [hook.text, hook.note].filter(Boolean).join('\n').slice(0, MAX_EMBED_CHARS);
}

/**
 * Văn bản nhúng của một BIẾN THỂ.
 *
 * Cũng là hàm thuần của đúng một hàng `idea_variants`, và cố ý KHÔNG kế thừa dàn ý của
 * ý tưởng gốc khi biến thể để trống — dù lúc sinh prompt thì có kế thừa (quy tắc
 * {{script}} ở src/prompt.ts). Hai việc khác nhau: prompt cần một kịch bản đầy đủ để
 * đem đi dựng video, còn vector cần thứ PHÂN BIỆT biến thể này với các biến thể khác.
 * Nhét dàn ý gốc vào cả n biến thể thì cả n vector xúm lại quanh một điểm và việc tìm
 * theo góc triển khai — đúng lý do biến thể được index — hỏng hẳn. Kèm theo: sửa dàn ý
 * của ý tưởng gốc sẽ không còn làm bẩn lây toàn bộ biến thể của nó.
 */
export function variantEmbedText(
  v: Pick<VariantRow, 'title' | 'angle' | 'script_outline'>,
): string {
  return [v.title, v.angle, v.script_outline]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_EMBED_CHARS);
}

export function computeHookHash(hook: Pick<HookRow, 'text' | 'note'>): Promise<string> {
  return contentHash(hookEmbedText(hook));
}

export function computeVariantHash(
  v: Pick<VariantRow, 'title' | 'angle' | 'script_outline'>,
): Promise<string> {
  return contentHash(variantEmbedText(v));
}
