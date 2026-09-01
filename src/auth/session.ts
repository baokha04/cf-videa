import type { Env, SessionInfo, SessionUser } from '../types';
import { bytesToB64url, randomBytes } from '../util/b64';
import { sha256Hex } from '../util/hash';
import { now } from '../util/id';

const DAY = 86_400_000;
/** Hết hạn do nhàn rỗi — được gia hạn trượt. */
export const IDLE_TTL_MS = 14 * DAY;
/** Trần cứng tính từ lúc tạo — không bao giờ gia hạn. */
export const ABSOLUTE_TTL_MS = 90 * DAY;
/** Còn dưới ngưỡng này thì gia hạn (để không phải UPDATE ở mọi request). */
const RENEW_WHEN_REMAINING_MS = 7 * DAY;

export const COOKIE_MAX_AGE_SEC = Math.floor(IDLE_TTL_MS / 1000);

/**
 * Token là 32 byte ngẫu nhiên (256 bit). D1 chỉ lưu sha256(token): một bản dump
 * database không cho phép mạo danh phiên nào cả.
 */
export async function createSession(
  env: Env,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; session: SessionInfo }> {
  const token = bytesToB64url(randomBytes(32));
  const id = await sha256Hex(token);
  const t = now();
  const session: SessionInfo = {
    id,
    expires_at: t + IDLE_TTL_MS,
    absolute_exp: t + ABSOLUTE_TTL_MS,
  };
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, absolute_exp, last_seen_at, ip, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?3, ?6, ?7)`,
  )
    .bind(
      id,
      userId,
      t,
      session.expires_at,
      session.absolute_exp,
      meta.ip ?? null,
      (meta.userAgent ?? '').slice(0, 256) || null,
    )
    .run();
  return { token, session };
}

export interface ResolvedSession {
  user: SessionUser;
  session: SessionInfo;
  /** Sắp hết hạn → nên gia hạn và gửi lại cookie. */
  shouldRenew: boolean;
}

export async function resolveSession(env: Env, token: string): Promise<ResolvedSession | null> {
  if (!token) return null;
  const id = await sha256Hex(token);
  const t = now();
  const row = await env.DB.prepare(
    `SELECT s.id, s.expires_at, s.absolute_exp,
            u.id AS user_id, u.email, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?1 AND s.expires_at > ?2 AND s.absolute_exp > ?2 AND u.status = 'active'`,
  )
    .bind(id, t)
    .first<{
      id: string;
      expires_at: number;
      absolute_exp: number;
      user_id: string;
      email: string;
      display_name: string | null;
    }>();
  if (!row) return null;
  return {
    user: { id: row.user_id, email: row.email, display_name: row.display_name },
    session: { id: row.id, expires_at: row.expires_at, absolute_exp: row.absolute_exp },
    shouldRenew: row.expires_at - t < RENEW_WHEN_REMAINING_MS,
  };
}

/** Đẩy hạn nhàn rỗi nhưng không bao giờ vượt quá trần cứng. */
export async function renewSession(env: Env, s: SessionInfo): Promise<number> {
  const t = now();
  const next = Math.min(t + IDLE_TTL_MS, s.absolute_exp);
  await env.DB.prepare(`UPDATE sessions SET expires_at = ?2, last_seen_at = ?3 WHERE id = ?1`)
    .bind(s.id, next, t)
    .run();
  return next;
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?1`).bind(sessionId).run();
}

/** Đăng xuất mọi thiết bị; giữ lại phiên hiện tại nếu truyền keepSessionId. */
export async function revokeAllSessions(
  env: Env,
  userId: string,
  keepSessionId?: string,
): Promise<number> {
  const res = keepSessionId
    ? await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND id <> ?2`)
        .bind(userId, keepSessionId)
        .run()
    : await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(userId).run();
  return res.meta.changes ?? 0;
}

/**
 * Dọn phiên hết hạn. Pages không có cron, nên hàm này được gọi hai đường:
 * cơ hội (~0,5% số request, qua waitUntil) và định kỳ từ /api/admin/cron.
 */
export async function sweepExpiredSessions(env: Env, limit = 200): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM sessions
      WHERE id IN (SELECT id FROM sessions WHERE expires_at < ?1 OR absolute_exp < ?1 LIMIT ?2)`,
  )
    .bind(now(), limit)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Ghi nhịp tim của cron. Một cron chết âm thầm thì không có dấu hiệu gì, nên trạng
 * thái phải nằm ở nơi ứng dụng tự đọc được — /api/health báo ra `cron_last_run_at`
 * và `cron_stale`, biến một hỏng hóc vô hình thành một con số nhìn thấy được.
 */
export async function recordCronRun(
  env: Env,
  counts: { sessions: number; rate: number; vector: number; reindexed: number },
  source: 'cron' | 'manual',
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cron_runs (id, ran_at, sessions_gc, rate_gc, vector_gc, reindexed, source)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(id) DO UPDATE SET
       ran_at = ?1, sessions_gc = ?2, rate_gc = ?3, vector_gc = ?4, reindexed = ?5, source = ?6`,
  )
    .bind(now(), counts.sessions, counts.rate, counts.vector, counts.reindexed, source)
    .run();
}
