import type { Env, SessionInfo, SessionUser } from '../types';
import { bytesToB64url, randomBytes } from '../util/b64';
import { sha256Hex } from '../util/hash';
import { now } from '../util/id';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Hai cấu hình phiên, chọn bằng ô "Ghi nhớ đăng nhập" lúc đăng nhập.
 *
 *  remember = true  → phiên 30 ngày, cookie CÓ Max-Age nên sống qua lần đóng trình
 *                     duyệt. Dành cho máy riêng.
 *  remember = false → phiên 12 giờ, cookie KHÔNG có Max-Age nên là cookie phiên và
 *                     trình duyệt tự xoá khi đóng. Dành cho máy dùng chung.
 *
 * Cả hai đều có trần cứng 90 ngày tính từ lúc tạo, không bao giờ gia hạn.
 */
export const IDLE_TTL_REMEMBER_MS = 30 * DAY;
export const IDLE_TTL_SESSION_MS = 12 * HOUR;
export const ABSOLUTE_TTL_MS = 90 * DAY;

/** Còn dưới tỉ lệ này của hạn nhàn rỗi thì gia hạn — để không phải UPDATE mỗi request. */
const RENEW_WHEN_REMAINING_RATIO = 0.5;

export function idleTtl(remember: boolean): number {
  return remember ? IDLE_TTL_REMEMBER_MS : IDLE_TTL_SESSION_MS;
}

/**
 * Max-Age cho cookie, tính bằng giây. Trả về undefined khi KHÔNG ghi nhớ: cookie
 * thiếu Max-Age là cookie phiên, trình duyệt xoá lúc đóng — đó chính là hành vi mong
 * muốn, không phải thiếu sót.
 */
export function cookieMaxAge(remember: boolean): number | undefined {
  return remember ? Math.floor(IDLE_TTL_REMEMBER_MS / 1000) : undefined;
}

/**
 * Token là 32 byte ngẫu nhiên (256 bit). D1 chỉ lưu sha256(token): một bản dump
 * database không cho phép mạo danh phiên nào cả.
 */
export async function createSession(
  env: Env,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null; remember?: boolean },
): Promise<{ token: string; session: SessionInfo }> {
  const token = bytesToB64url(randomBytes(32));
  const id = await sha256Hex(token);
  const t = now();
  const remember = meta.remember ?? false;
  const session: SessionInfo = {
    id,
    expires_at: t + idleTtl(remember),
    absolute_exp: t + ABSOLUTE_TTL_MS,
    remember,
  };
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, absolute_exp, last_seen_at,
                           ip, user_agent, remember)
     VALUES (?1, ?2, ?3, ?4, ?5, ?3, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      userId,
      t,
      session.expires_at,
      session.absolute_exp,
      meta.ip ?? null,
      (meta.userAgent ?? '').slice(0, 256) || null,
      remember ? 1 : 0,
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
    `SELECT s.id, s.expires_at, s.absolute_exp, s.remember,
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
      remember: number;
      user_id: string;
      email: string;
      display_name: string | null;
    }>();
  if (!row) return null;
  const remember = row.remember === 1;
  return {
    user: { id: row.user_id, email: row.email, display_name: row.display_name },
    session: {
      id: row.id,
      expires_at: row.expires_at,
      absolute_exp: row.absolute_exp,
      remember,
    },
    // Ngưỡng theo TỈ LỆ chứ không phải hằng số: phiên 12 giờ mà dùng ngưỡng 7 ngày
    // thì lần request nào cũng gia hạn, tức là một lần ghi D1 thừa cho mỗi request.
    shouldRenew: row.expires_at - t < idleTtl(remember) * RENEW_WHEN_REMAINING_RATIO,
  };
}

/** Đẩy hạn nhàn rỗi nhưng không bao giờ vượt quá trần cứng. */
export async function renewSession(env: Env, s: SessionInfo): Promise<number> {
  const t = now();
  const next = Math.min(t + idleTtl(s.remember), s.absolute_exp);
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
 * Dọn phiên hết hạn. Pages Functions không có cron trigger và dự án cố ý không dùng
 * Worker riêng để có, nên hàm này chạy theo kiểu cơ hội trên một phần nhỏ số lần
 * đăng nhập (qua waitUntil), hoặc khi gọi tay POST /api/admin/maintenance.
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
 * Ghi lại lần bảo trì gần nhất. Không có lịch chạy nghĩa là không có cách nào biết
 * việc dọn dẹp còn diễn ra hay đã ngừng, trừ khi ứng dụng tự ghi lại — /api/health
 * đọc ra `maintenance_last_run_at`, biến một trạng thái vô hình thành con số.
 *
 * `source`: 'auto' = dọn cơ hội khi đăng nhập, 'manual' = gọi /api/admin/maintenance.
 */
export async function recordMaintenanceRun(
  env: Env,
  counts: { sessions: number; rate: number; vector: number; reindexed: number },
  source: 'auto' | 'manual',
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO maintenance_runs (id, ran_at, sessions_gc, rate_gc, vector_gc, reindexed, source)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(id) DO UPDATE SET
       ran_at = ?1, sessions_gc = ?2, rate_gc = ?3, vector_gc = ?4, reindexed = ?5, source = ?6`,
  )
    .bind(now(), counts.sessions, counts.rate, counts.vector, counts.reindexed, source)
    .run();
}
