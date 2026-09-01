import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  PBKDF2_ITERATIONS,
  PBKDF2_HASH,
  WORKERD_MAX_ITERATIONS,
} from '../src/auth/password';

/**
 * Băm mật khẩu là nơi một lỗi sẽ IM LẶNG và NGUY HIỂM: băm sai vẫn "chạy được",
 * so sánh sai vẫn cho đăng nhập. Vì thế đây là phần đáng viết test nhất trong
 * toàn bộ dự án.
 */
describe('băm mật khẩu', () => {
  it('băm rồi kiểm tra lại thì khớp', async () => {
    const stored = await hashPassword('matkhau-rat-dai-123', 1000);
    const { ok } = await verifyPassword('matkhau-rat-dai-123', stored);
    expect(ok).toBe(true);
  });

  it('mật khẩu sai thì không khớp', async () => {
    const stored = await hashPassword('matkhau-rat-dai-123', 1000);
    expect((await verifyPassword('matkhau-rat-dai-124', stored)).ok).toBe(false);
    expect((await verifyPassword('', stored)).ok).toBe(false);
    expect((await verifyPassword('matkhau-rat-dai-1234', stored)).ok).toBe(false);
  });

  it('cùng một mật khẩu băm hai lần cho kết quả khác nhau (salt ngẫu nhiên)', async () => {
    const a = await hashPassword('matkhau-rat-dai-123', 1000);
    const b = await hashPassword('matkhau-rat-dai-123', 1000);
    expect(a).not.toBe(b);
    // Nhưng cả hai đều kiểm tra được.
    expect((await verifyPassword('matkhau-rat-dai-123', a)).ok).toBe(true);
    expect((await verifyPassword('matkhau-rat-dai-123', b)).ok).toBe(true);
  });

  it('nhúng cả hàm băm lẫn số vòng vào chuỗi để nâng tham số không cần migration', async () => {
    const stored = await hashPassword('matkhau-rat-dai-123', 1000, 'SHA-512');
    expect(stored.startsWith('pbkdf2$sha512$1000$')).toBe(true);
    const r = await verifyPassword('matkhau-rat-dai-123', stored);
    expect(r.ok).toBe(true);
    // Số vòng thấp hơn mức hiện tại → báo cần băm lại.
    expect(r.needsRehash).toBe(true);
  });

  it('hash dùng tham số khác cấu hình hiện tại đều bị đánh dấu băm lại', async () => {
    // Theo CẢ HAI chiều. Yếu hơn thì rõ rồi. Nhưng mạnh hơn cũng phải băm lại: ràng
    // buộc quyết định ở đây là ngân sách CPU của gói Free, nên một hàng còn giữ
    // tham số cũ đắt hơn sẽ khiến chính người dùng đó gặp Error 1102.
    for (const [iters, hash] of [
      [1000, 'SHA-256'],    // yếu hơn
      [100_000, 'SHA-512'], // MẠNH hơn, nhưng vượt ngân sách CPU
      [30_000, 'SHA-512'],  // cùng số vòng, hàm băm khác
    ] as Array<[number, string]>) {
      const stored = await hashPassword('matkhau-rat-dai-123', iters, hash);
      const r = await verifyPassword('matkhau-rat-dai-123', stored);
      expect(r.ok, `phải kiểm tra được: ${hash}/${iters}`).toBe(true);
      expect(r.needsRehash, `phải đòi băm lại: ${hash}/${iters}`).toBe(true);
    }
  });

  it('hash ở đúng tham số hiện tại thì không đòi băm lại', async () => {
    const stored = await hashPassword('matkhau-rat-dai-123', PBKDF2_ITERATIONS, PBKDF2_HASH);
    const r = await verifyPassword('matkhau-rat-dai-123', stored);
    expect(r.ok).toBe(true);
    expect(r.needsRehash).toBe(false);
  });

  it('KHÔNG cho đặt số vòng vượt trần cứng của workerd', async () => {
    // workerd ném NotSupportedError khi số vòng > 100.000. Chặn sớm ở đây để lỗi
    // lộ ra lúc lập trình, chứ không phải thành 500 trên production.
    expect(WORKERD_MAX_ITERATIONS).toBe(100_000);
    await expect(
      hashPassword('matkhau-rat-dai-123', WORKERD_MAX_ITERATIONS + 1),
    ).rejects.toThrow(/vượt trần/);
  });

  it('tham số hiện tại nằm đúng trong trần nền tảng và thực sự chạy được', async () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(WORKERD_MAX_ITERATIONS);
    // Ngân sách CPU của gói Free là ~10ms. 30.000 vòng SHA-256 đo được ~7ms; vượt
    // qua thì Cloudflare ngắt bằng Error 1102 — và chỉ lộ ra khi đăng nhập liên
    // tục, không lộ ra khi thử lẻ. Chốt trần ở đây để không ai vô tình nâng lên.
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(30_000);
    expect(PBKDF2_HASH).toBe('SHA-256');
    // Chạy thật ở tham số production, trong workerd thật — đây là bài test đáng lẽ
    // đã bắt được lỗi 210.000 vòng trước khi nó lên tới deployment.
    const stored = await hashPassword('matkhau-rat-dai-123');
    expect((await verifyPassword('matkhau-rat-dai-123', stored)).ok).toBe(true);
  });

  it('chuỗi hash hỏng thì trả false chứ không ném lỗi', async () => {
    for (const bad of [
      '',
      'rác',
      'pbkdf2$sha256$1000$chỉ-có-ba-phần',
      'bcrypt$sha256$1000$aaaa$bbbb',
      'pbkdf2$md5$1000$aaaa$bbbb',
      'pbkdf2$sha256$0$aaaa$bbbb',
      'pbkdf2$sha256$abc$aaaa$bbbb',
      'pbkdf2$sha256$99999999$aaaa$bbbb',
    ]) {
      const r = await verifyPassword('matkhau-rat-dai-123', bad);
      expect(r.ok, `phải từ chối: ${bad}`).toBe(false);
    }
  });

  it('xử lý được mật khẩu tiếng Việt có dấu và emoji', async () => {
    const pw = 'mật-khẩu-tiếng-việt-🎬-dài';
    const stored = await hashPassword(pw, 1000);
    expect((await verifyPassword(pw, stored)).ok).toBe(true);
    // Dạng tổ hợp NFD của cùng chuỗi là byte KHÁC → phải không khớp.
    // Mật khẩu cố ý không chuẩn hoá NFC: người dùng gõ sao thì khớp vậy.
    expect((await verifyPassword(pw.normalize('NFD'), stored)).ok).toBe(false);
  });
});
