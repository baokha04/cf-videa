import { bytesToB64url, b64urlToBytes, randomBytes } from '../util/b64';
import { constantTimeEqual } from '../util/hash';

/**
 * Băm mật khẩu bằng PBKDF2 qua WebCrypto — không cần nodejs_compat, và không dùng
 * bcrypt/argon2 vì cả hai là native binding, không chạy được trên workerd.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * HAI RÀNG BUỘC QUYẾT ĐỊNH THAM SỐ NÀY, VÀ CHÚNG SIẾT TỪ HAI PHÍA
 *
 * (1) workerd CHẶN CỨNG số vòng PBKDF2 ở 100.000. Vượt qua sẽ ném thẳng:
 *
 *       NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *       supported (requested 210000).
 *
 *     Không phải giới hạn theo gói cước — nâng gói cũng không gỡ được.
 *
 * (2) Gói Workers FREE giới hạn ~10ms CPU mỗi lần gọi, và PBKDF2 là CPU thuần.
 *     Vượt qua thì Cloudflare ngắt request với `Error 1102: Worker exceeded
 *     resource limits`. Cái bẫy ở đây: nó KHÔNG hỏng ngay từ request đầu. Đo trên
 *     production, bản dùng SHA-512 100.000 vòng (66ms) chạy trót lọt 18–21 lần
 *     đăng nhập liên tiếp rồi mới bung 1102 — nghĩa là kiểm thử lẻ tẻ hoàn toàn
 *     không phát hiện được, chỉ tải liên tục mới lộ ra.
 *
 * Số đo thực tế (`node scripts/bench-pbkdf2.mjs`), mỗi lần băm:
 *
 *     SHA-256   20.000 vòng →  ~4 ms
 *     SHA-256   30.000 vòng →  ~7 ms   ← ĐANG DÙNG
 *     SHA-256   50.000 vòng →  ~12 ms  vượt ngân sách Free
 *     SHA-512  100.000 vòng →  ~66 ms  vượt xa, gây Error 1102
 *
 * MỨC BẢO VỆ THỰC TẾ, NÓI THẲNG: OWASP khuyến nghị 600.000 vòng cho
 * PBKDF2-HMAC-SHA256. Cấu hình này thấp hơn khoảng 20 lần. Đây là lựa chọn có ý
 * thức để ở lại gói Free, không phải sơ suất. Mật khẩu vẫn có salt ngẫu nhiên
 * riêng, vẫn được kéo dài, và vẫn hơn hẳn hash trần — nhưng nếu database bị lộ
 * thì mật khẩu yếu sẽ bị dò ra nhanh hơn nhiều so với một hệ thống đúng chuẩn.
 *
 * Hai lớp bù đắp đang có: mật khẩu tối thiểu 10 ký tự (src/util/validate.ts) và
 * rate limit đăng nhập (src/auth/ratelimit.ts). Cả hai chỉ chặn dò trực tuyến;
 * không lớp nào giúp được khi kẻ tấn công đã có bản dump database.
 *
 * MUỐN MẠNH HƠN: nâng lên Workers Paid (hạn mức CPU 30 giây) rồi đổi hai hằng số
 * dưới đây thành SHA-512 / 100.000 vòng. KHÔNG cần migration: cả hàm băm lẫn số
 * vòng nằm trong từng chuỗi hash, verifyPassword đọc tham số của từng hàng, và
 * lần đăng nhập thành công kế tiếp sẽ tự băm lại theo mức mới.
 * ───────────────────────────────────────────────────────────────────────────────
 */

/** Trần cứng của workerd. Đặt cao hơn sẽ ném NotSupportedError khi chạy thật. */
export const WORKERD_MAX_ITERATIONS = 100_000;

/**
 * Chọn cho ngân sách CPU ~10ms của gói Workers Free. Nâng lên Paid thì đổi thành
 * `WORKERD_MAX_ITERATIONS` + `'SHA-512'` — xem phần giải thích ở trên.
 */
export const PBKDF2_ITERATIONS = 30_000;
export const PBKDF2_HASH = 'SHA-256' as const;

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
  // Băm lại khi tham số của hàng KHÁC cấu hình hiện tại — theo cả hai chiều.
  //
  // Thường thì đó là nâng cấp. Nhưng ở đây ràng buộc quyết định là ngân sách CPU
  // của nền tảng, không phải "càng mạnh càng tốt": một hàng còn giữ tham số cũ đắt
  // hơn ngân sách hiện tại sẽ khiến chính người dùng đó gặp Error 1102 khi đăng
  // nhập nhiều lần. Nên mục tiêu là mọi hàng hội tụ về đúng cấu hình đang chạy.
  const differs = iterations !== PBKDF2_ITERATIONS || hash !== PBKDF2_HASH;
  return { ok, needsRehash: ok && differs };
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
