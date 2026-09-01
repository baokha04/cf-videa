import type { Env } from '../types';
import { tooMany } from '../http/response';
import { now } from '../util/id';

/**
 * Bộ đếm cửa sổ cố định trên D1.
 *
 * Vì sao không dùng Durable Objects: một dự án Pages không có DO của riêng nó —
 * muốn có thì phải deploy thêm một Worker chỉ để chứa class, đánh mất chính cái
 * đơn giản mà Pages mang lại.
 *
 * Vì sao một câu lệnh duy nhất: D1 không có transaction tương tác, nên đọc-rồi-ghi
 * hai bước sẽ đua nhau. INSERT ... ON CONFLICT DO UPDATE ... RETURNING là nguyên tử.
 */
export interface Limit {
  /** Số lần cho phép trong một cửa sổ. */
  max: number;
  /** Độ dài cửa sổ, tính bằng giây. */
  windowSec: number;
}

export const LIMITS = {
  loginIp: { max: 20, windowSec: 60 },
  loginEmail: { max: 5, windowSec: 60 },
  registerIp: { max: 5, windowSec: 3600 },
  // Giới hạn này bảo vệ cả hạn mức Workers AI, không chỉ chống lạm dụng.
  searchUser: { max: 30, windowSec: 60 },
} satisfies Record<string, Limit>;

/** Tăng bộ đếm và ném lỗi 429 nếu vượt. */
export async function enforce(
  env: Env,
  bucket: string,
  limit: Limit,
  friendlyMessage: string,
): Promise<void> {
  const windowStart = Math.floor(now() / 1000 / limit.windowSec) * limit.windowSec;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket) DO UPDATE SET
       count        = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`,
  )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  if (count > limit.max) {
    const retryAfter = windowStart + limit.windowSec - Math.floor(now() / 1000);
    throw tooMany(friendlyMessage, Math.max(1, retryAfter));
  }
}

/** Đăng nhập thành công thì xoá bộ đếm để lần sai trước đó không tính vào sau. */
export async function reset(env: Env, buckets: string[]): Promise<void> {
  if (buckets.length === 0) return;
  const placeholders = buckets.map((_, i) => `?${i + 1}`).join(', ');
  await env.DB.prepare(`DELETE FROM rate_limits WHERE bucket IN (${placeholders})`)
    .bind(...buckets)
    .run();
}

export async function sweepRateLimits(env: Env, olderThanSec = 7200): Promise<number> {
  const cutoff = Math.floor(now() / 1000) - olderThanSec;
  const res = await env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?1`)
    .bind(cutoff)
    .run();
  return res.meta.changes ?? 0;
}
