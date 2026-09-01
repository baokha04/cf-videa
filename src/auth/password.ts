import { bytesToB64url, b64urlToBytes, randomBytes } from '../util/b64';
import { constantTimeEqual } from '../util/hash';

/**
 * Băm mật khẩu bằng PBKDF2 qua WebCrypto — không cần nodejs_compat, và không dùng
 * bcrypt/argon2 vì cả hai là native binding, không chạy được trên workerd.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * RÀNG BUỘC NỀN TẢNG QUYẾT ĐỊNH THIẾT KẾ NÀY
 *
 * workerd CHẶN CỨNG số vòng PBKDF2 ở 100.000. Vượt qua sẽ ném thẳng:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 210000).
 *
 * Đây KHÔNG phải giới hạn theo gói cước — nâng lên Workers Paid cũng không gỡ được.
 * Nó là trần của runtime.
 *
 * Hệ quả: không thể tăng độ khó bằng cách tăng số vòng. Cách duy nhất còn lại là
 * tăng chi phí MỖI VÒNG, tức là chọn hàm băm đắt hơn. Số đo thực tế
 * (`node scripts/bench-pbkdf2.mjs`), mỗi lần băm:
 *
 *     SHA-256, 100.000 vòng  →  ~20 ms
 *     SHA-512, 100.000 vòng  →  ~66 ms   ← đang dùng, gấp ~3,4 lần công
 *
 * Vì vậy dùng SHA-512 ở đúng trần 100.000 vòng. Công bỏ ra tương đương khoảng
 * 340.000 vòng SHA-256.
 *
 * TRUNG THỰC VỀ MỨC BẢO VỆ: OWASP khuyến nghị 600.000 vòng cho PBKDF2-HMAC-SHA256
 * hoặc 210.000 vòng cho PBKDF2-HMAC-SHA512. Trần của workerd khiến cấu hình này
 * chỉ đạt khoảng một nửa mức khuyến nghị cho SHA-512. Đó là mức tốt nhất PBKDF2
 * đạt được trên nền tảng này. Muốn vượt qua thì phải đổi sang Argon2id biên dịch
 * ra WASM — đắt hơn nhiều về công sức và kích thước bundle, chỉ nên làm nếu mô
 * hình đe doạ thực sự đòi hỏi. Bù lại, hệ thống có hai lớp khác: mật khẩu tối
 * thiểu 10 ký tự và rate limit đăng nhập trong src/auth/ratelimit.ts.
 *
 * CHI PHÍ CPU: ~66 ms mỗi lần đăng nhập/đăng ký. Nằm gọn trong hạn mức 30 giây
 * của gói Workers Paid, nhưng vượt hạn mức 10 ms của gói Free — mà ngay cả
 * SHA-256 ở 100.000 vòng (~20 ms) cũng đã vượt. Không có cách nào làm một hàm băm
 * mật khẩu đúng chuẩn mà rẻ; đó chính là mục đích của nó.
 * ───────────────────────────────────────────────────────────────────────────────
 */

/** Trần cứng của workerd. Đặt cao hơn sẽ ném NotSupportedError khi chạy thật. */
export const WORKERD_MAX_ITERATIONS = 100_000;

export const PBKDF2_ITERATIONS = WORKERD_MAX_ITERATIONS;
export const PBKDF2_HASH = 'SHA-512' as const;

const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Các hàm băm chấp nhận được khi ĐỌC hash cũ — cho phép nâng cấp không cần migration. */
const SUPPORTED_HASHES: Record<string, string> = {
  sha256: 'SHA-256',
  sha512: 'SHA-512',
};

const enc = new TextEncoder();

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  hash: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash, salt: salt as BufferSource, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Trả về `pbkdf2$<hash>$<iters>$<salt_b64url>$<hash_b64url>`.
 * Cả hàm băm lẫn số vòng đều nằm TRONG chuỗi, nên đổi tham số về sau không cần
 * migration: verifyPassword đọc tham số của từng hàng, và lần đăng nhập thành công
 * kế tiếp sẽ tự băm lại theo mức hiện tại.
 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
  hash: string = PBKDF2_HASH,
): Promise<string> {
  if (iterations > WORKERD_MAX_ITERATIONS) {
    throw new Error(
      `Số vòng ${iterations} vượt trần ${WORKERD_MAX_ITERATIONS} của workerd; ` +
        'tăng chi phí bằng cách đổi hàm băm, không phải bằng cách tăng số vòng.',
    );
  }
  const salt = randomBytes(SALT_BYTES);
  const dk = await derive(password, salt, iterations, hash);
  const tag = hash.toLowerCase().replace('-', '');
  return `pbkdf2$${tag}$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(dk)}`;
}

export interface VerifyResult {
  /** Mật khẩu có khớp không. */
  ok: boolean;
  /** Hash lưu trong DB dùng tham số yếu hơn mức hiện tại → nên băm lại. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parts = stored.split('$');
  // pbkdf2 | <hash> | <iters> | <salt> | <dk>
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') {
    return { ok: false, needsRehash: false };
  }

  const hash = SUPPORTED_HASHES[parts[1] as string];
  if (!hash) return { ok: false, needsRehash: false };

  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > WORKERD_MAX_ITERATIONS) {
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

  const actual = await derive(password, salt, iterations, hash);
  const ok = constantTimeEqual(actual, expected);
  // Băm lại khi hash cũ dùng ÍT vòng hơn, hoặc dùng hàm băm RẺ hơn mức hiện tại.
  const weaker = iterations < PBKDF2_ITERATIONS || hash !== PBKDF2_HASH;
  return { ok, needsRehash: ok && weaker };
}

/**
 * Băm giả với cùng chi phí, chạy trên nhánh "không tìm thấy email".
 * Mục đích: thời gian phản hồi khi email không tồn tại phải tương đương khi email
 * tồn tại nhưng sai mật khẩu — nếu không, kẻ tấn công dò được email nào đã đăng ký
 * chỉ bằng cách bấm giờ.
 */
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
export async function dummyHash(password: string): Promise<void> {
  await derive(password, DUMMY_SALT, PBKDF2_ITERATIONS, PBKDF2_HASH);
}
