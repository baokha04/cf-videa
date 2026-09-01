/** Lỗi API có mã ổn định để client bắt, kèm thông điệp tiếng Việt cho người dùng. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, msg: string) => new ApiError(400, code, msg);
export const unauthorized = (msg = 'Bạn cần đăng nhập.') =>
  new ApiError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'Không được phép.') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Không tìm thấy.') => new ApiError(404, 'not_found', msg);
export const tooMany = (msg: string, retryAfter: number) =>
  new ApiError(429, 'rate_limited', msg, { 'Retry-After': String(retryAfter) });

export function errorResponse(err: unknown): Response {
  const e =
    err instanceof ApiError
      ? err
      : new ApiError(500, 'internal_error', 'Có lỗi xảy ra, vui lòng thử lại.');
  if (!(err instanceof ApiError)) {
    // Log để `wrangler tail` thấy được, nhưng không bao giờ trả chi tiết ra ngoài.
    console.error('unhandled error', err);
  }
  return new Response(JSON.stringify({ error: { code: e.code, message: e.message } }), {
    status: e.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(e.headers ?? {}),
    },
  });
}
