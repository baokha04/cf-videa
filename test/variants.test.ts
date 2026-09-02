import { beforeEach, describe, expect, it } from 'vitest';
import { fakeVectorize, migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import * as hooksDb from '../src/db/hooks';
import { hooksForIdeas, setIdeaHooks } from '../src/db/hooks';
import { metaSignature } from '../src/vec/index';
import { rehashIdea, syncIdea } from '../src/vec/sync';
import { buildEmbedText, contentHash } from '../src/vec/embeddings';
import type { Env } from '../src/types';

const BASE = {
  title: 'Ý tưởng gốc',
  hook: 'hook',
  script_outline: 'dàn ý',
  source_idea: 'bản thô nghĩ ra lúc 2 giờ sáng',
  prompt_recipe: 'máy quay lia chậm, ánh sáng dịu',
  negative_prompt: 'không chữ to, không nhạc trend',
  platform: 'tiktok' as const,
  niche: 'phim',
  status: 'idea' as const,
  kind: 'origin' as const,
  parent_id: null,
};

function envWith(vec: ReturnType<typeof fakeVectorize>): Env {
  return { ...testEnv(), VEC: vec as unknown as VectorizeIndex };
}

async function mkUser(email: string) {
  const u = await usersDb.insert(testEnv(), email, await hashPassword('x', 1000), null);
  if (!u) throw new Error('không tạo được user');
  return u;
}

describe('ý tưởng gốc, biến thể và danh mục hook', () => {
  let A: string;
  let B: string;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    A = (await mkUser('a@example.com')).id;
    B = (await mkUser('b@example.com')).id;
  });

  it('ba trường nguyên liệu được lưu và đọc lại nguyên vẹn', async () => {
    const idea = await ideasDb.create(testEnv(), A, BASE, 'h1');
    const row = await ideasDb.getById(testEnv(), A, idea.id);
    expect(row?.source_idea).toBe(BASE.source_idea);
    expect(row?.prompt_recipe).toBe(BASE.prompt_recipe);
    expect(row?.negative_prompt).toBe(BASE.negative_prompt);
  });

  it('biến thể mọc ra từ ý tưởng gốc và hiện trong danh mục của nó', async () => {
    const origin = await ideasDb.create(testEnv(), A, BASE, 'h1');
    const v = await ideasDb.create(
      testEnv(), A,
      { ...BASE, title: 'Biến thể 1', kind: 'variant', parent_id: origin.id },
      'h2',
    );
    expect(v.kind).toBe('variant');
    expect(v.parent_id).toBe(origin.id);

    const list = await ideasDb.listVariants(testEnv(), A, origin.id);
    expect(list.map((r) => r.id)).toEqual([v.id]);
    expect((await ideasDb.variantCounts(testEnv(), A, [origin.id])).get(origin.id)).toBe(1);
  });

  it('biến thể KHÔNG đẻ tiếp được biến thể — cây luôn đúng một tầng', async () => {
    const origin = await ideasDb.create(testEnv(), A, BASE, 'h1');
    const v1 = await ideasDb.create(
      testEnv(), A, { ...BASE, kind: 'variant', parent_id: origin.id }, 'h2',
    );
    // Cha là một biến thể → truy vấn con không khớp → hàng rơi về ý tưởng gốc, chứ
    // KHÔNG được trở thành biến thể tầng hai.
    const v2 = await ideasDb.create(
      testEnv(), A, { ...BASE, kind: 'variant', parent_id: v1.id }, 'h3',
    );
    expect(v2.kind).toBe('origin');
    expect(v2.parent_id).toBeNull();
  });

  it('ý tưởng đang có biến thể thì không tự trở thành biến thể của người khác', async () => {
    const origin = await ideasDb.create(testEnv(), A, BASE, 'h1');
    const other = await ideasDb.create(testEnv(), A, { ...BASE, title: 'Gốc khác' }, 'h2');
    await ideasDb.create(testEnv(), A, { ...BASE, kind: 'variant', parent_id: origin.id }, 'h3');

    await ideasDb.update(
      testEnv(), A, origin.id,
      { ...BASE, kind: 'variant', parent_id: other.id },
      'h4',
    );
    const row = await ideasDb.getById(testEnv(), A, origin.id);
    // Phần còn lại của bản sửa vẫn được ghi; chỉ quan hệ cha-con bị từ chối.
    expect(row?.kind).toBe('origin');
    expect(row?.parent_id).toBeNull();
  });

  it('không thể lấy ý tưởng của người khác làm ý tưởng gốc', async () => {
    const originOfA = await ideasDb.create(testEnv(), A, BASE, 'h1');
    const v = await ideasDb.create(
      testEnv(), B, { ...BASE, kind: 'variant', parent_id: originOfA.id }, 'h2',
    );
    expect(v.kind).toBe('origin');
    expect(v.parent_id).toBeNull();
    // Và danh mục biến thể của A vẫn rỗng.
    expect(await ideasDb.listVariants(testEnv(), A, originOfA.id)).toHaveLength(0);
  });

  it('id biến thể phải lấy được TRƯỚC khi xoá, vì cascade không báo cho Vectorize', async () => {
    const origin = await ideasDb.create(testEnv(), A, BASE, 'h1');
    const v = await ideasDb.create(
      testEnv(), A, { ...BASE, kind: 'variant', parent_id: origin.id }, 'h2',
    );
    // Đây chính là thứ route xoá phải làm trước lệnh DELETE: không gom id con lại
    // thì vector của biến thể ở lại Vectorize vĩnh viễn.
    expect(await ideasDb.childIds(testEnv(), A, origin.id)).toEqual([v.id]);

    await ideasDb.remove(testEnv(), A, origin.id);
    expect(await ideasDb.getById(testEnv(), A, v.id)).toBeNull();
  });

  it('danh mục hook giữ nguyên thứ tự người dùng sắp', async () => {
    const idea = await ideasDb.create(testEnv(), A, BASE, 'h1');
    await setIdeaHooks(testEnv(), A, idea.id, ['hook C', 'hook A', 'hook B']);
    expect((await hooksForIdeas(testEnv(), [idea.id])).get(idea.id))
      .toEqual(['hook C', 'hook A', 'hook B']);

    // Ghi đè là THAY TOÀN BỘ danh mục, không phải thêm vào.
    await setIdeaHooks(testEnv(), A, idea.id, ['hook mới']);
    expect((await hooksForIdeas(testEnv(), [idea.id])).get(idea.id)).toEqual(['hook mới']);
  });

  it('B không đụng được danh mục hook của A', async () => {
    const ideaOfA = await ideasDb.create(testEnv(), A, BASE, 'h1');
    await setIdeaHooks(testEnv(), A, ideaOfA.id, ['hook của A']);

    // B ghi đè lên ý tưởng của A: không xoá được gì và không chèn được gì.
    await setIdeaHooks(testEnv(), B, ideaOfA.id, ['hook của B']);
    expect((await hooksForIdeas(testEnv(), [ideaOfA.id])).get(ideaOfA.id))
      .toEqual(['hook của A']);
  });

  it('hook nằm trong tìm kiếm từ khoá, công thức prompt cũng vậy', async () => {
    const a = await ideasDb.create(testEnv(), A, { ...BASE, title: 'A' }, 'h1');
    await setIdeaHooks(testEnv(), A, a.id, ['bạn có biết cà phê']);
    await ideasDb.create(
      testEnv(), A,
      { ...BASE, title: 'B', source_idea: '', prompt_recipe: 'ống kính cà phê' },
      'h2',
    );
    const { rows } = await ideasDb.list(testEnv(), A, { q: 'cà phê' }, 50, null);
    expect(rows.map((r) => r.title).sort()).toEqual(['A', 'B']);
  });

  it('lọc theo kind tách được kho gốc khỏi danh mục biến thể', async () => {
    const origin = await ideasDb.create(testEnv(), A, BASE, 'h1');
    await ideasDb.create(
      testEnv(), A, { ...BASE, title: 'Biến thể', kind: 'variant', parent_id: origin.id }, 'h2',
    );
    const origins = await ideasDb.list(testEnv(), A, { kind: 'origin' }, 50, null);
    expect(origins.rows.map((r) => r.title)).toEqual(['Ý tưởng gốc']);
    const variants = await ideasDb.list(testEnv(), A, { kind: 'variant' }, 50, null);
    expect(variants.rows.map((r) => r.title)).toEqual(['Biến thể']);
  });
});

describe('nút đồng bộ index của riêng từng ý tưởng', () => {
  let uid: string;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    uid = (await mkUser('a@example.com')).id;
  });

  it('đồng bộ ĐÚNG ý tưởng được bấm, không phải một ý tưởng bẩn nào khác', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const older = await ideasDb.create(env, uid, { ...BASE, title: 'Cũ hơn' }, 'h1');
    const target = await ideasDb.create(env, uid, { ...BASE, title: 'Vừa sửa' }, 'h2');

    // reconcile(limit = 1) sẽ chọn `older` vì nó cũ hơn. syncIdea phải chọn đúng
    // hàng người dùng bấm — nút trên một thẻ mà làm việc cho thẻ khác là vô nghĩa.
    const r = await syncIdea(env, uid, target.id);
    expect(r?.outcome).toBe('embedded');
    expect(vec.store.has(target.id)).toBe(true);
    expect(vec.store.has(older.id)).toBe(false);
    expect(await ideasDb.countDirty(env, uid)).toBe(1);
  });

  it('bấm lại khi đã sạch thì không làm gì và không gọi AI', async () => {
    const vec = fakeVectorize();
    let embedCalls = 0;
    const env: Env = {
      ...envWith(vec),
      EMBEDDINGS_MODE: 'live',
      AI: {
        run: async (_m: string, input: { text: string[] }) => {
          embedCalls++;
          return { data: input.text.map(() => new Array(1024).fill(0.01)) };
        },
      } as unknown as Ai,
    };
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    expect((await syncIdea(env, uid, idea.id))?.outcome).toBe('embedded');
    expect(embedCalls).toBe(1);

    expect((await syncIdea(env, uid, idea.id))?.outcome).toBe('clean');
    expect(embedCalls, 'hàng đã sạch thì không được nhúng lại').toBe(1);

    // force ghi lại vector kể cả khi D1 tưởng đã sạch — dùng khi vector biến mất
    // khỏi Vectorize mà không cột nào của D1 nhìn thấy được.
    expect((await syncIdea(env, uid, idea.id, true))?.outcome).toBe('meta');
    expect(embedCalls).toBe(1);
  });

  it('đổi kind làm hàng bẩn dù content_hash không đổi, và đồng bộ không tốn AI', async () => {
    // kind nằm trong metadata của vector nhưng KHÔNG nằm trong văn bản nhúng —
    // đúng cái bẫy mà status đã dựng ra. Nếu chữ ký metadata quên kind thì việc
    // đổi một ý tưởng thành biến thể sẽ không bao giờ tới được Vectorize.
    const vec = fakeVectorize();
    let embedCalls = 0;
    const env: Env = {
      ...envWith(vec),
      EMBEDDINGS_MODE: 'live',
      AI: {
        run: async (_m: string, input: { text: string[] }) => {
          embedCalls++;
          return { data: input.text.map(() => new Array(1024).fill(0.01)) };
        },
      } as unknown as Ai,
    };
    const origin = await ideasDb.create(env, uid, BASE, 'h1');
    const child = await ideasDb.create(env, uid, { ...BASE, title: 'Sẽ thành biến thể' }, 'h2');
    await syncIdea(env, uid, origin.id);
    await syncIdea(env, uid, child.id);
    expect(embedCalls).toBe(2);
    expect(await ideasDb.countDirty(env, uid)).toBe(0);
    expect(vec.store.get(child.id)!.metadata['kind']).toBe('origin');

    // content_hash giữ nguyên 'h2' — CHỈ quan hệ cha-con đổi.
    await ideasDb.update(
      env, uid, child.id,
      { ...BASE, title: 'Sẽ thành biến thể', kind: 'variant', parent_id: origin.id },
      'h2',
    );
    expect(await ideasDb.countDirty(env, uid)).toBe(1);

    const fresh = await ideasDb.getById(env, uid, child.id);
    expect(fresh?.kind).toBe('variant');
    expect(metaSignature(fresh!)).toBe('idea|tiktok|private|variant');

    expect((await syncIdea(env, uid, child.id))?.outcome).toBe('meta');
    expect(embedCalls, 'đổi mỗi kind KHÔNG được nhúng lại').toBe(2);
    expect(vec.store.get(child.id)!.metadata['kind']).toBe('variant');
    expect(await ideasDb.countDirty(env, uid)).toBe(0);
  });

  it('bấm đồng bộ trên ý tưởng của người khác trả null để route hoá 404', async () => {
    const vec = fakeVectorize();
    const env = envWith(vec);
    const other = (await mkUser('b@example.com')).id;
    const ideaOfOther = await ideasDb.create(env, other, BASE, 'h1');
    expect(await syncIdea(env, uid, ideaOfOther.id)).toBeNull();
    expect(vec.store.size).toBe(0);
  });

  it('Vectorize hỏng thì báo failed, hàng vẫn nguyên vẹn và vẫn bẩn', async () => {
    const vec = fakeVectorize();
    vec.upsert = async () => {
      throw new Error('Vectorize không với tới được');
    };
    const env = envWith(vec);
    const idea = await ideasDb.create(env, uid, BASE, 'h1');
    const r = await syncIdea(env, uid, idea.id);
    expect(r?.outcome).toBe('failed');
    expect(r?.indexed).toBe(false);
    const row = await ideasDb.getById(env, uid, idea.id);
    expect(row?.title).toBe(BASE.title);
    expect(row?.embed_attempts).toBe(1);
    expect(await ideasDb.countDirty(env, uid)).toBe(1);
  });
});

describe('quản lý danh mục video hook', () => {
  let A: string;
  let B: string;
  let ideaId: string;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    A = (await mkUser('a@example.com')).id;
    B = (await mkUser('b@example.com')).id;
    ideaId = (await ideasDb.create(testEnv(), A, BASE, 'h1')).id;
  });

  const texts = async (uid = A, iid = ideaId) =>
    (await hooksDb.listHooks(testEnv(), uid, iid)).map((h) => h.text);

  it('thêm hook nối vào cuối danh mục, không chen ngang', async () => {
    for (const t of ['hook 1', 'hook 2', 'hook 3']) {
      expect(await hooksDb.addHook(testEnv(), A, ideaId, t)).not.toBeNull();
    }
    expect(await texts()).toEqual(['hook 1', 'hook 2', 'hook 3']);
    // position phải tăng dần chứ không cùng bằng 0 — nếu tính ở tầng ứng dụng thay
    // vì trong câu lệnh thì hai lần thêm liên tiếp sẽ nhận cùng một số.
    expect((await hooksDb.listHooks(testEnv(), A, ideaId)).map((h) => h.position))
      .toEqual([0, 1, 2]);
  });

  it('sửa đúng một dòng, không đụng các dòng còn lại', async () => {
    const a = await hooksDb.addHook(testEnv(), A, ideaId, 'hook 1');
    await hooksDb.addHook(testEnv(), A, ideaId, 'hook 2');
    expect(await hooksDb.updateHook(testEnv(), A, ideaId, a!.id, 'hook 1 đã sửa')).toBe(true);
    expect(await texts()).toEqual(['hook 1 đã sửa', 'hook 2']);
  });

  it('xoá một dòng không làm hỏng thứ tự các dòng còn lại', async () => {
    await hooksDb.addHook(testEnv(), A, ideaId, 'hook 1');
    const b = await hooksDb.addHook(testEnv(), A, ideaId, 'hook 2');
    await hooksDb.addHook(testEnv(), A, ideaId, 'hook 3');
    expect(await hooksDb.removeHook(testEnv(), A, ideaId, b!.id)).toBe(true);
    expect(await texts()).toEqual(['hook 1', 'hook 3']);
  });

  it('đổi thứ tự lên/xuống, và dừng đúng ở hai đầu danh mục', async () => {
    const a = await hooksDb.addHook(testEnv(), A, ideaId, 'hook 1');
    const b = await hooksDb.addHook(testEnv(), A, ideaId, 'hook 2');
    const c = await hooksDb.addHook(testEnv(), A, ideaId, 'hook 3');

    expect(await hooksDb.moveHook(testEnv(), A, ideaId, c!.id, 'up')).toBe(true);
    expect(await texts()).toEqual(['hook 1', 'hook 3', 'hook 2']);
    expect(await hooksDb.moveHook(testEnv(), A, ideaId, a!.id, 'down')).toBe(true);
    expect(await texts()).toEqual(['hook 3', 'hook 1', 'hook 2']);

    // Đã ở đầu/cuối thì báo false chứ không im lặng làm hỏng thứ tự.
    expect(await hooksDb.moveHook(testEnv(), A, ideaId, c!.id, 'up')).toBe(false);
    expect(await hooksDb.moveHook(testEnv(), A, ideaId, b!.id, 'down')).toBe(false);
    expect(await texts()).toEqual(['hook 3', 'hook 1', 'hook 2']);
  });

  it('đổi thứ tự chuẩn hoá luôn position bị trùng do dữ liệu cũ để lại', async () => {
    // setIdeaHooks cũ và các đường ghi khác có thể để lại position trùng nhau. Nếu
    // moveHook chỉ hoán đổi hai hàng thì hai hàng cùng position sẽ kẹt vĩnh viễn.
    await hooksDb.addHook(testEnv(), A, ideaId, 'x');
    await hooksDb.addHook(testEnv(), A, ideaId, 'y');
    const z = await hooksDb.addHook(testEnv(), A, ideaId, 'z');
    await testEnv().DB.prepare('UPDATE idea_hooks SET position = 0').run();

    expect(await hooksDb.moveHook(testEnv(), A, ideaId, z!.id, 'up')).toBe(true);
    expect((await hooksDb.listHooks(testEnv(), A, ideaId)).map((h) => h.position))
      .toEqual([0, 1, 2]);
  });

  it('B không thêm, sửa, xoá hay đổi thứ tự hook trên ý tưởng của A', async () => {
    const a = await hooksDb.addHook(testEnv(), A, ideaId, 'hook của A');
    await hooksDb.addHook(testEnv(), A, ideaId, 'hook thứ hai của A');

    expect(await hooksDb.addHook(testEnv(), B, ideaId, 'chiếm chỗ')).toBeNull();
    expect(await hooksDb.updateHook(testEnv(), B, ideaId, a!.id, 'bị sửa trộm')).toBe(false);
    expect(await hooksDb.removeHook(testEnv(), B, ideaId, a!.id)).toBe(false);
    expect(await hooksDb.moveHook(testEnv(), B, ideaId, a!.id, 'down')).toBe(false);

    expect(await texts()).toEqual(['hook của A', 'hook thứ hai của A']);
    expect(await texts(B)).toEqual([]);
  });

  it('MỌI thay đổi hook đều làm ý tưởng bẩn trở lại', async () => {
    // Đây là bất biến dễ vỡ nhất của tính năng này: hook nằm trong văn bản đem đi
    // nhúng nhưng ở bảng khác, nên không cột nào của `ideas` nhúc nhích khi hook
    // đổi. Quên rehash là vector mốc lại vĩnh viễn mà không có dấu hiệu gì.
    const clean = async () => {
      await ideasDb.markEmbedded(
        testEnv(),
        ideaId,
        (await ideasDb.getById(testEnv(), A, ideaId))!.content_hash,
        'model-gia',
      );
      expect(await ideasDb.countDirty(testEnv(), A)).toBe(0);
    };

    await rehashIdea(testEnv(), A, ideaId);
    await clean();

    const h = await hooksDb.addHook(testEnv(), A, ideaId, 'hook mới');
    await rehashIdea(testEnv(), A, ideaId);
    expect(await ideasDb.countDirty(testEnv(), A), 'thêm hook').toBe(1);
    await clean();

    await hooksDb.updateHook(testEnv(), A, ideaId, h!.id, 'hook đã sửa');
    await rehashIdea(testEnv(), A, ideaId);
    expect(await ideasDb.countDirty(testEnv(), A), 'sửa hook').toBe(1);
    await clean();

    await hooksDb.addHook(testEnv(), A, ideaId, 'hook thứ hai');
    await rehashIdea(testEnv(), A, ideaId);
    await clean();
    await hooksDb.moveHook(testEnv(), A, ideaId, h!.id, 'down');
    await rehashIdea(testEnv(), A, ideaId);
    expect(await ideasDb.countDirty(testEnv(), A), 'đổi thứ tự hook').toBe(1);
    await clean();

    await hooksDb.removeHook(testEnv(), A, ideaId, h!.id);
    await rehashIdea(testEnv(), A, ideaId);
    expect(await ideasDb.countDirty(testEnv(), A), 'xoá hook').toBe(1);
  });

  it('hash mà rehashIdea ghi ra khớp đúng hash lúc đối soát', async () => {
    // Hai đường phải dùng chung buildEmbedText. Lệch nhau thì hàng bẩn vĩnh viễn:
    // đồng bộ xong lại thành bẩn ngay, và nút đồng bộ không bao giờ tắt được.
    await hooksDb.addHook(testEnv(), A, ideaId, 'hook 1');
    await hooksDb.addHook(testEnv(), A, ideaId, 'hook 2');
    await rehashIdea(testEnv(), A, ideaId);

    const row = (await ideasDb.getById(testEnv(), A, ideaId))!;
    const expected = await contentHash(buildEmbedText(row, [], ['hook 1', 'hook 2']));
    expect(row.content_hash).toBe(expected);
  });

  it('xoá ý tưởng thì danh mục hook của nó đi theo', async () => {
    await hooksDb.addHook(testEnv(), A, ideaId, 'hook 1');
    await ideasDb.remove(testEnv(), A, ideaId);
    const n = await testEnv().DB.prepare('SELECT COUNT(*) AS n FROM idea_hooks')
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('xoá ý tưởng gốc thì hook của các biến thể cũng đi theo', async () => {
    const v = await ideasDb.create(
      testEnv(), A, { ...BASE, kind: 'variant', parent_id: ideaId }, 'h2',
    );
    await hooksDb.addHook(testEnv(), A, v.id, 'hook của biến thể');
    await ideasDb.remove(testEnv(), A, ideaId);
    const n = await testEnv().DB.prepare('SELECT COUNT(*) AS n FROM idea_hooks')
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
