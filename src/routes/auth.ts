import type { Ctx } from '../http/guard';
import { clientIp, pathParam, readJson, requireSession, requireUser } from '../http/guard';
import { ApiError, badRequest, unauthorized } from '../http/response';
import { clearCookie, serializeCookie } from '../http/cookies';
import * as usersDb from '../db/users';
import { dummyHash, hashPassword, verifyPassword } from '../auth/password';
import {
  cookieMaxAge,
  createSession,
  revokeAllSessions,
  recordMaintenanceRun,
  revokeSession,
  sweepExpiredSessions,
} from '../auth/session';
import { enforce, LIMITS, reset, sweepRateLimits } from '../auth/ratelimit';
import { drainVectorGc } from '../vec/sync';
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

function setSessionCookie(c: Ctx, token: string, remember: boolean): void {
  c.header(
    'Set-Cookie',
    serializeCookie(c.env.COOKIE_NAME, token, { maxAge: cookieMaxAge(remember) }),
  );
}

/** Chỉ đúng `true` mới bật ghi nhớ — mọi giá trị lạ đều coi là không. */
function wantsRemember(body: Record<string, unknown>): boolean {
  return body['remember'] === true;
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

  // Đăng ký mặc định ghi nhớ: người vừa tự tạo tài khoản gần như luôn ở máy riêng,
  // và bắt họ đăng nhập lại ngay sau khi đăng ký là vô lý.
  const remember = body['remember'] === undefined ? true : wantsRemember(body);
  const { token } = await createSession(c.env, user.id, {
    ip,
    userAgent: c.req.header('User-Agent'),
    remember,
  });
  setSessionCookie(c, token, remember);
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

  let user: Awaited<ReturnType<typeof usersDb.findByEmail>>;
  let needsRehash = false;
  try {
    user = await usersDb.findByEmail(c.env, email);
    if (!user || user.status !== 'active') {
      // Vẫn tốn đúng chừng ấy CPU để thời gian phản hồi không tiết lộ điều gì.
      await dummyHash(password || 'x');
      throw badRequest('invalid_credentials', GENERIC_AUTH_ERROR);
    }
    const res = await verifyPassword(password, user.password_hash);
    if (!res.ok) throw badRequest('invalid_credentials', GENERIC_AUTH_ERROR);
    needsRehash = res.needsRehash;
  } catch (err) {
    // Bộ đếm rate limit đã tăng ở trên nhưng chỉ được xoá khi đăng nhập thành công.
    // Nếu hỏng vì LỖI CỦA SERVER (D1 trục trặc, Worker bị ngắt) thì người dùng không
    // có lỗi gì mà vẫn bị ăn vào hạn mức — và vài lần như vậy là bị khoá oan.
    // Sai mật khẩu thì vẫn tính, vì đó đúng là một lần thử.
    if (!(err instanceof ApiError)) {
      await reset(c.env, [ipBucket, emailBucket]).catch(() => {});
    }
    throw err;
  }

  // Băm lại trong im lặng khi tham số của hàng khác cấu hình hiện tại.
  if (needsRehash) {
    const fresh = await hashPassword(password);
    c.executionCtx.waitUntil(usersDb.updatePasswordHash(c.env, user.id, fresh, false));
  }

  await reset(c.env, [ipBucket, emailBucket]);
  const remember = wantsRemember(body);
  const { token } = await createSession(c.env, user.id, {
    ip,
    userAgent: c.req.header('User-Agent'),
    remember,
  });
  setSessionCookie(c, token, remember);

  // Pages Functions không có cron trigger, và dự án cố ý KHÔNG dựng Worker riêng chỉ
  // để có lịch. Thay vào đó, việc dọn dẹp bám theo chính lưu lượng: khoảng 5% số lần
  // đăng nhập kéo theo một lượt dọn, chạy ngoài luồng phản hồi qua waitUntil.
  //
  // Ba bảng này phình ra vô hạn nếu không ai dọn: phiên đã hết hạn, bộ đếm rate limit
  // của các cửa sổ đã qua, và hàng đợi vector mồ côi. Việc index ý tưởng thì KHÔNG nằm
  // ở đây — nó do người dùng bấm nút "Đồng bộ lại index", vì đó là việc họ nhìn thấy
  // kết quả và biết khi nào cần.
  if (Math.random() < 0.05) {
    c.executionCtx.waitUntil(sweepInBackground(c.env));
  }
  return c.json({ user: userDto(user) });
}

/**
 * Một lượt dọn cơ hội. Ghi lại kết quả vào maintenance_runs để /api/health cho biết
 * việc bảo trì lần cuối chạy khi nào — không có lịch thì đó là cách duy nhất để biết
 * nó còn diễn ra hay đã ngừng.
 */
async function sweepInBackground(env: Ctx['env']): Promise<void> {
  const [sessions, rate, vector] = await Promise.allSettled([
    sweepExpiredSessions(env),
    sweepRateLimits(env),
    drainVectorGc(env, 50),
  ]);
  const n = (r: PromiseSettledResult<number>) => (r.status === 'fulfilled' ? r.value : 0);
  await recordMaintenanceRun(
    env,
    { sessions: n(sessions), rate: n(rate), vector: n(vector), reindexed: 0 },
    'auto',
  ).catch((err) => console.error('recordMaintenanceRun failed', err));
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
  return c.json({
    user,
    session: { expires_at: session.expires_at, remember: session.remember },
  });
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
    `SELECT id, created_at, last_seen_at, expires_at, user_agent, remember
       FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC LIMIT 50`,
  )
    .bind(user.id)
    .all<{
      id: string;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
      user_agent: string | null;
      remember: number;
    }>();
  return c.json({
    sessions: results.map((s) => ({
      ...s,
      remember: s.remember === 1,
      current: s.id === current.id,
    })),
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
