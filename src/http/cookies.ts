export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface CookieOpts {
  /**
   * Bỏ trống = cookie PHIÊN: trình duyệt tự xoá khi đóng. Đó là hành vi cố ý cho
   * trường hợp không chọn "ghi nhớ đăng nhập", không phải quên đặt.
   */
  maxAge?: number;
  path?: string;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

/**
 * Cookie phiên luôn dùng tiền tố `__Host-`, nghĩa là trình duyệt CHỈ chấp nhận khi
 * có Secure, Path=/ và không có Domain — chặn được cố định cookie từ subdomain.
 * Vì vậy không được bỏ `Secure` khi dev: localhost là secure context nên vẫn chạy.
 */
export function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const { maxAge, path = '/', sameSite = 'Lax' } = opts;
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`,
  ];
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
}

/** Xoá cookie: thuộc tính phải khớp hệt lúc đặt, nếu không trình duyệt bỏ qua. */
export function clearCookie(name: string): string {
  return serializeCookie(name, '', { maxAge: 0 });
}
