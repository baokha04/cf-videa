/**
 * Kiểu dùng chung. Cố ý KHÔNG import gì từ Pages/Hono ở đây để `src/` giữ được
 * tính di động: nguyên khối này chạy nguyên vẹn dưới một Worker sau này.
 */

export interface Env {
  DB: D1Database;
  VEC: VectorizeIndex;
  AI: Ai;
  APP_ENV: string;
  COOKIE_NAME: string;
  EMBEDDINGS_MODE: string;
  ADMIN_TOKEN?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  display_name: string | null;
}

export interface SessionInfo {
  id: string;
  expires_at: number;
  absolute_exp: number;
  /** Người dùng chọn "ghi nhớ đăng nhập" → phiên dài + cookie sống qua lần đóng trình duyệt. */
  remember: boolean;
}

/** Biến đặt vào context của Hono bởi middleware xác thực. */
export type Variables = {
  user?: SessionUser;
  session?: SessionInfo;
};

export const PLATFORMS = ['tiktok', 'reels', 'shorts', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const IDEA_STATUSES = ['idea', 'scripted', 'filmed', 'published', 'archived'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const VISIBILITIES = ['private', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/**
 * Ý tưởng gốc là bản nguyên bản; biến thể mọc ra từ đúng một ý tưởng gốc.
 * Cây chỉ có MỘT tầng — biến thể không đẻ tiếp được biến thể (src/db/ideas.ts).
 */
export const IDEA_KINDS = ['origin', 'variant'] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];

export interface IdeaRow {
  id: string;
  user_id: string;
  title: string;
  hook: string;
  script_outline: string;
  /** Ý tưởng gốc giữ nguyên văn — không bị dàn ý viết đè lên. */
  source_idea: string;
  /** Prompt công thức, viết một lần rồi dán lại cho mọi biến thể. */
  prompt_recipe: string;
  /** Thứ KHÔNG được xuất hiện. Cố ý không đem đi nhúng — xem src/vec/embeddings.ts. */
  negative_prompt: string;
  platform: Platform;
  niche: string;
  status: IdeaStatus;
  visibility: Visibility;
  kind: IdeaKind;
  /** Chỉ khác NULL với biến thể, và luôn trỏ tới một ý tưởng gốc cùng chủ sở hữu. */
  parent_id: string | null;
  lang: string;
  content_hash: string;
  embedded_hash: string | null;
  /** Chữ ký metadata tại lần upsert gần nhất — xem migrations/0004 và 0005. */
  indexed_meta_hash: string | null;
  embedding_model: string | null;
  embedded_at: number | null;
  embed_attempts: number;
  created_at: number;
  updated_at: number;
}

/**
 * Một mục trong danh mục video hook. Có `id` nên sửa và xoá được từng dòng riêng;
 * `position` là thứ tự người dùng tự sắp (0 = hook đang ưng nhất).
 */
export interface HookRow {
  id: string;
  text: string;
  position: number;
}

/** Ý tưởng trả về cho client — bỏ các cột nội bộ, thêm tag và trạng thái index. */
export interface IdeaDto {
  id: string;
  title: string;
  hook: string;
  script_outline: string;
  source_idea: string;
  prompt_recipe: string;
  negative_prompt: string;
  platform: Platform;
  niche: string;
  status: IdeaStatus;
  visibility: Visibility;
  kind: IdeaKind;
  parent_id: string | null;
  tags: string[];
  /** Danh mục video hook — các cách mở đầu đã nghĩ ra cho cùng ý tưởng này. */
  hooks: string[];
  /** Số ý tưởng biến thể mọc ra từ ý tưởng này (luôn 0 với một biến thể). */
  variant_count: number;
  liked: boolean;
  /** Vector trên Vectorize đã khớp với hàng D1 này chưa. */
  indexed: boolean;
  created_at: number;
  updated_at: number;
  score?: number;
}
