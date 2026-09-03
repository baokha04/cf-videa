import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import * as likesDb from '../src/db/likes';
import { setIdeaTags, listTags, tagsForIdeas } from '../src/db/tags';
import * as hooksDb from '../src/db/hooks';
import * as variantsDb from '../src/db/variants';

/**
 * Ma trận cách ly đa người dùng. Đây là bất biến bảo mật quan trọng nhất của app:
 * mọi truy vấn phải ràng buộc user_id NGAY TRONG câu lệnh, và không khớp thì phải
 * cư xử như "không tồn tại" chứ không phải "bị cấm".
 */

const INPUT = {
  title: 'Bí mật của A',
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

  it('tagsForIdeas không trả tag chéo tài khoản, kể cả khi bị gọi với id lạ', async () => {
    // Hàm này không nhận userId vì nó cũng phục vụ đối soát toàn hệ thống. Bảo đảm
    // nằm trong phép join i.user_id = t.user_id, nên gọi sai cũng không rò rỉ được.
    await setIdeaTags(testEnv(), A.id, ideaOfA.id, ['bí-mật-của-a']);
    // Cố tình gán một tag của B cho ý tưởng của A ở tầng thấp nhất — mô phỏng lỗi
    // dữ liệu hoặc một lối gọi sai trong tương lai.
    const tagB = await testEnv()
      .DB.prepare(`INSERT INTO tags (id, user_id, name, created_at)
                   VALUES ('tag-cua-b', ?1, 'tag-cua-b', 0) RETURNING id`)
      .bind(B.id).first<{ id: string }>();
    await testEnv()
      .DB.prepare(`INSERT INTO idea_tags (idea_id, tag_id) VALUES (?1, ?2)`)
      .bind(ideaOfA.id, tagB!.id).run();

    const map = await tagsForIdeas(testEnv(), [ideaOfA.id]);
    expect(map.get(ideaOfA.id)).toEqual(['bí-mật-của-a']);
  });

  it('lọc theo tag không lấy được ý tưởng của người khác qua tag cùng tên', async () => {
    await setIdeaTags(testEnv(), A.id, ideaOfA.id, ['mẹo']);
    const ideaOfB = await ideasDb.create(testEnv(), B.id, INPUT, 'hash-b');
    await setIdeaTags(testEnv(), B.id, ideaOfB.id, ['mẹo']);
    const { rows } = await ideasDb.list(testEnv(), B.id, { tag: 'mẹo' }, 50, null);
    expect(rows.map((r) => r.id)).toEqual([ideaOfB.id]);
  });
});

describe('cách ly hooks và biến thể', () => {
  let A: { id: string };
  let B: { id: string };

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    A = await mkUser('a@example.com');
    B = await mkUser('b@example.com');
  });

  it('B không đọc/sửa/xoá được hook của A', async () => {
    const h = await hooksDb.createHook(testEnv(), A.id, {
      text: 'Hook bí mật của A', note: '', category_id: null,
    });
    expect(await hooksDb.getHook(testEnv(), B.id, h!.id)).toBeNull();
    expect(await hooksDb.updateHook(testEnv(), B.id, h!.id, {
      text: 'chiếm đoạt', note: '', category_id: null,
    })).toBe(false);
    expect(await hooksDb.deleteHook(testEnv(), B.id, h!.id)).toBe(false);
    expect((await hooksDb.getHook(testEnv(), A.id, h!.id))?.text).toBe('Hook bí mật của A');
  });

  it('danh mục hook không lẫn giữa hai tài khoản', async () => {
    await hooksDb.createCategory(testEnv(), A.id, 'Câu hỏi', 0);
    expect(await hooksDb.listCategories(testEnv(), B.id)).toHaveLength(0);
    // Cùng tên vẫn tạo được cho người khác — UNIQUE là (user_id, name).
    expect(await hooksDb.createCategory(testEnv(), B.id, 'Câu hỏi', 0)).not.toBeNull();
  });

  it('KHÔNG gán được hook của mình vào danh mục của người khác', async () => {
    // Khoá ngoại chỉ bảo đảm danh mục TỒN TẠI, không bảo đảm nó là của ai. Nếu chỗ
    // này lọt thì hook của B sẽ hiện trong danh mục của A.
    const catA = await hooksDb.createCategory(testEnv(), A.id, 'Của A', 0);
    expect(await hooksDb.createHook(testEnv(), B.id, {
      text: 'x', note: '', category_id: catA!.id,
    })).toBeNull();

    const hookB = await hooksDb.createHook(testEnv(), B.id, {
      text: 'y', note: '', category_id: null,
    });
    expect(await hooksDb.updateHook(testEnv(), B.id, hookB!.id, {
      text: 'y', note: '', category_id: catA!.id,
    })).toBe(false);
  });

  it('xoá danh mục KHÔNG xoá hook, chúng rơi về nhóm chưa phân loại', async () => {
    const cat = await hooksDb.createCategory(testEnv(), A.id, 'Tạm', 0);
    const h = await hooksDb.createHook(testEnv(), A.id, {
      text: 'giữ lại tôi', note: '', category_id: cat!.id,
    });
    await hooksDb.deleteCategory(testEnv(), A.id, cat!.id);
    const fresh = await hooksDb.getHook(testEnv(), A.id, h!.id);
    expect(fresh?.text).toBe('giữ lại tôi');
    expect(fresh?.category_id).toBeNull();
  });

  it('B không tạo được biến thể trên ý tưởng của A', async () => {
    const ideaA = await ideasDb.create(testEnv(), A.id, INPUT, 'ha');
    expect(await variantsDb.create(testEnv(), B.id, ideaA.id, {
      title: 'chiếm đoạt', angle: '', script_outline: '', sort_order: 0,
    })).toBeNull();
  });

  it('B không đọc/sửa/xoá được biến thể của A', async () => {
    const ideaA = await ideasDb.create(testEnv(), A.id, INPUT, 'ha');
    const v = await variantsDb.create(testEnv(), A.id, ideaA.id, {
      title: 'Biến thể của A', angle: '', script_outline: '', sort_order: 0,
    });
    expect(await variantsDb.getById(testEnv(), B.id, v!.id)).toBeNull();
    expect(await variantsDb.update(testEnv(), B.id, v!.id, {
      title: 'x', angle: '', script_outline: '', sort_order: 0,
    })).toBe(false);
    expect(await variantsDb.remove(testEnv(), B.id, v!.id)).toBe(false);
    expect(await variantsDb.listForIdea(testEnv(), B.id, ideaA.id)).toHaveLength(0);
  });

  it('xoá ý tưởng thì biến thể bị xoá theo', async () => {
    const ideaA = await ideasDb.create(testEnv(), A.id, INPUT, 'ha');
    await variantsDb.create(testEnv(), A.id, ideaA.id, {
      title: 'v', angle: '', script_outline: '', sort_order: 0,
    });
    await ideasDb.remove(testEnv(), A.id, ideaA.id);
    const { results } = await testEnv().DB.prepare('SELECT id FROM idea_variants').all();
    expect(results).toHaveLength(0);
  });
});
