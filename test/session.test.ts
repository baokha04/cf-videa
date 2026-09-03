import { beforeEach, describe, expect, it } from 'vitest';
import {
  ABSOLUTE_TTL_MS,
  IDLE_TTL_REMEMBER_MS,
  IDLE_TTL_SESSION_MS,
  cookieMaxAge,
  createSession,
  resolveSession,
  revokeAllSessions,
  renewSession,
  revokeSession,
  sweepExpiredSessions,
  recordMaintenanceRun,
} from '../src/auth/session';
import { migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';

async function makeUser(email = 'a@example.com') {
  const u = await usersDb.insert(
    testEnv(),
    email,
    await hashPassword('matkhau-rat-dai-123', 1000),
    null,
  );
  if (!u) throw new Error('không tạo được user');
  return u;
}

describe('phiên đăng nhập', () => {
  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
  });

  it('token gốc KHÔNG được lưu vào database', async () => {
    const u = await makeUser();
    const { token } = await createSession(testEnv(), u.id, {});
    const row = await testEnv()
      .DB.prepare('SELECT id FROM sessions')
      .first<{ id: string }>();
    expect(row).not.toBeNull();
    // Cột id là sha256 hex 64 ký tự, không phải token base64url.
    expect(row!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.id).not.toBe(token);
    expect(token.length).toBeGreaterThan(40);
  });

  it('token hợp lệ tra ra đúng người dùng', async () => {
    const u = await makeUser();
    const { token } = await createSession(testEnv(), u.id, {});
    const r = await resolveSession(testEnv(), token);
    expect(r?.user.id).toBe(u.id);
    expect(r?.user.email).toBe('a@example.com');
  });

  it('token sai hoặc rỗng đều bị từ chối', async () => {
    const u = await makeUser();
    await createSession(testEnv(), u.id, {});
    expect(await resolveSession(testEnv(), '')).toBeNull();
    expect(await resolveSession(testEnv(), 'token-bia-dat')).toBeNull();
  });

  it('phiên đã thu hồi thì không dùng được nữa', async () => {
    const u = await makeUser();
    const { token, session } = await createSession(testEnv(), u.id, {});
    await revokeSession(testEnv(), session.id);
    expect(await resolveSession(testEnv(), token)).toBeNull();
  });

  it('phiên hết hạn nhàn rỗi bị từ chối', async () => {
    const u = await makeUser();
    const { token, session } = await createSession(testEnv(), u.id, {});
    await testEnv()
      .DB.prepare('UPDATE sessions SET expires_at = ?2 WHERE id = ?1')
      .bind(session.id, Date.now() - 1000)
      .run();
    expect(await resolveSession(testEnv(), token)).toBeNull();
  });

  it('trần cứng chặn phiên kể cả khi hạn nhàn rỗi còn xa', async () => {
    const u = await makeUser();
    const { token, session } = await createSession(testEnv(), u.id, {});
    await testEnv()
      .DB.prepare('UPDATE sessions SET expires_at = ?2, absolute_exp = ?3 WHERE id = ?1')
      .bind(session.id, Date.now() + ABSOLUTE_TTL_MS, Date.now() - 1000)
      .run();
    expect(await resolveSession(testEnv(), token)).toBeNull();
  });

  it('tài khoản bị khoá thì phiên đang mở cũng mất hiệu lực', async () => {
    const u = await makeUser();
    const { token } = await createSession(testEnv(), u.id, {});
    await testEnv().DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?1")
      .bind(u.id).run();
    expect(await resolveSession(testEnv(), token)).toBeNull();
  });

  it('thu hồi tất cả giữ lại đúng phiên hiện tại', async () => {
    const u = await makeUser();
    const a = await createSession(testEnv(), u.id, {});
    const b = await createSession(testEnv(), u.id, {});
    const c = await createSession(testEnv(), u.id, {});
    const n = await revokeAllSessions(testEnv(), u.id, b.session.id);
    expect(n).toBe(2);
    expect(await resolveSession(testEnv(), a.token)).toBeNull();
    expect(await resolveSession(testEnv(), c.token)).toBeNull();
    expect(await resolveSession(testEnv(), b.token)).not.toBeNull();
  });

  it('phiên của người này không đụng tới phiên của người kia', async () => {
    const a = await makeUser('a@example.com');
    const b = await makeUser('b@example.com');
    const sa = await createSession(testEnv(), a.id, {});
    const sb = await createSession(testEnv(), b.id, {});
    await revokeAllSessions(testEnv(), a.id);
    expect(await resolveSession(testEnv(), sa.token)).toBeNull();
    expect(await resolveSession(testEnv(), sb.token)).not.toBeNull();
  });

  it('dọn phiên hết hạn không chạm vào phiên còn hiệu lực', async () => {
    const u = await makeUser();
    const alive = await createSession(testEnv(), u.id, {});
    const dead = await createSession(testEnv(), u.id, {});
    await testEnv()
      .DB.prepare('UPDATE sessions SET expires_at = ?2 WHERE id = ?1')
      .bind(dead.session.id, Date.now() - 1000)
      .run();
    expect(await sweepExpiredSessions(testEnv())).toBe(1);
    expect(await resolveSession(testEnv(), alive.token)).not.toBeNull();
  });

  it('ghi nhớ đăng nhập cho phiên dài và cookie sống qua lần đóng trình duyệt', async () => {
    const u = await makeUser();
    const t0 = Date.now();
    const { token } = await createSession(testEnv(), u.id, { remember: true });
    const r = await resolveSession(testEnv(), token);
    expect(r?.session.remember).toBe(true);
    expect(r!.session.expires_at - t0).toBeGreaterThan(IDLE_TTL_REMEMBER_MS - 5000);
    // Có Max-Age → trình duyệt giữ cookie sau khi đóng.
    expect(cookieMaxAge(true)).toBe(Math.floor(IDLE_TTL_REMEMBER_MS / 1000));
  });

  it('KHÔNG ghi nhớ thì phiên ngắn và cookie là cookie phiên', async () => {
    const u = await makeUser();
    const t0 = Date.now();
    const { token } = await createSession(testEnv(), u.id, { remember: false });
    const r = await resolveSession(testEnv(), token);
    expect(r?.session.remember).toBe(false);
    // Biên độ 5 giây: t0 được lấy TRƯỚC createSession, nên hiệu số luôn nhỉnh hơn
    // TTL đúng bằng thời gian trôi qua giữa hai mốc.
    const delta = r!.session.expires_at - t0;
    expect(delta).toBeGreaterThan(IDLE_TTL_SESSION_MS - 5000);
    expect(delta).toBeLessThan(IDLE_TTL_SESSION_MS + 5000);
    // undefined = KHÔNG đặt Max-Age = cookie phiên. Đây là điểm mấu chốt của tính
    // năng: máy dùng chung thì đóng trình duyệt là mất đăng nhập.
    expect(cookieMaxAge(false)).toBeUndefined();
  });

  it('mặc định là KHÔNG ghi nhớ khi không nói gì', async () => {
    // Fail-safe: quên truyền cờ thì phải ra phiên ngắn, không phải phiên 30 ngày.
    const u = await makeUser();
    const { token } = await createSession(testEnv(), u.id, {});
    expect((await resolveSession(testEnv(), token))?.session.remember).toBe(false);
  });

  it('gia hạn trượt giữ nguyên kiểu phiên, không âm thầm kéo dài phiên ngắn', async () => {
    const u = await makeUser();
    const { token, session } = await createSession(testEnv(), u.id, { remember: false });
    // Đẩy sát hạn để kích hoạt gia hạn.
    await testEnv()
      .DB.prepare('UPDATE sessions SET expires_at = ?2 WHERE id = ?1')
      .bind(session.id, Date.now() + 60_000)
      .run();
    const r = await resolveSession(testEnv(), token);
    expect(r?.shouldRenew).toBe(true);
    const next = await renewSession(testEnv(), r!.session);
    // Gia hạn theo TTL ngắn, không nhảy lên 30 ngày.
    expect(next - Date.now()).toBeLessThanOrEqual(IDLE_TTL_SESSION_MS + 1000);
  });

  it('xoá user thì phiên bị xoá theo (khoá ngoại CASCADE)', async () => {
    const u = await makeUser();
    const { token } = await createSession(testEnv(), u.id, {});
    await testEnv().DB.prepare('DELETE FROM users WHERE id = ?1').bind(u.id).run();
    expect(await resolveSession(testEnv(), token)).toBeNull();
    const { results } = await testEnv().DB.prepare('SELECT id FROM sessions').all();
    expect(results.length).toBe(0);
  });
});

describe('nhịp tim bảo trì', () => {
  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM maintenance_runs').run();
  });

  it('ghi và ghi đè đúng một hàng duy nhất', async () => {
    await recordMaintenanceRun(testEnv(), { sessions: 3, rate: 1, vector: 0, reindexed: 2 }, 'auto');
    let row = await testEnv()
      .DB.prepare('SELECT * FROM maintenance_runs')
      .first<{ id: number; sessions_gc: number; source: string; ran_at: number }>();
    expect(row?.id).toBe(1);
    expect(row?.sessions_gc).toBe(3);
    expect(row?.source).toBe('auto');

    await recordMaintenanceRun(testEnv(), { sessions: 9, rate: 0, vector: 0, reindexed: 0 }, 'manual');
    const { results } = await testEnv().DB.prepare('SELECT * FROM maintenance_runs').all();
    // Ghi đè, không chất đống: bảng luôn đúng một hàng.
    expect(results).toHaveLength(1);
    row = await testEnv()
      .DB.prepare('SELECT * FROM maintenance_runs')
      .first<{ id: number; sessions_gc: number; source: string; ran_at: number }>();
    expect(row?.sessions_gc).toBe(9);
    expect(row?.source).toBe('manual');
  });
})
