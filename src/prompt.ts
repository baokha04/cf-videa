import type { Env, IdeaRow } from './types';
import type { HookRow } from './db/hooks';
import type { VariantRow } from './db/variants';
import { now } from './util/id';

/**
 * Ghép prompt đầy đủ từ: ý tưởng gốc + hook + biến thể.
 *
 * KHÔNG có AI ở đây. Đây là phép thay chuỗi thuần tuý trên một mẫu do người dùng
 * sở hữu — cùng đầu vào luôn ra cùng kết quả, không tốn lời gọi nào, và người dùng
 * đọc mẫu là biết chính xác prompt sẽ ra sao.
 */

/**
 * Mẫu mặc định: NỘI DUNG tiếng Việt (giữ nguyên chữ người dùng nhập), NHÃN cấu trúc
 * tiếng Anh. Lý do: các công cụ video AI dựa vào những nhãn như Shot, Camera,
 * Duration, Style để hiểu bố cục prompt, và chúng nhận diện nhãn tiếng Anh tốt hơn
 * hẳn — trong khi nội dung sáng tạo thì để nguyên tiếng Việt vẫn tốt hơn là dịch máy.
 */
export const DEFAULT_TEMPLATE = `# SHORT VIDEO PROMPT

**Concept:** {{idea_title}}
**Variant:** {{variant_title}}
**Niche:** {{niche}}
**Platform:** {{platform}}
**Language:** Vietnamese (tiếng Việt)

## Hook — first 3 seconds
{{hook}}

## Angle
{{variant_angle}}

## Script outline
{{script}}

## Style notes
- Vertical 9:16, short-form pacing
- Open on the hook line above, no intro card
- Keep on-screen text in Vietnamese

## Negative prompt — avoid
{{negative_prompt}}

## Tags
{{tags}}`;

/** Mọi biến mẫu nhận biết được. Dùng cho cả việc thay thế lẫn phần trợ giúp trên UI. */
export const TEMPLATE_VARS = [
  'idea_title',
  'variant_title',
  'variant_angle',
  'hook',
  'hook_category',
  'script',
  'niche',
  'platform',
  'status',
  'tags',
  'negative_prompt',
] as const;

export type TemplateVar = (typeof TEMPLATE_VARS)[number];

export interface PromptParts {
  idea: IdeaRow;
  variant: VariantRow;
  hook: HookRow | null;
  hookCategoryName: string | null;
  tags: string[];
}

export function buildValues(p: PromptParts): Record<TemplateVar, string> {
  return {
    idea_title: p.idea.title,
    variant_title: p.variant.title,
    variant_angle: p.variant.angle,
    hook: p.hook?.text ?? '',
    hook_category: p.hookCategoryName ?? '',
    // Dàn ý riêng của biến thể GHI ĐÈ dàn ý gốc; để trống thì kế thừa. Đây là quy
    // tắc chính khiến biến thể vừa gọn khi không cần, vừa đầy đủ khi cần.
    script: p.variant.script_outline.trim() || p.idea.script_outline,
    niche: p.idea.niche,
    platform: p.idea.platform,
    status: p.idea.status,
    tags: p.tags.join(', '),
    // Lấy từ ý tưởng gốc. Biến thể không có ô riêng: thứ "không được xuất hiện" là
    // thuộc tính của chủ đề, không phải của một góc triển khai cụ thể.
    negative_prompt: p.idea.negative_prompt,
  };
}

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * Thay {{bien}} bằng giá trị.
 *
 * Biến KHÔNG nhận biết được thì GIỮ NGUYÊN chứ không xoá đi. Gõ sai tên biến mà bị
 * xoá âm thầm thì người dùng chỉ thấy prompt thiếu một mảng và không hiểu vì sao;
 * để nguyên `{{tieu_de}}` trong kết quả là tự nó chỉ ra lỗi.
 *
 * Một lần duyệt bằng replace, nên giá trị thay vào KHÔNG bị quét lại — nội dung
 * người dùng có chứa `{{hook}}` cũng không thể kích hoạt vòng thay thế thứ hai.
 */
export function render(template: string, values: Record<string, string>): string {
  return template.replace(VAR_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] ?? '' : whole,
  );
}

/** Tên biến xuất hiện trong mẫu nhưng không nhận biết được — để UI cảnh báo. */
export function unknownVars(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) {
    const name = m[1] as string;
    if (!(TEMPLATE_VARS as readonly string[]).includes(name)) found.add(name);
  }
  return [...found];
}

export function buildPrompt(template: string, parts: PromptParts): string {
  return render(template, buildValues(parts));
}

// --- Lưu trữ mẫu ------------------------------------------------------------

export async function getTemplate(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT body FROM prompt_templates WHERE user_id = ?1`)
    .bind(userId)
    .first<{ body: string }>();
  return row?.body ?? DEFAULT_TEMPLATE;
}

export async function saveTemplate(env: Env, userId: string, body: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO prompt_templates (user_id, body, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET body = ?2, updated_at = ?3`,
  )
    .bind(userId, body, now())
    .run();
}

/** Xoá mẫu riêng để quay về mặc định. */
export async function resetTemplate(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM prompt_templates WHERE user_id = ?1`).bind(userId).run();
}
