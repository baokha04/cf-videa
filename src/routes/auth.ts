import type { Ctx } from '../http/guard';
import { clientIp, pathParam, readJson, requireSession, requireUser } from '../http/guard';
import { badRequest, unauthorized } from '../http/response';
import { clearCookie, serializeCookie } from '../http/cookies';
import * as usersDb from '../db/users';
import { dummyHash, hashPassword, verifyPassword } from '../auth/password';
import {
  COOKIE_MAX_AGE_SEC,
  createSession,
  revokeAllSessions,
  revokeSession,
  sweepExpiredSessions,
} from '../auth/session';
import { enforce, LIMITS, reset } from '../auth/ratelimit';
import { checkPassword, normalizeEmail, normText } from '../util/validate';
import type { SessionUser } from '../types';

/**
 * Thông điệp lỗi đăng nhập DUY NHẤT một dạng, dùng cho cả ba trường hợp:
 * email không tồn tại, sai mật khẩu, tài khoản bị khoá. Kèm với băm giả ở nhánh
 * "không tìm thấy", điều này khiến không thể dò xem email nào đã đăng ký.
 */
const GENERIC_AUTH_ERROR = 'Email hoặc mật khẩu không đúng.';

function userDto(u: { id: string; email: string; display_name: string | null }): SessionUser {
  return { id: u.id, email: u.email, display_name: u.display_name };
}

function setSessionCookie(c: Ctx, token: string): void {
  c.header('Set-Cookie', serializeCookie(c.env.COOKIE_NAME, token, {
    maxAge: COOKIE_MAX_AGE_SEC,
  }));
}

export async function register(c: Ctx): Promise<Response> {
  const ip = clientIp(c);
  await enforce(c.env, `register:ip:${ip}`, LIMITS.registerIp,
    'Bạn đã đăng ký quá nhiều lần. Vui lòng thử lại sau.');

  const body = await readJson(c);
  const email = normalizeEmail(body['email']);
  const password = checkPassword(body['password']);
  const displayName = normText(body['display_name'], 80, 'display_name') || null;

  const hash = await hashPassword(password);
  const user = await usersDb.insert(c.env, email, hash, displayName);
  if (!user) {
    // Email đã tồn tại. Trả đúng thông điệp như đăng nhập sai, không xác nhận
    // email đã có tài khoản.
    throw badRequest('invalid_credentials', GENERIC_AUTH_ERROR);
  }

  const { token } = await createSession(c.env, user.id, {
    ip,
    userAgent: c.req.header('User-Agent'),
  });
  setSessionCookie(c, token);
  return c.json({ user: userDto(user) }, 201);
}

export async function login(c: Ctx): Promise<Response> {
  const ip = clientIp(c);
  const body = await readJson(c);
  const email = normalizeEmail(body['email']);
  const password = typeof body['password'] === 'string' ? (body['password'] as string) : '';

  const ipBucket = `login:ip:${ip}`;
  const emailBucket = `login:email:${email}`;
  await enforce(c.env, ipBucket, LIMITS.loginIp,
    'Quá nhiều lần thử từ địa chỉ này. Vui lòng thử lại sau ít phút.');
  await enforce(c.env, emailBucket, LIMITS.loginEmail,
    'Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ít phút.');

  const user = await usersDb.findByEmail(c.env, email);
  if (!user || user.status !== 'active') {
    // Vẫn tốn đúng chừng ấy CPU để thời gian phản hồi không tiết lộ điều gì.
    await dummyHash(password || 'x');
    throw badRequest('invalid_credentials', GENERIC_AUTH_ERROR);
  }

  const { ok, needsRehash } = await verifyPassword(password, user.password_hash);
  if (!ok) throw badRequest('invalid_credentials', GENERIC_AUTH_ERROR);

  // Nâng tham số băm trong im lặng khi hàng cũ dùng số vòng thấp hơn hiện tại.
  if (needsRehash) {
    const fresh = await hashPassword(password);
    c.executionCtx.waitUntil(usersDb.updatePasswordHash(c.env, user.id, fresh, false));
  }

  await reset(c.env, [ipBucket, emailBucket]);
  const { token } = await createSession(c.env, user.id, {
    ip,
    userAgent: c.req.header('User-Agent'),
  });
  setSessionCookie(c, token);

  // Pages không có cron: dọn phiên hết hạn theo kiểu cơ hội, ngoài luồng phản hồi.
  if (Math.random() < 0.05) {
    c.executionCtx.waitUntil(sweepExpiredSessions(c.env).then(() => undefined));
  }
  return c.json({ user: userDto(user) });
}

export async function logout(c: Ctx): Promise<Response> {
  const session = c.get('session');
  if (session) await revokeSession(c.env, session.id);
  c.header('Set-Cookie', clearCookie(c.env.COOKIE_NAME));
  return c.body(null, 204);
}

export async function me(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const session = requireSession(c);
  return c.json({ user, session: { expires_at: session.expires_at } });
}

export async function changePassword(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const session = requireSession(c);
  const body = await readJson(c);

  const current = typeof body['current_password'] === 'string'
    ? (body['current_password'] as string) : '';
  const next = checkPassword(body['new_password']);

  const row = await usersDb.findById(c.env, user.id);
  if (!row) throw unauthorized();

  const { ok } = await verifyPassword(current, row.password_hash);
  if (!ok) throw badRequest('invalid_credentials', 'Mật khẩu hiện tại không đúng.');
  if (current === next) {
    throw badRequest('invalid_password', 'Mật khẩu mới phải khác mật khẩu hiện tại.');
  }

  await usersDb.updatePasswordHash(c.env, user.id, await hashPassword(next), true);
  // Thu hồi mọi phiên khác — đây là điểm chính khiến phiên có trạng thái trong D1
  // đáng giá hơn JWT không trạng thái.
  const revoked = await revokeAllSessions(c.env, user.id, session.id);
  return c.json({ revoked_sessions: revoked });
}

export async function listSessions(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const current = requireSession(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, last_seen_at, expires_at, user_agent
       FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC LIMIT 50`,
  )
    .bind(user.id)
    .all<{
      id: string;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
      user_agent: string | null;
    }>();
  return c.json({
    sessions: results.map((s) => ({ ...s, current: s.id === current.id })),
  });
}

export async function revokeOne(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const id = pathParam(c, 'id');
  // Ràng buộc user_id ngay trong câu lệnh: không thể thu hồi phiên của người khác.
  await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?1 AND user_id = ?2`)
    .bind(id, user.id)
    .run();
  return c.body(null, 204);
}

export async function revokeAll(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const session = requireSession(c);
  const revoked = await revokeAllSessions(c.env, user.id, session.id);
  return c.json({ revoked_sessions: revoked });
}
