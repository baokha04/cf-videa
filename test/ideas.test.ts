import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import { buildEmbedText, contentHash, MODEL_ID } from '../src/vec/embeddings';

const BASE = {
  title: 'Tiêu đề',
  hook: '',
  script_outline: '',
  platform: 'tiktok' as const,
  niche: '',
  status: 'idea' as const,
};

async function mkUser() {
  const u = await usersDb.insert(testEnv(), 'a@example.com', await hashPassword('x', 1000), null);
  if (!u) throw new Error('không tạo được user');
  return u;
}

describe('truy vấn ý tưởng', () => {
  let uid: string;
  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    uid = (await mkUser()).id;
  });

  it('bộ lọc kết hợp nhiều điều kiện cùng lúc vẫn ra đúng kết quả', async () => {
    // Đây chính là chỗ từng có bug: các placeholder ?N bị trùng số khi một mệnh đề
    // sinh nhiều placeholder trước lúc push giá trị.
    await ideasDb.create(testEnv(), uid, { ...BASE, title: 'Mẹo quay phim', niche: 'phim' }, 'h1');
    await ideasDb.create(
      testEnv(), uid,
      { ...BASE, title: 'Nấu ăn nhanh', niche: 'ẩm thực', platform: 'reels', status: 'filmed' },
      'h2',
    );
    const { rows } = await ideasDb.list(
      testEnv(), uid,
      { q: 'nấu', platform: 'reels', status: 'filmed', niche: 'ẩm thực' },
      50, null,
    );
    expect(rows.map((r) => r.title)).toEqual(['Nấu ăn nhanh']);
  });

  it('tìm từ khoá khớp trên nhiều cột', async () => {
    await ideasDb.create(testEnv(), uid, { ...BASE, title: 'A', hook: 'cà phê sáng' }, 'h1');
    await ideasDb.create(testEnv(), uid, { ...BASE, title: 'B', script_outline: 'cà phê đá' }, 'h2');
    await ideasDb.create(testEnv(), uid, { ...BASE, title: 'C', niche: 'cà phê' }, 'h3');
    await ideasDb.create(testEnv(), uid, { ...BASE, title: 'cà phê D' }, 'h4');
    const { rows } = await ideasDb.list(testEnv(), uid, { q: 'cà phê' }, 50, null);
    expect(rows).toHaveLength(4);
  });

  it('ký tự đại diện của LIKE được escape, không bị hiểu là wildcard', async () => {
    await ideasDb.create(testEnv(), uid, { ...BASE, title: 'giảm 50% cân nặng' }, 'h1');
    await ideasDb.create(testEnv(), uid, { ...BASE, title: 'chuyện khác hẳn' }, 'h2');
    // '%' phải khớp đúng dấu phần trăm, không phải "khớp mọi thứ".
    const { rows } = await ideasDb.list(testEnv(), uid, { q: '50%' }, 50, null);
    expect(rows.map((r) => r.title)).toEqual(['giảm 50% cân nặng']);
  });

  it('phân trang keyset đi hết danh sách không lặp và không sót', async () => {
    for (let i = 0; i < 7; i++) {
      await ideasDb.create(testEnv(), uid, { ...BASE, title: `Ý tưởng ${i}` }, `h${i}`);
      // Ép updated_at khác nhau để thứ tự tất định.
      await testEnv().DB.prepare(
        'UPDATE ideas SET updated_at = ?2 WHERE content_hash = ?1',
      ).bind(`h${i}`, 1000 + i).run();
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r: { rows: Array<{ id: string }>; nextCursor: string | null } =
        await ideasDb.list(testEnv(), uid, {}, 3, ideasDb.decodeCursor(cursor));
      seen.push(...r.rows.map((x) => x.id));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('markEmbedded chỉ đánh dấu khi content_hash còn khớp', async () => {
    const idea = await ideasDb.create(testEnv(), uid, BASE, 'hash-cu');
    // Mô phỏng: người dùng sửa nội dung trong lúc lệnh embed đang chạy.
    await ideasDb.update(testEnv(), uid, idea.id, { ...BASE, title: 'Đã sửa' }, 'hash-moi');
    // Kết quả embed của nội dung CŨ về muộn — không được đánh dấu là đã đồng bộ.
    await ideasDb.markEmbedded(testEnv(), idea.id, 'hash-cu', MODEL_ID);
    const row = await ideasDb.getById(testEnv(), uid, idea.id);
    expect(row?.embedded_hash).toBeNull();
    expect(await ideasDb.countDirty(testEnv(), uid)).toBe(1);
  });

  it('danh sách hàng bẩn phản ánh đúng trạng thái đồng bộ', async () => {
    const a = await ideasDb.create(testEnv(), uid, BASE, 'h1');
    await ideasDb.create(testEnv(), uid, BASE, 'h2');
    expect(await ideasDb.countDirty(testEnv(), uid)).toBe(2);
    await ideasDb.markEmbedded(testEnv(), a.id, 'h1', MODEL_ID);
    expect(await ideasDb.countDirty(testEnv(), uid)).toBe(1);
    expect((await ideasDb.listDirty(testEnv(), 10, uid)).map((r) => r.content_hash)).toEqual(['h2']);
  });
});

describe('hash nội dung dùng cho đồng bộ Vectorize', () => {
  it('cùng nội dung cho cùng hash', async () => {
    const idea = { title: 'A', hook: 'B', script_outline: 'C', niche: 'D', platform: 'tiktok' as const };
    expect(await contentHash(buildEmbedText(idea, ['x'])))
      .toBe(await contentHash(buildEmbedText(idea, ['x'])));
  });

  it('đổi bất kỳ trường nào ảnh hưởng embedding thì hash đổi theo', async () => {
    const base = { title: 'A', hook: 'B', script_outline: 'C', niche: 'D', platform: 'tiktok' as const };
    const h0 = await contentHash(buildEmbedText(base, ['x']));
    for (const variant of [
      { ...base, title: 'A2' },
      { ...base, hook: 'B2' },
      { ...base, script_outline: 'C2' },
      { ...base, niche: 'D2' },
      { ...base, platform: 'reels' as const },
    ]) {
      expect(await contentHash(buildEmbedText(variant, ['x']))).not.toBe(h0);
    }
    expect(await contentHash(buildEmbedText(base, ['y']))).not.toBe(h0);
  });

  it('hash gắn với MODEL_ID nên đổi model là mọi hàng tự động thành bẩn', async () => {
    const text = 'nội dung bất kỳ';
    const withModel = await contentHash(text);
    // Nếu MODEL_ID không nằm trong hash thì hai giá trị này bằng nhau, và việc đổi
    // model sẽ âm thầm để lại vector cũ sai chiều/sai không gian.
    const { sha256Hex } = await import('../src/util/hash');
    expect(withModel).not.toBe(await sha256Hex(text));
    expect(withModel).toBe(await sha256Hex(`${text}|${MODEL_ID}`));
  });
});
