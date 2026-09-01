import { bytesToB64url, b64urlToBytes, randomBytes } from '../util/b64';
import { constantTimeEqual } from '../util/hash';

/**
 * Băm mật khẩu bằng PBKDF2-HMAC-SHA256 qua WebCrypto — không cần nodejs_compat,
 * không cần bcrypt/argon2 (cả hai đều là native binding, không chạy trên workerd).
 *
 * ĐÁNH ĐỔI CPU — ĐỌC TRƯỚC KHI CHỈNH SỐ.
 *
 * Workers/Pages tính CPU time, và PBKDF2 là CPU thuần. Số đo thực tế trên WebCrypto
 * (chạy `node scripts/bench-pbkdf2.mjs`), mỗi lần băm:
 *
 *      50.000 vòng  →   ~9 ms
 *     100.000 vòng  →  ~18 ms
 *     210.000 vòng  →  ~37 ms   ← mức đang dùng (khuyến nghị OWASP)
 *     600.000 vòng  →  ~106 ms
 *
 * Nghĩa là: mức này cần GÓI WORKERS PAID (hạn mức CPU mặc định 30 giây). Trên gói
 * Free (10 ms CPU mỗi lần gọi) thì ngay cả 50.000 vòng cũng đã sát trần và đăng
 * nhập sẽ bị ngắt. Không có cách nào làm một hàm băm mật khẩu đúng chuẩn mà rẻ —
 * đó chính là mục đích của nó.
 *
 * Nếu buộc phải chạy gói Free: hạ số vòng xuống và GHI RÕ đánh đổi trong README.
 * Tuyệt đối không thay bằng SHA-256 trần hay MD5 — đó không phải giải pháp.
 *
 * Số vòng được nhúng vào chuỗi hash nên đây là hằng số chỉnh được, không phải cam
 * kết kiến trúc: verifyPassword() đọc số vòng của từng hàng, và đăng nhập thành công
 * với số vòng cũ sẽ tự băm lại theo mức hiện tại.
 */
export const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'pbkdf2$sha256';

const enc = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Trả về `pbkdf2$sha256$<iters>$<salt_b64url>$<hash_b64url>`. */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const dk = await derive(password, salt, iterations);
  return `${PREFIX}$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(dk)}`;
}

export interface VerifyResult {
  /** Mật khẩu có khớp không. */
  ok: boolean;
  /** true khi hash lưu trong DB dùng số vòng thấp hơn mức hiện tại → nên băm lại. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parts = stored.split('$');
  // pbkdf2 | sha256 | iters | salt | hash
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') {
    return { ok: false, needsRehash: false };
  }
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 5_000_000) {
    return { ok: false, needsRehash: false };
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64urlToBytes(parts[3] as string);
    expected = b64urlToBytes(parts[4] as string);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const actual = await derive(password, salt, iterations);
  const ok = constantTimeEqual(actual, expected);
  return { ok, needsRehash: ok && iterations < PBKDF2_ITERATIONS };
}

/**
 * Băm giả với cùng chi phí, chạy trên nhánh "không tìm thấy email".
 * Mục đích: thời gian phản hồi khi email không tồn tại phải tương đương khi
 * email tồn tại nhưng sai mật khẩu — nếu không, kẻ tấn công dò được email nào
 * đã đăng ký chỉ bằng cách bấm giờ.
 */
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
export async function dummyHash(password: string): Promise<void> {
  await derive(password, DUMMY_SALT, PBKDF2_ITERATIONS);
}
