import { beforeEach, describe, expect, it } from 'vitest';
import { fakeVectorize, migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import {
  drainVectorGc,
  indexOne,
  reconcile,
  reconcileAll,
  refreshVectorMetadata,
} from '../src/vec/sync';
import * as hooksDb from '../src/db/hooks';
import * as variantsDb from '../src/db/variants';
import { computeHookHash, computeVariantHash } from '../src/content';

/** Đưa mọi hàng bẩn của user lên Vectorize — đúng đường mà nút đồng bộ chạy. */
async function sync(env: Env, uid?: string) {
  return reconcile(env, 100, uid);
}
import { queryIdeas, queueGc } from '../src/vec/index';
import { MODEL_ID } from '../src/vec/embeddings';
import type { Env } from '../src/types';

const BASE = {
  title: 'Mẹo quay phim',
  script_outline: 'dàn ý',
  platform: 'tiktok' as const,
  niche: 'phim',
  status: 'idea' as const,
  negative_prompt: '',
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

describe('index từng mục (nút Index của riêng một hàng)', () => {
  let uid: string;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    const u = await usersDb.insert(
      testEnv(), 'a@example.com', await hashPassword('x', 1000), null,
    );
    uid = u!.id;
  });

  it('index ĐÚNG hàng được chỉ định, không phải một hàng bẩn nào đó', async () => {
    // HỒI QUY cho cái bẫy chính: reconcile(limit=1) lấy hàng bẩn theo `updated_at`, nên
    // nó sẽ đồng bộ ý tưởng CŨ NHẤT chứ không phải ý tưởng người dùng vừa bấm nút. Người
    // dùng bấm Index trên thẻ của mình, thấy nút chạy xong, mà thẻ đó vẫn "chưa index".
    const vec = fakeVectorize();
    const env = envWith(vec);
    const cu = await ideasDb.create(env, uid, { ...BASE, title: 'Cũ nhất' }, 'h1');
    const giua = await ideasDb.create(env, uid, { ...BASE, title: 'Ở giữa' }, 'h2');
    const moi = await ideasDb.create(env, uid, { ...BASE, title: 'Mới nhất' }, 'h3');
    expect(await ideasDb.countDirty(env, uid)).toBe(3);

    const res = await indexOne(env, uid, 'idea', moi.id);

    expect(res?.indexed).toBe(true);
    expect([...vec.store.keys()]).toEqual([moi.id]);
    // Hai hàng kia phải còn nguyên trạng thái bẩn.
    expect(await ideasDb.countDirty(env, uid)).toBe(2);
    expect((await ideasDb.getById(env, uid, cu.id))?.embedded_hash).toBeNull();
    expect((await ideasDb.getById(env, uid, giua.id))?.embedded_hash).toBeNull();
    expect((await ideasDb.getById(env, uid, moi.id))?.embedded_hash).toBe('h3');
  });

  it('hook lên Vectorize với id có tiền tố và metadata type=hook', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const hook = (await hooksDb.createHook(env, uid, {
      text: 'Bạn có biết?', note: '', category_id: null,
    }, await computeHookHash({ text: 'Bạn có biết?', note: '' })))!;
    expect(vec.store.size, 'tạo hook không được đụng Vectorize').toBe(0);
    expect(await hooksDb.countDirty(env, uid)).toBe(1);

    const res = await indexOne(env, uid, 'hook', hook.id);

    expect(res?.indexed).toBe(true);
    expect(vec.store.has(`hook:${hook.id}`)).toBe(true);
    expect(vec.store.get(`hook:${hook.id}`)!.metadata['type']).toBe('hook');
    expect(vec.store.get(`hook:${hook.id}`)!.values).toHaveLength(1024);
    expect(await hooksDb.countDirty(env, uid)).toBe(0);
  });

  it('biến thể lên Vectorize với id có tiền tố và metadata type=variant', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    const input = { title: 'POV', angle: 'góc nhìn người xem', script_outline: '', sort_order: 0 };
    const v = (await variantsDb.create(
      env, uid, idea.id, input, await computeVariantHash(input),
    ))!;
    expect(vec.store.size, 'tạo biến thể không được đụng Vectorize').toBe(0);

    const res = await indexOne(env, uid, 'variant', v.id);

    expect(res?.indexed).toBe(true);
    expect(vec.store.get(`variant:${v.id}`)!.metadata['type']).toBe('variant');
    expect(vec.store.get(`variant:${v.id}`)!.metadata['idea_id']).toBe(idea.id);
    expect(await variantsDb.countDirty(env, uid)).toBe(0);
  });

  it('tìm ý tưởng KHÔNG trả về vector của hook hay biến thể', async () => {
    // Thiếu filter type='idea' thì hook và biến thể chiếm suất trong topK rồi bị tầng
    // hydrate lặng lẽ loại đi — kết quả tìm kiếm ít đi mà không có dấu hiệu nào.
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    const input = { title: 'v', angle: '', script_outline: '', sort_order: 0 };
    const v = (await variantsDb.create(
      env, uid, idea.id, input, await computeVariantHash(input),
    ))!;
    const hook = (await hooksDb.createHook(env, uid, {
      text: 'hook', note: '', category_id: null,
    }, await computeHookHash({ text: 'hook', note: '' })))!;

    await indexOne(env, uid, 'idea', idea.id);
    await indexOne(env, uid, 'variant', v.id);
    await indexOne(env, uid, 'hook', hook.id);
    expect(vec.store.size, 'cả ba đều phải nằm chung một index').toBe(3);

    const matches = await queryIdeas(env, new Array(1024).fill(0.01), { userId: uid, topK: 10 });
    expect(matches.map((m) => m.id)).toEqual([idea.id]);
  });

  it('đổi danh mục của hook làm nó bẩn lại nhưng KHÔNG tốn lời gọi nhúng', async () => {
    // Cùng cái bẫy mà migrations/0004 đã vá cho `status` của ý tưởng: danh mục nằm
    // trong metadata của vector nhưng không nằm trong văn bản đem đi nhúng.
    const vec = fakeVectorize();
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
    const body = { text: 'Bạn có biết?', note: '' };
    const hook = (await hooksDb.createHook(
      env, uid, { ...body, category_id: null }, await computeHookHash(body),
    ))!;
    await indexOne(env, uid, 'hook', hook.id);
    expect(embedCalls).toBe(1);

    const cat = await hooksDb.createCategory(env, uid, 'Câu hỏi', 0);
    await hooksDb.updateHook(
      env, uid, hook.id, { ...body, category_id: cat!.id }, await computeHookHash(body),
    );
    expect(await hooksDb.countDirty(env, uid), 'đổi danh mục phải làm hook bẩn lại').toBe(1);

    await indexOne(env, uid, 'hook', hook.id);
    expect(embedCalls, 'đổi mỗi danh mục KHÔNG được nhúng lại').toBe(1);
    expect(vec.store.get(`hook:${hook.id}`)!.metadata['category_id']).toBe(cat!.id);
    expect(await hooksDb.countDirty(env, uid)).toBe(0);
  });

  it('nút đồng bộ hàng loạt rút cạn cả ba loại trong một lần bấm', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    const input = { title: 'v', angle: '', script_outline: '', sort_order: 0 };
    await variantsDb.create(env, uid, idea.id, input, await computeVariantHash(input));
    await hooksDb.createHook(
      env, uid, { text: 'hook', note: '', category_id: null },
      await computeHookHash({ text: 'hook', note: '' }),
    );

    const r = await reconcileAll(env, 100, uid);

    expect(r.remaining).toBe(0);
    expect(r.by_type.ideas.processed).toBe(1);
    expect(r.by_type.variants.processed).toBe(1);
    expect(r.by_type.hooks.processed).toBe(1);
    expect(vec.store.size).toBe(3);
  });
});
