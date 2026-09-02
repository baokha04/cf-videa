import { beforeEach, describe, expect, it } from 'vitest';
import { fakeVectorize, migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import { reconcile, drainVectorGc, refreshVectorMetadata } from '../src/vec/sync';

/** Đưa mọi hàng bẩn của user lên Vectorize — đúng đường mà nút đồng bộ chạy. */
async function sync(env: Env, uid?: string) {
  return reconcile(env, 100, uid);
}
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

  it('tạo ý tưởng CHỈ ghi D1, không đụng Vectorize', async () => {
    // Đây là hợp đồng của tính năng đồng bộ thủ công: lưu ý tưởng không được tốn
    // một lời gọi Workers AI nào, và không được ghi gì lên Vectorize.
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    expect(vec.store.size).toBe(0);
    // Nhưng hàng phải hiện ra là "bẩn" để nút đồng bộ thấy nó.
    expect(await ideasDb.countDirty(env, uid)).toBe(1);
    expect(idea.id).toBeTruthy();
  });

  it('đồng bộ thành công thì đánh dấu hàng là đã sạch', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');

    expect((await sync(env, uid)).processed).toBe(1);
    expect(vec.store.has(idea.id)).toBe(true);
    expect(vec.store.get(idea.id)!.metadata['user_id']).toBe(uid);
    expect(vec.store.get(idea.id)!.values).toHaveLength(1024);

    const row = await ideasDb.getById(env, uid, idea.id);
    expect(row?.embedded_hash).toBe('h1');
    expect(row?.embedding_model).toBe(MODEL_ID);
    expect(await ideasDb.countDirty(env, uid)).toBe(0);
  });

  it('đồng bộ thất bại KHÔNG làm mất bản ghi, chỉ để nó ở trạng thái bẩn', async () => {
    const vec = fakeVectorize();
    // Vectorize sập giữa chừng.
    vec.upsert = async () => {
      throw new Error('Vectorize không với tới được');
    };
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');

    // Không ném lỗi ra ngoài — một trục trặc hạ tầng không được làm mất bài viết.
    const r = await sync(env, uid);
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(1);

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

  it('CẢ sửa nội dung LẪN đổi mỗi trạng thái đều làm hàng bẩn trở lại', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    await sync(env, uid);
    expect(await ideasDb.countDirty(env, uid)).toBe(0);

    // (a) Nội dung đổi → content_hash đổi → bẩn.
    await ideasDb.update(env, uid, idea.id, { ...BASE, title: 'Tiêu đề mới' }, 'h2');
    expect(await ideasDb.countDirty(env, uid)).toBe(1);
    await sync(env, uid);
    expect(await ideasDb.countDirty(env, uid)).toBe(0);

    // (b) CHỈ đổi trạng thái → content_hash KHÔNG đổi, nhưng vẫn phải bẩn.
    // Nếu chỗ này trả về 0 thì metadata trên Vectorize sẽ mốc lại vĩnh viễn và
    // /api/search?status=… lọc sai mà không có dấu hiệu gì.
    await ideasDb.update(env, uid, idea.id, { ...BASE, title: 'Tiêu đề mới', status: 'filmed' }, 'h2');
    expect(await ideasDb.countDirty(env, uid)).toBe(1);
  });

  it('đồng bộ hàng chỉ đổi metadata KHÔNG tốn lời gọi nhúng nào', async () => {
    // Đây là lý do tách hai loại bẩn ra: đổi trạng thái là thao tác thường xuyên,
    // và nó dùng lại được vector đã lưu.
    const vec = fakeVectorize();
    // EMBEDDINGS_MODE='live' để mọi lần nhúng thật sự đi qua env.AI và đếm được.
    // Ở chế độ 'stub' thì embed() không chạm tới AI, nên phép đếm sẽ vô nghĩa.
    let embedCalls = 0;
    const env: Env = {
      ...envWith(vec),
      EMBEDDINGS_MODE: 'live',
      AI: {
        run: async (_model: string, input: { text: string[] }) => {
          embedCalls++;
          return { data: input.text.map(() => new Array(1024).fill(0.01)) };
        },
      } as unknown as Ai,
    };

    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    await sync(env, uid);
    expect(embedCalls, 'lần đồng bộ đầu phải nhúng').toBe(1);
    const vectorBefore = vec.store.get(idea.id)!.values;

    await ideasDb.update(env, uid, idea.id, { ...BASE, status: 'published' }, 'h1');
    const r = await sync(env, uid);

    expect(r.processed).toBe(1);
    expect(r.remaining).toBe(0);
    expect(embedCalls, 'đổi mỗi trạng thái KHÔNG được gọi nhúng lần nữa').toBe(1);
    expect(vec.store.get(idea.id)!.values).toEqual(vectorBefore);
    expect(vec.store.get(idea.id)!.metadata['status']).toBe('published');
  });

  it('đổi mỗi status phải cập nhật metadata của vector, không được để mốc', async () => {
    // Đây là cái bẫy im lặng: status nằm trong metadata của vector nhưng KHÔNG nằm
    // trong văn bản đem đi nhúng, nên content_hash không đổi. Nếu chỉ dựa vào hash
    // để quyết định có upsert hay không thì Vectorize sẽ giữ status cũ mãi mãi, và
    // /api/search?status=… lọc sai mà không có dấu hiệu gì.
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    await sync(env, uid);
    expect(vec.store.get(idea.id)!.metadata['status']).toBe('idea');

    const before = vec.store.get(idea.id)!.values;
    await ideasDb.update(env, uid, idea.id, { ...BASE, status: 'published' }, 'h1');
    const fresh = await ideasDb.getById(env, uid, idea.id);
    expect(await refreshVectorMetadata(env, fresh!)).toBe(true);

    expect(vec.store.get(idea.id)!.metadata['status']).toBe('published');
    // Và KHÔNG embed lại: vector giữ nguyên, tức là không tốn lời gọi Workers AI nào.
    expect(vec.store.get(idea.id)!.values).toEqual(before);
    // Hàng vẫn sạch, không bị đánh dấu bẩn oan.
    expect(await ideasDb.countDirty(env, uid)).toBe(0);
  });

  it('cập nhật metadata khi chưa có vector thì báo false để lùi về đường đầy đủ', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    // Chưa từng index → không có gì để cập nhật.
    expect(await refreshVectorMetadata(env, idea)).toBe(false);
  });

  it('vector mồ côi được xếp hàng và rút sạch', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    await sync(env, uid);
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
    await ideasDb.create(env, other!.id, BASE, 'hb');
    await sync(env);

    const { queryIdeas } = await import('../src/vec/index');
    const matches = await queryIdeas(env, vec.store.get(a.id)!.values, { userId: uid, topK: 10 });
    expect(matches.map((m) => m.id)).toEqual([a.id]);
  });
});
