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

export interface IdeaRow {
  id: string;
  user_id: string;
  title: string;
  hook: string;
  script_outline: string;
  platform: Platform;
  niche: string;
  status: IdeaStatus;
  visibility: Visibility;
  lang: string;
  content_hash: string;
  embedded_hash: string | null;
  embedding_model: string | null;
  embedded_at: number | null;
  embed_attempts: number;
  created_at: number;
  updated_at: number;
}

/** Ý tưởng trả về cho client — bỏ các cột nội bộ, thêm tag và trạng thái index. */
export interface IdeaDto {
  id: string;
  title: string;
  hook: string;
  script_outline: string;
  platform: Platform;
  niche: string;
  status: IdeaStatus;
  visibility: Visibility;
  tags: string[];
  liked: boolean;
  indexed: boolean;
  created_at: number;
  updated_at: number;
  score?: number;
}
