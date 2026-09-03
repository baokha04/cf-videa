import type { Env, IdeaRow } from './types';
import type { VariantRow } from './db/variants';
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
 * thuộc về ý tưởng nào — nên nó không được ảnh hưởng tới việc tìm kiếm ý tưởng.
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
 * Không có hàm này thì một biến thể mới sẽ không làm ý tưởng "bẩn", nút đồng bộ sẽ
 * không thấy nó, và tìm kiếm ngữ nghĩa vĩnh viễn không biết biến thể đó tồn tại.
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
