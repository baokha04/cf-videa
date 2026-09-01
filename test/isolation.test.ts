import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import * as likesDb from '../src/db/likes';
import { setIdeaTags, listTags } from '../src/db/tags';

/**
 * Ma trận cách ly đa người dùng. Đây là bất biến bảo mật quan trọng nhất của app:
 * mọi truy vấn phải ràng buộc user_id NGAY TRONG câu lệnh, và không khớp thì phải
 * cư xử như "không tồn tại" chứ không phải "bị cấm".
 */

const INPUT = {
  title: 'Bí mật của A',
  hook: 'hook của A',
  script_outline: 'kịch bản của A',
  platform: 'tiktok' as const,
  niche: 'ẩm thực',
  status: 'idea' as const,
};

async function mkUser(email: string) {
  const u = await usersDb.insert(testEnv(), email, await hashPassword('x', 1000), null);
  if (!u) throw new Error('không tạo được user');
  return u;
}

describe('cách ly giữa các tài khoản', () => {
  let A: { id: string };
  let B: { id: string };
  let ideaOfA: { id: string };

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    A = await mkUser('a@example.com');
    B = await mkUser('b@example.com');
    ideaOfA = await ideasDb.create(testEnv(), A.id, INPUT, 'hash-a');
  });

  it('B không đọc được ý tưởng của A', async () => {
    expect(await ideasDb.getById(testEnv(), B.id, ideaOfA.id)).toBeNull();
    expect(await ideasDb.getById(testEnv(), A.id, ideaOfA.id)).not.toBeNull();
  });

  it('B không sửa được ý tưởng của A', async () => {
    const ok = await ideasDb.update(
      testEnv(), B.id, ideaOfA.id, { ...INPUT, title: 'bị chiếm đoạt' }, 'hash-b',
    );
    expect(ok).toBe(false);
    const still = await ideasDb.getById(testEnv(), A.id, ideaOfA.id);
    expect(still?.title).toBe('Bí mật của A');
  });

  it('B không xoá được ý tưởng của A', async () => {
    expect(await ideasDb.remove(testEnv(), B.id, ideaOfA.id)).toBe(false);
    expect(await ideasDb.getById(testEnv(), A.id, ideaOfA.id)).not.toBeNull();
  });

  it('danh sách của B không chứa ý tưởng của A', async () => {
    const { rows } = await ideasDb.list(testEnv(), B.id, {}, 50, null);
    expect(rows).toHaveLength(0);
    const a = await ideasDb.list(testEnv(), A.id, {}, 50, null);
    expect(a.rows).toHaveLength(1);
  });

  it('nạp nhiều theo id vẫn lọc theo user — đây là lưới an toàn sau Vectorize', async () => {
    // Mô phỏng đúng tình huống nguy hiểm: Vectorize (vì lỗi filter, hay vì còn sót
    // vector mồ côi) trả về id của A cho truy vấn của B.
    const map = await ideasDb.getManyByIds(testEnv(), B.id, [ideaOfA.id]);
    expect(map.size).toBe(0);
  });

  it('tìm từ khoá của B không lọt dữ liệu của A', async () => {
    const { rows } = await ideasDb.list(testEnv(), B.id, { q: 'Bí mật' }, 50, null);
    expect(rows).toHaveLength(0);
  });

  it('tag là từ vựng riêng của từng người', async () => {
    await setIdeaTags(testEnv(), A.id, ideaOfA.id, ['bí-mật']);
    expect((await listTags(testEnv(), B.id))).toHaveLength(0);
    expect((await listTags(testEnv(), A.id)).map((t) => t.name)).toEqual(['bí-mật']);
  });

  it('like của B không hiện trong danh sách like của A', async () => {
    const ideaOfB = await ideasDb.create(testEnv(), B.id, INPUT, 'hash-b');
    await likesDb.like(testEnv(), B.id, ideaOfB.id);
    expect(await likesDb.likedIds(testEnv(), A.id)).toHaveLength(0);
    expect(await likesDb.likedIds(testEnv(), B.id)).toEqual([ideaOfB.id]);
  });

  it('lọc theo tag không lấy được ý tưởng của người khác qua tag cùng tên', async () => {
    await setIdeaTags(testEnv(), A.id, ideaOfA.id, ['mẹo']);
    const ideaOfB = await ideasDb.create(testEnv(), B.id, INPUT, 'hash-b');
    await setIdeaTags(testEnv(), B.id, ideaOfB.id, ['mẹo']);
    const { rows } = await ideasDb.list(testEnv(), B.id, { tag: 'mẹo' }, 50, null);
    expect(rows.map((r) => r.id)).toEqual([ideaOfB.id]);
  });
});
