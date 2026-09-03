import { beforeEach, describe, expect, it } from 'vitest';
import { fakeVectorize, migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import { DUP_THRESHOLD, indexOne } from '../src/vec/sync';
import { ideaEmbedText } from '../src/content';
import { contentHash } from '../src/vec/embeddings';
import type { Env } from '../src/types';

/**
 * Kiểm tra trùng khi index.
 *
 * Vectorize giả dùng cosine thật trên vector stub, mà vector stub là hàm tất định của
 * văn bản: cùng chữ cho cùng vector (cosine 1.0), khác chữ cho vector không liên quan.
 * Nên ở đây khẳng định về HÀNH VI — trùng thì báo, khác thì không, và không bao giờ
 * báo qua tài khoản khác — chứ không khẳng định một điểm số cụ thể. Chất lượng ngữ
 * nghĩa là thuộc tính của model được host và đổi lúc nào không biết.
 */

const BASE = {
  script_outline: 'Dàn ý',
  platform: 'tiktok' as const,
  niche: 'ẩm thực',
  status: 'idea' as const,
  negative_prompt: '',
};

function envWith(vec: ReturnType<typeof fakeVectorize>): Env {
  return { ...testEnv(), VEC: vec as unknown as VectorizeIndex };
}

async function mkIdea(env: Env, uid: string, input: ideasDb.IdeaInput) {
  return ideasDb.create(env, uid, input, await contentHash(ideaEmbedText(input, [], [])));
}

async function mkUser(email: string) {
  const u = await usersDb.insert(testEnv(), email, await hashPassword('x', 1000), null);
  if (!u) throw new Error('không tạo được user');
  return u.id;
}

describe('kiểm tra ý tưởng trùng lúc index', () => {
  let uid: string;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    uid = await mkUser('a@example.com');
  });

  it('ý tưởng gần trùng bị gắn cờ, kèm tiêu đề để đi tới xem', async () => {
    const env = envWith(fakeVectorize());
    const first = await mkIdea(env, uid, { ...BASE, title: 'Bữa sáng yến mạch 5 phút' });
    const firstRes = await indexOne(env, uid, 'idea', first.id);
    // Ý tưởng đầu tiên không có gì để trùng với.
    expect(firstRes?.duplicates).toEqual([]);

    // Cùng nội dung y hệt → cùng văn bản nhúng → cùng vector.
    const second = await mkIdea(env, uid, { ...BASE, title: 'Bữa sáng yến mạch 5 phút' });
    const res = await indexOne(env, uid, 'idea', second.id);

    expect(res?.duplicates).toHaveLength(1);
    expect(res?.duplicates[0]?.id).toBe(first.id);
    expect(res?.duplicates[0]?.title).toBe('Bữa sáng yến mạch 5 phút');
    expect(res?.duplicates[0]?.score).toBeGreaterThanOrEqual(DUP_THRESHOLD);
  });

  it('ý tưởng khác hẳn thì KHÔNG bị gắn cờ', async () => {
    const env = envWith(fakeVectorize());
    const a = await mkIdea(env, uid, { ...BASE, title: 'Bữa sáng yến mạch' });
    await indexOne(env, uid, 'idea', a.id);

    const b = await mkIdea(env, uid, { ...BASE, title: 'Sửa xe máy tại nhà', niche: 'cơ khí' });
    const res = await indexOne(env, uid, 'idea', b.id);
    expect(res?.duplicates).toEqual([]);
  });

  it('cảnh báo chứ KHÔNG chặn: hàng vẫn được index sạch', async () => {
    // Hàng đã nằm trong D1 rồi; chặn ở bước index chỉ để lại một ý tưởng vĩnh viễn
    // không tìm được.
    const env = envWith(fakeVectorize());
    const a = await mkIdea(env, uid, { ...BASE, title: 'Trùng nhau' });
    await indexOne(env, uid, 'idea', a.id);
    const b = await mkIdea(env, uid, { ...BASE, title: 'Trùng nhau' });

    const res = await indexOne(env, uid, 'idea', b.id);
    expect(res?.duplicates).toHaveLength(1);
    expect(res?.indexed).toBe(true);
    expect(await ideasDb.countDirty(env, uid)).toBe(0);
  });

  it('KHÔNG bao giờ báo trùng với ý tưởng của tài khoản khác', async () => {
    // Đây là điều quan trọng nhất trong cả file: một cảnh báo trùng làm lộ TIÊU ĐỀ.
    const env = envWith(fakeVectorize());
    const other = await mkUser('b@example.com');
    const theirs = await mkIdea(env, other, { ...BASE, title: 'Bí mật của người khác' });
    await indexOne(env, other, 'idea', theirs.id);

    const mine = await mkIdea(env, uid, { ...BASE, title: 'Bí mật của người khác' });
    const res = await indexOne(env, uid, 'idea', mine.id);
    expect(res?.duplicates).toEqual([]);
  });

  it('không tự báo trùng với chính mình khi index lại', async () => {
    const env = envWith(fakeVectorize());
    const a = await mkIdea(env, uid, { ...BASE, title: 'Chỉ có một mình' });
    await indexOne(env, uid, 'idea', a.id);

    // Ép bẩn lại rồi index lần nữa: vector của chính nó đã nằm trên Vectorize.
    await ideasDb.markAllDirty(env, uid);
    const res = await indexOne(env, uid, 'idea', a.id);
    expect(res?.duplicates).toEqual([]);
  });

  it('id không tồn tại trả về null để route dịch thành 404', async () => {
    const env = envWith(fakeVectorize());
    expect(await indexOne(env, uid, 'idea', 'khong-co-that')).toBeNull();
  });
});
