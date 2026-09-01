const enc = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * So sánh thời gian hằng định. workerd cung cấp crypto.subtle.timingSafeEqual;
 * fallback XOR dồn giữ cho unit test và runtime khác chạy được.
 * Lưu ý: cả hai nhánh đều rò rỉ ĐỘ DÀI, đó là điều chấp nhận được vì độ dài
 * của hash và của token đều cố định và không bí mật.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function constantTimeEqualStr(a: string, b: string): boolean {
  return constantTimeEqual(enc.encode(a), enc.encode(b));
}
