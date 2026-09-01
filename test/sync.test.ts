import { beforeEach, describe, expect, it } from 'vitest';
import { fakeVectorize, migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import { indexIdea, reconcile, drainVectorGc } from '../src/vec/sync';
import { queueGc } from '../src/vec/index';
import { MODEL_ID } from '../src/vec/embeddings';
import type { Env } from '../src/types';

const BASE = {
  title: 'Mẹo quay phim',
  hook: 'hook',
  script_outline: 'dàn ý',
  platform: 'tiktok' as const,
  niche: 'phim',
  status: 'idea' as const,
};

/** Env với Vectorize giả — thay vì gọi ra dịch vụ thật. */
function envWith(vec: ReturnType<typeof fakeVectorize>): Env {
  return { ...testEnv(), VEC: vec as unknown as VectorizeIndex };
}

describe('đồng bộ D1 ↔ Vectorize', () => {
  let uid: string;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    const u = await usersDb.insert(
      testEnv(), 'a@example.com', await hashPassword('x', 1000), null,
    );
    uid = u!.id;
  });

  it('index thành công thì đánh dấu hàng là đã đồng bộ', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');

    expect(await indexIdea(env, idea, ['mẹo'])).toBe(true);
    expect(vec.store.has(idea.id)).toBe(true);
    expect(vec.store.get(idea.id)!.metadata['user_id']).toBe(uid);
    expect(vec.store.get(idea.id)!.values).toHaveLength(1024);

    const row = await ideasDb.getById(env, uid, idea.id);
    expect(row?.embedded_hash).toBe('h1');
    expect(row?.embedding_model).toBe(MODEL_ID);
    expect(await ideasDb.countDirty(env, uid)).toBe(0);
  });

  it('index thất bại KHÔNG làm mất bản ghi, chỉ để nó ở trạng thái bẩn', async () => {
    const vec = fakeVectorize();
    // Vectorize sập giữa chừng.
    vec.upsert = async () => {
      throw new Error('Vectorize không với tới được');
    };
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');

    // Không ném lỗi ra ngoài — một trục trặc hạ tầng không được làm mất bài viết.
    expect(await indexIdea(env, idea, [])).toBe(false);

    const row = await ideasDb.getById(env, uid, idea.id);
    expect(row).not.toBeNull();
    expect(row?.title).toBe(BASE.title);
    expect(row?.embedded_hash).toBeNull();
    expect(row?.embed_attempts).toBe(1);
    expect(await ideasDb.countDirty(env, uid)).toBe(1);
  });

  it('đối soát rút hết hàng bẩn và idempotent khi gọi lại', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    for (let i = 0; i < 5; i++) {
      await ideasDb.create(env, uid, { ...BASE, title: `Ý tưởng ${i}` }, `h${i}`);
    }
    expect(await ideasDb.countDirty(env, uid)).toBe(5);

    const r1 = await reconcile(env, 100, uid);
    expect(r1.processed).toBe(5);
    expect(r1.failed).toBe(0);
    expect(r1.remaining).toBe(0);
    expect(vec.store.size).toBe(5);

    // Gọi lại khi đã sạch thì không làm gì thêm.
    const r2 = await reconcile(env, 100, uid);
    expect(r2.processed).toBe(0);
    expect(r2.remaining).toBe(0);
  });

  it('đối soát tiếp tục được sau khi xử lý một phần', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    for (let i = 0; i < 7; i++) {
      await ideasDb.create(env, uid, { ...BASE, title: `Ý tưởng ${i}` }, `h${i}`);
    }
    const r1 = await reconcile(env, 3, uid);
    expect(r1.processed).toBe(3);
    expect(r1.remaining).toBe(4);
    const r2 = await reconcile(env, 100, uid);
    expect(r2.processed).toBe(4);
    expect(r2.remaining).toBe(0);
  });

  it('sửa nội dung làm hàng bẩn trở lại, đổi mỗi trạng thái thì không', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    await indexIdea(env, idea, []);
    expect(await ideasDb.countDirty(env, uid)).toBe(0);

    // content_hash mới = nội dung đã đổi.
    await ideasDb.update(env, uid, idea.id, { ...BASE, title: 'Tiêu đề mới' }, 'h2');
    expect(await ideasDb.countDirty(env, uid)).toBe(1);

    // Ghi lại cùng content_hash (chỉ đổi trạng thái) thì vẫn sạch.
    await reconcile(env, 10, uid);
    await ideasDb.update(env, uid, idea.id, { ...BASE, title: 'Tiêu đề mới', status: 'filmed' }, 'h2');
    expect(await ideasDb.countDirty(env, uid)).toBe(0);
  });

  it('vector mồ côi được xếp hàng và rút sạch', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    await indexIdea(env, idea, []);
    await ideasDb.remove(env, uid, idea.id);

    // Mô phỏng: xoá trên Vectorize thất bại nên id được xếp vào hàng đợi.
    await queueGc(env, [idea.id], uid);
    const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM vector_gc')
      .first<{ n: number }>();
    expect(pending?.n).toBe(1);

    expect(await drainVectorGc(env, 100)).toBe(1);
    expect(vec.store.has(idea.id)).toBe(false);
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM vector_gc')
      .first<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  it('truy vấn Vectorize chỉ trả về vector của đúng người dùng', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const other = await usersDb.insert(env, 'b@example.com', await hashPassword('x', 1000), null);
    const a = await ideasDb.create(env, uid, BASE, 'ha');
    const b = await ideasDb.create(env, other!.id, BASE, 'hb');
    await indexIdea(env, a, []);
    await indexIdea(env, b, []);

    const { queryIdeas } = await import('../src/vec/index');
    const matches = await queryIdeas(env, vec.store.get(a.id)!.values, { userId: uid, topK: 10 });
    expect(matches.map((m) => m.id)).toEqual([a.id]);
  });
});
