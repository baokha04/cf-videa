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

/**
 * `appEnv` chỉ để quyết định có đính kèm chi tiết lỗi hay không.
 * Trên production KHÔNG BAO GIỜ trả chi tiết ra ngoài — chỉ log. Trên dev/preview
 * thì có, vì `wrangler tail` không phải lúc nào cũng dùng được (mạng bị chặn, CI,
 * môi trường có policy egress) và khi đó lỗi 500 câm là thứ không thể chẩn đoán.
 */
export function errorResponse(err: unknown, appEnv?: string): Response {
  const e =
    err instanceof ApiError
      ? err
      : new ApiError(500, 'internal_error', 'Có lỗi xảy ra, vui lòng thử lại.');

  const body: Record<string, unknown> = { error: { code: e.code, message: e.message } };

  if (!(err instanceof ApiError)) {
    console.error('unhandled error', err);
    if (appEnv && appEnv !== 'production') {
      const detail = err instanceof Error ? err : new Error(String(err));
      (body['error'] as Record<string, unknown>)['debug'] = {
        name: detail.name,
        message: detail.message,
        stack: detail.stack?.split('\n').slice(0, 6).join('\n'),
      };
    }
  }

  return new Response(JSON.stringify(body), {
    status: e.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(e.headers ?? {}),
    },
  });
}
