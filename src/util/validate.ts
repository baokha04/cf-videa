import { badRequest } from '../http/response';

/**
 * Validator viết tay thay vì zod: bundle của Pages Function nhỏ hơn, và bộ quy tắc
 * ở đây đủ hẹp để không cần cả một thư viện schema.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD_LEN = 10;
export const MAX_PASSWORD_LEN = 200;

/** Danh sách ngắn các mật khẩu bị lộ nhiều nhất — chặn thẳng, rẻ và hiệu quả. */
const COMMON_PASSWORDS = new Set([
  '1234567890', 'password123', 'qwertyuiop', '123456789012', 'matkhau123',
  'iloveyou123', 'administrator', '111111111111', 'abcd123456', 'password1234',
  '0123456789', 'letmein1234', 'welcome1234', '1q2w3e4r5t', 'zaq12wsxcde3',
]);

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('invalid_email', 'Email không hợp lệ.');
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw badRequest('invalid_email', 'Email không hợp lệ.');
  }
  return email;
}

export function checkPassword(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw badRequest('invalid_password', 'Mật khẩu không hợp lệ.');
  }
  if (raw.length < MIN_PASSWORD_LEN) {
    throw badRequest(
      'invalid_password',
      `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LEN} ký tự.`,
    );
  }
  // Chặn trên để giới hạn đầu vào của PBKDF2 (chi phí băm tỉ lệ với độ dài input).
  if (raw.length > MAX_PASSWORD_LEN) {
    throw badRequest('invalid_password', `Mật khẩu tối đa ${MAX_PASSWORD_LEN} ký tự.`);
  }
  if (COMMON_PASSWORDS.has(raw.toLowerCase())) {
    throw badRequest('invalid_password', 'Mật khẩu này quá phổ biến, hãy chọn mật khẩu khác.');
  }
  return raw;
}

/**
 * Chuẩn hoá NFC cho văn bản tiếng Việt: "ế" gõ sẵn và "ế" ghép từ hai ký tự trông
 * giống hệt nhau nhưng khác byte, và nếu không chuẩn hoá thì hai bản sẽ cho ra hai
 * content_hash khác nhau — tức là embed lại vô ích, và tag bị trùng lặp.
 */
export function normText(raw: unknown, maxLen: number, field: string): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw badRequest('invalid_field', `Trường ${field} không hợp lệ.`);
  const s = raw.normalize('NFC').trim();
  if (s.length > maxLen) {
    throw badRequest('invalid_field', `Trường ${field} tối đa ${maxLen} ký tự.`);
  }
  return s;
}

export function requiredText(raw: unknown, maxLen: number, field: string): string {
  const s = normText(raw, maxLen, field);
  if (!s) throw badRequest('invalid_field', `Trường ${field} không được để trống.`);
  return s;
}

export function oneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
  fallback?: T,
): T {
  if (raw === undefined || raw === null || raw === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest('invalid_field', `Trường ${field} không được để trống.`);
  }
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw badRequest('invalid_field', `Trường ${field} phải là một trong: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

export function parseTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('invalid_field', 'Trường tags phải là một mảng.');
  if (raw.length > 20) throw badRequest('invalid_field', 'Tối đa 20 tag cho mỗi ý tưởng.');
  const seen = new Set<string>();
  for (const t of raw) {
    const name = normText(t, 50, 'tags').toLowerCase();
    if (name) seen.add(name);
  }
  return [...seen];
}

export function clampLimit(raw: string | null, def = 20, max = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}
