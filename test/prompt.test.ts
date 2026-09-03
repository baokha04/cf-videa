import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, testEnv } from './helpers';
import {
  DEFAULT_TEMPLATE,
  TEMPLATE_VARS,
  buildPrompt,
  getTemplate,
  render,
  resetTemplate,
  saveTemplate,
  unknownVars,
} from '../src/prompt';
import { hashPassword } from '../src/auth/password';
import * as usersDb from '../src/db/users';
import type { HookRow } from '../src/db/hooks';
import type { VariantRow } from '../src/db/variants';
import type { IdeaRow } from '../src/types';

const idea = {
  id: 'i1', user_id: 'u1', title: 'Bữa sáng yến mạch', script_outline: 'Dàn ý GỐC',
  platform: 'tiktok', niche: 'ẩm thực', status: 'idea', visibility: 'private', lang: 'vi',
  content_hash: 'h', embedded_hash: null, indexed_meta_hash: null, embedding_model: null,
  embedded_at: null, embed_attempts: 0, created_at: 0, updated_at: 0,
} as IdeaRow;

const variant = {
  id: 'v1', idea_id: 'i1', user_id: 'u1', title: 'Phiên bản POV',
  angle: 'Quay từ góc nhìn người ăn', script_outline: '', sort_order: 0,
  created_at: 0, updated_at: 0,
} as VariantRow;

const hook = {
  id: 'k1', user_id: 'u1', category_id: 'c1', text: 'Bạn đang bỏ bữa sáng vì nghĩ không kịp?',
  note: '', created_at: 0, updated_at: 0,
} as HookRow;

const parts = { idea, variant, hook, hookCategoryName: 'Câu hỏi', tags: ['ăn sáng', 'nhanh'] };

describe('ghép prompt', () => {
  it('thay đủ mọi biến của mẫu mặc định', () => {
    const out = buildPrompt(DEFAULT_TEMPLATE, parts);
    expect(out).toContain('Bữa sáng yến mạch');
    expect(out).toContain('Phiên bản POV');
    expect(out).toContain('Bạn đang bỏ bữa sáng vì nghĩ không kịp?');
    expect(out).toContain('Quay từ góc nhìn người ăn');
    expect(out).toContain('ăn sáng, nhanh');
    // Không được sót placeholder nào chưa thay.
    expect(out).not.toMatch(/\{\{/);
  });

  it('dàn ý của biến thể GHI ĐÈ dàn ý gốc, để trống thì kế thừa', () => {
    // Đây là quy tắc chính khiến biến thể vừa gọn khi không cần, vừa đủ khi cần.
    expect(buildPrompt('{{script}}', parts)).toBe('Dàn ý GỐC');
    const withOwn = { ...parts, variant: { ...variant, script_outline: 'Dàn ý RIÊNG' } };
    expect(buildPrompt('{{script}}', withOwn)).toBe('Dàn ý RIÊNG');
    // Chỉ có khoảng trắng thì vẫn coi là để trống.
    const blank = { ...parts, variant: { ...variant, script_outline: '   \n  ' } };
    expect(buildPrompt('{{script}}', blank)).toBe('Dàn ý GỐC');
  });

  it('không có hook thì vẫn ghép được, phần hook bỏ trống', () => {
    const out = buildPrompt('[{{hook}}]', { ...parts, hook: null, hookCategoryName: null });
    expect(out).toBe('[]');
  });

  it('biến lạ được GIỮ NGUYÊN chứ không xoá âm thầm', () => {
    // Gõ sai tên biến mà bị xoá thì người dùng chỉ thấy prompt thiếu một mảng và
    // không hiểu vì sao; để nguyên là tự nó chỉ ra lỗi.
    expect(buildPrompt('A {{tieu_de}} B', parts)).toBe('A {{tieu_de}} B');
    expect(unknownVars('{{idea_title}} {{tieu_de}} {{xyz}}').sort()).toEqual(['tieu_de', 'xyz']);
    expect(unknownVars(DEFAULT_TEMPLATE)).toEqual([]);
  });

  it('chấp nhận khoảng trắng trong dấu ngoặc', () => {
    expect(render('{{ idea_title }}', { idea_title: 'X' })).toBe('X');
  });

  it('giá trị thay vào KHÔNG bị quét lại', () => {
    // Nội dung người dùng chứa {{...}} không được kích hoạt vòng thay thế thứ hai,
    // nếu không thì một ý tưởng đặt tên là "{{hook}}" sẽ tự chèn hook vào chỗ khác.
    const tricky = { ...parts, idea: { ...idea, title: '{{hook}}' } };
    expect(buildPrompt('{{idea_title}}', tricky)).toBe('{{hook}}');
  });

  it('mọi biến khai báo đều thay được, không có biến chết', () => {
    const template = TEMPLATE_VARS.map((v) => `${v}={{${v}}}`).join('\n');
    const out = buildPrompt(template, parts);
    expect(out).not.toMatch(/\{\{/);
  });
});

describe('lưu mẫu prompt', () => {
  let uid: string;
  beforeEach(async () => {
    await migrate();
    await testEnv().DB.prepare('DELETE FROM users').run();
    const u = await usersDb.insert(testEnv(), 'a@example.com', await hashPassword('x', 1000), null);
    uid = u!.id;
  });

  it('chưa từng sửa thì trả mẫu mặc định', async () => {
    expect(await getTemplate(testEnv(), uid)).toBe(DEFAULT_TEMPLATE);
  });

  it('lưu rồi đọc lại đúng, đặt lại thì về mặc định', async () => {
    await saveTemplate(testEnv(), uid, 'MẪU RIÊNG {{hook}}');
    expect(await getTemplate(testEnv(), uid)).toBe('MẪU RIÊNG {{hook}}');
    await saveTemplate(testEnv(), uid, 'GHI ĐÈ');
    expect(await getTemplate(testEnv(), uid)).toBe('GHI ĐÈ');
    await resetTemplate(testEnv(), uid);
    expect(await getTemplate(testEnv(), uid)).toBe(DEFAULT_TEMPLATE);
  });

  it('mẫu của người này không lẫn sang người kia', async () => {
    const b = await usersDb.insert(testEnv(), 'b@example.com', await hashPassword('x', 1000), null);
    await saveTemplate(testEnv(), uid, 'CỦA A');
    expect(await getTemplate(testEnv(), b!.id)).toBe(DEFAULT_TEMPLATE);
  });
});
