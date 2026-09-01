import type { Context } from 'hono';
import type { Env, SessionInfo, SessionUser, Variables } from '../types';
import { badRequest, forbidden, notFound, unauthorized } from './response';
import { constantTimeEqualStr } from '../util/hash';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Middleware KHÔNG tự trả 401 — nó chỉ nạp user rồi cho qua, vì các route công khai
 * (đăng nhập, đăng ký, health) đi qua cùng middleware đó. Mỗi route tự gọi hàm này.
 * Route nào quên gọi thì vẫn fail-closed, bởi mọi truy vấn DB đều đòi userId.
 */
export function requireUser(c: Ctx): SessionUser {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function requireSession(c: Ctx): SessionInfo {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Phòng CSRF. Cookie đã SameSite=Lax nên trình duyệt không gửi nó theo request
 * thay đổi dữ liệu từ site khác, và app không phát header CORS nào nên fetch
 * cross-origin kèm credentials cũng bị chặn. Hai lớp dưới đây bịt phần còn lại:
 *
 *  1. Origin/Sec-Fetch-Site phải khớp deployment — đây mới là lớp phòng thủ thật.
 *  2. Bắt buộc Content-Type: application/json — một form HTML thường không tạo ra
 *     được header này mà không kích hoạt preflight.
 *
 * Quy tắc đi kèm, không được vi phạm: KHÔNG endpoint GET nào được thay đổi dữ liệu,
 * vì SameSite=Lax VẪN gửi cookie theo điều hướng GET ở cấp cao nhất.
 */
export function checkOrigin(c: Ctx): void {
  const method = c.req.method.toUpperCase();
  if (!MUTATING.has(method)) return;

  const site = c.req.header('Sec-Fetch-Site');
  if (site === 'same-origin' || site === 'none') return;
  if (site && site !== 'same-origin') {
    throw forbidden('Yêu cầu bị từ chối: nguồn gửi không hợp lệ.');
  }

  // Trình duyệt cũ không gửi Sec-Fetch-Site → đối chiếu Origin.
  const origin = c.req.header('Origin');
  if (!origin) throw forbidden('Yêu cầu bị từ chối: thiếu header Origin.');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden('Yêu cầu bị từ chối: Origin không hợp lệ.');
  }
  if (originHost !== new URL(c.req.url).host) {
    throw forbidden('Yêu cầu bị từ chối: nguồn gửi không hợp lệ.');
  }
}

/** Đọc JSON body có giới hạn kích thước, và bắt buộc đúng Content-Type. */
export async function readJson<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  const ct = c.req.header('Content-Type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw badRequest('invalid_content_type', 'Content-Type phải là application/json.');
  }
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    throw badRequest('body_too_large', 'Dữ liệu gửi lên quá lớn.');
  }
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw badRequest('body_too_large', 'Dữ liệu gửi lên quá lớn.');
  }
  try {
    const parsed = JSON.parse(text || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as T;
  } catch {
    throw badRequest('invalid_json', 'Dữ liệu JSON không hợp lệ.');
  }
}

/**
 * Route quản trị dùng ADMIN_TOKEN (Pages secret), không bao giờ dùng phiên người dùng.
 * Kèm kiểm tra Sec-Fetch-Site để một quản trị viên đang đăng nhập không thể bị dụ
 * vào chạy reindex qua CSRF.
 */
export function requireAdmin(c: Ctx): void {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) throw forbidden('Chức năng quản trị chưa được cấu hình.');
  const site = c.req.header('Sec-Fetch-Site');
  if (site && site !== 'none') {
    throw forbidden('Yêu cầu quản trị phải gửi từ ngoài trình duyệt.');
  }
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !constantTimeEqualStr(token, expected)) {
    throw forbidden('Token quản trị không hợp lệ.');
  }
}

export function clientIp(c: Ctx): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown';
}

/**
 * `c.req.param()` khai báo trả về `string | undefined`. Với route đã có tham số
 * trong đường dẫn thì undefined là bất khả thi, nhưng ép kiểu bằng `!` sẽ giấu mất
 * lỗi thật nếu ai đó đổi pattern của route — nên chuyển thành 404 tường minh.
 */
export function pathParam(c: Ctx, name: string): string {
  const v = c.req.param(name);
  if (!v) throw notFound('Không tìm thấy.');
  return v;
}
