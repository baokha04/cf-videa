import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, testEnv } from './helpers';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import * as ideasDb from '../src/db/ideas';
import type { IdeaRow } from '../src/types';
import * as variantsDb from '../src/db/variants';
import * as hooksDb from '../src/db/hooks';
import { setIdeaTags } from '../src/db/tags';
import { combine } from '../src/combine';

const BASE = {
  title: 'Bữa sáng yến mạch',
  script_outline: 'Dàn ý GỐC',
  platform: 'tiktok' as const,
  niche: 'ẩm thực',
  status: 'idea' as const,
  negative_prompt: 'không dùng nhạc bản quyền',
};

async function mkUser(email: string) {
  const u = await usersDb.insert(testEnv(), email, await hashPassword('x', 1000), null);
  if (!u) throw new Error('không tạo được user');
  return u;
}

describe('kết hợp thành ý tưởng gốc mới', () => {
  let uid: string;
  let idea: IdeaRow;
  let variant: variantsDb.VariantRow;
  let hook: hooksDb.HookRow;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    uid = (await mkUser('a@example.com')).id;
    idea = await ideasDb.create(testEnv(), uid, BASE, 'h1');
    variant = (await variantsDb.create(testEnv(), uid, idea.id, {
      title: 'Phiên bản POV', angle: 'Góc nhìn người ăn', script_outline: '', sort_order: 0,
    }, 'hv'))!;
    hook = (await hooksDb.createHook(testEnv(), uid, {
      text: 'Bạn đang bỏ bữa sáng?', note: '', category_id: null,
    }, 'hh'))!;
  });

  it('lưu thành một hàng ideas MỚI, không chỉ trả về chuỗi prompt', async () => {
    // Đây là điểm khác biệt duy nhất so với GET /api/prompt trước đây.
    const before = (await ideasDb.list(testEnv(), uid, {}, 50, null)).rows.length;
    const res = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: hook.id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const after = await ideasDb.list(testEnv(), uid, {}, 50, null);
    expect(after.rows.length).toBe(before + 1);
    expect(after.rows.some((r) => r.id === res.row.id)).toBe(true);
    expect(res.prompt).toContain('Bạn đang bỏ bữa sáng?');
  });

  it('ghi đủ lineage của cả ba nguồn', async () => {
    const res = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: hook.id,
    });
    if (!res.ok) throw new Error('phải kết hợp được');
    const fresh = await ideasDb.getById(testEnv(), uid, res.row.id);
    expect(fresh?.source_idea_id).toBe(idea.id);
    expect(fresh?.source_variant_id).toBe(variant.id);
    expect(fresh?.source_hook_id).toBe(hook.id);
  });

  it('ý tưởng kết hợp sinh ra ở trạng thái CHƯA index', async () => {
    // Nếu chỗ này hỏng thì ý tưởng mới sẽ không bao giờ hiện ở nút đồng bộ và vĩnh
    // viễn không tìm được bằng tìm kiếm ngữ nghĩa.
    const res = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: null,
    });
    if (!res.ok) throw new Error('phải kết hợp được');
    expect(res.row.embedded_hash).toBeNull();
    expect(await ideasDb.countDirty(testEnv(), uid)).toBeGreaterThan(0);
  });

  it('dàn ý là văn bản thuần: có hook và góc nhìn, KHÔNG có nhãn của mẫu prompt', async () => {
    // Nhét cả chuỗi prompt vào dàn ý thì mọi ý tưởng kết hợp mang chung một khối chữ
    // và vector của chúng xúm lại quanh một điểm.
    const res = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: hook.id,
    });
    if (!res.ok) throw new Error('phải kết hợp được');
    expect(res.row.script_outline).toContain('Bạn đang bỏ bữa sáng?');
    expect(res.row.script_outline).toContain('Góc nhìn người ăn');
    expect(res.row.script_outline).toContain('Dàn ý GỐC');
    expect(res.row.script_outline).not.toContain('SHORT VIDEO PROMPT');
    expect(res.row.script_outline).not.toContain('Vertical 9:16');
  });

  it('kế thừa niche, nền tảng và negative prompt; trạng thái quay về "idea"', async () => {
    await ideasDb.update(testEnv(), uid, idea.id, { ...BASE, status: 'published' }, 'h2');
    const res = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: null,
    });
    if (!res.ok) throw new Error('phải kết hợp được');
    expect(res.row.niche).toBe('ẩm thực');
    expect(res.row.platform).toBe('tiktok');
    expect(res.row.negative_prompt).toBe('không dùng nhạc bản quyền');
    // Bản kết hợp là khởi đầu mới, dù ý tưởng nguồn đã đăng rồi.
    expect(res.row.status).toBe('idea');
  });

  it('sao chép tag của ý tưởng nguồn', async () => {
    await setIdeaTags(testEnv(), uid, idea.id, ['ăn sáng', 'nhanh']);
    const res = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: null,
    });
    if (!res.ok) throw new Error('phải kết hợp được');
    expect(res.tags.sort()).toEqual(['nhanh', 'ăn sáng']);
  });

  it('hook để trống vẫn kết hợp được', async () => {
    const res = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.source_hook_id).toBeNull();
    expect(res.row.script_outline).not.toContain('Hook:');
  });

  it('tiêu đề mặc định ghép từ hai nguồn, và ghi đè được', async () => {
    const auto = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: null,
    });
    if (!auto.ok) throw new Error('phải kết hợp được');
    expect(auto.row.title).toBe('Bữa sáng yến mạch — Phiên bản POV');

    const named = await combine(testEnv(), uid, {
      ideaId: idea.id, variantId: variant.id, hookId: null, title: 'Tên tự đặt',
    });
    if (!named.ok) throw new Error('phải kết hợp được');
    expect(named.row.title).toBe('Tên tự đặt');
  });

  it('biến thể của ý tưởng KHÁC bị từ chối', async () => {
    // Quy tắc kế thừa dàn ý chỉ có nghĩa khi ý tưởng và biến thể là một cặp.
    const other = await ideasDb.create(testEnv(), uid, { ...BASE, title: 'Ý tưởng khác' }, 'h9');
    const res = await combine(testEnv(), uid, {
      ideaId: other.id, variantId: variant.id, hookId: null,
    });
    expect(res).toEqual({ ok: false, error: 'variant_mismatch' });
  });
});

describe('kết hợp: cách ly giữa các tài khoản', () => {
  let A: string;
  let B: string;
  let ideaA: IdeaRow;
  let variantA: variantsDb.VariantRow;
  let hookA: hooksDb.HookRow;

  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    A = (await mkUser('a@example.com')).id;
    B = (await mkUser('b@example.com')).id;
    ideaA = await ideasDb.create(testEnv(), A, BASE, 'ha');
    variantA = (await variantsDb.create(testEnv(), A, ideaA.id, {
      title: 'v của A', angle: '', script_outline: '', sort_order: 0,
    }, 'hv'))!;
    hookA = (await hooksDb.createHook(testEnv(), A, {
      text: 'hook của A', note: '', category_id: null,
    }, 'hh'))!;
  });

  it('B không kết hợp được từ ý tưởng của A', async () => {
    const res = await combine(testEnv(), B, {
      ideaId: ideaA.id, variantId: variantA.id, hookId: null,
    });
    expect(res).toEqual({ ok: false, error: 'idea_not_found' });
  });

  it('B không mượn được biến thể của A cho ý tưởng của mình', async () => {
    const ideaB = await ideasDb.create(testEnv(), B, BASE, 'hb');
    const res = await combine(testEnv(), B, {
      ideaId: ideaB.id, variantId: variantA.id, hookId: null,
    });
    expect(res).toEqual({ ok: false, error: 'variant_not_found' });
  });

  it('B không mượn được hook của A', async () => {
    const ideaB = await ideasDb.create(testEnv(), B, BASE, 'hb');
    const variantB = (await variantsDb.create(testEnv(), B, ideaB.id, {
      title: 'v của B', angle: '', script_outline: '', sort_order: 0,
    }, 'hv'))!;
    const res = await combine(testEnv(), B, {
      ideaId: ideaB.id, variantId: variantB.id, hookId: hookA.id,
    });
    expect(res).toEqual({ ok: false, error: 'hook_not_found' });
  });

  it('không hàng nào của A bị tạo thêm khi B thử kết hợp', async () => {
    await combine(testEnv(), B, { ideaId: ideaA.id, variantId: variantA.id, hookId: null });
    const { rows } = await ideasDb.list(testEnv(), A, {}, 50, null);
    expect(rows).toHaveLength(1);
  });
});
