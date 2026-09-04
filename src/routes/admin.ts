import type { Ctx } from '../http/guard';
import { readJson, requireAdmin, requireUser } from '../http/guard';
import { badRequest } from '../http/response';
import * as ideasDb from '../db/ideas';
import * as hooksDb from '../db/hooks';
import * as variantsDb from '../db/variants';
import { recordMaintenanceRun, sweepExpiredSessions } from '../auth/session';
import { sweepRateLimits } from '../auth/ratelimit';
import { drainVectorGc, reconcileAll } from '../vec/sync';
import {
  DEFAULT_TEMPLATE,
  TEMPLATE_VARS,
  getTemplate,
  resetTemplate,
  saveTemplate,
  unknownVars,
} from '../prompt';

export async function health(c: Ctx): Promise<Response> {
  const out: Record<string, unknown> = { ok: true, env: c.env.APP_ENV };
  try {
    // Dùng lại đúng ba hằng DIRTY_SQL thay vì viết lại điều kiện: bản viết tay trước
    // đây thiếu vế indexed_meta_hash, nên /api/health báo ít hơn /api/sync với cùng một
    // database mà không ai biết vì sao.
    const row = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM ideas WHERE ${ideasDb.DIRTY_SQL})         AS dirty_ideas,
              (SELECT COUNT(*) FROM idea_variants WHERE ${variantsDb.VARIANT_DIRTY_SQL})
                AS dirty_variants,
              (SELECT COUNT(*) FROM hooks WHERE ${hooksDb.HOOK_DIRTY_SQL})    AS dirty_hooks,
              (SELECT COUNT(*) FROM vector_gc)  AS gc_pending,
              (SELECT COUNT(*) FROM sessions WHERE expires_at > ?1) AS sessions_active,
              (SELECT ran_at FROM maintenance_runs WHERE id = 1)    AS maintenance_last_run_at,
              (SELECT source FROM maintenance_runs WHERE id = 1)    AS maintenance_last_source`,
    )
      .bind(Date.now())
      .first<{
        dirty_ideas: number;
        dirty_variants: number;
        dirty_hooks: number;
        gc_pending: number;
        sessions_active: number;
        maintenance_last_run_at: number | null;
        maintenance_last_source: string | null;
      }>();
    out['d1'] = 'ok';
    Object.assign(out, row ?? {});

    // Cố ý KHÔNG có cờ "quá hạn": việc bảo trì chạy cơ hội theo lưu lượng chứ không
    // theo lịch, nên mọi ngưỡng thời gian đều là tùy tiện. Con số đáng theo dõi là
    // dirty_ideas và gc_pending ở trên — chúng nói thẳng còn tồn đọng bao nhiêu.
  } catch (err) {
    out['ok'] = false;
    out['d1'] = `error: ${String(err).slice(0, 120)}`;
  }
  // Kiểm tra binding có mặt hay không — đây là cách bắt được lỗi Pages kinh điển
  // "binding khai báo ở cấp cao nhất nhưng quên trong env.production".
  out['vectorize'] = c.env.VEC ? 'bound' : 'MISSING';
  out['ai'] = c.env.AI ? 'bound' : 'MISSING';
  if (!c.env.VEC || !c.env.AI) out['ok'] = false;
  return c.json(out, out['ok'] ? 200 : 503);
}

/**
 * Mẫu prompt của người dùng. Chưa từng sửa thì trả mẫu mặc định — giao diện không
 * cần biết phân biệt hai trường hợp đó.
 */
export async function getPromptTemplate(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await getTemplate(c.env, user.id);
  return c.json({
    body,
    is_default: body === DEFAULT_TEMPLATE,
    variables: TEMPLATE_VARS,
    unknown: unknownVars(body),
  });
}

export async function savePromptTemplate(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const body = await readJson(c);
  const text = body['body'];
  if (typeof text !== 'string' || text.trim() === '') {
    throw badRequest('invalid_template', 'Mẫu prompt không được để trống.');
  }
  if (text.length > 20_000) {
    throw badRequest('invalid_template', 'Mẫu prompt tối đa 20.000 ký tự.');
  }
  await saveTemplate(c.env, user.id, text);
  // Trả về danh sách biến lạ để giao diện cảnh báo gõ sai tên biến ngay lúc lưu.
  return c.json({ ok: true, unknown: unknownVars(text) });
}

export async function resetPromptTemplate(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  await resetTemplate(c.env, user.id);
  return c.json({ body: DEFAULT_TEMPLATE, is_default: true });
}

/**
 * Trạng thái đồng bộ CỦA CHÍNH người dùng đang đăng nhập, tách theo từng loại.
 *
 * Cố ý không dùng `dirty_ideas` của /api/health cho việc này: con số đó đếm toàn hệ
 * thống và endpoint đó lại công khai, nên vừa sai (lẫn ý tưởng của người khác) vừa
 * không nên là nguồn dữ liệu cho một tài khoản cụ thể.
 *
 * Giao diện không còn thanh đồng bộ hàng loạt — mỗi mục tự index bằng nút của nó — nên
 * endpoint này còn lại đúng một việc: soi trạng thái (smoke test, chẩn đoán tay).
 */
export async function syncStatus(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const [ideas, variants, hooks] = await Promise.all([
    ideasDb.countDirty(c.env, user.id),
    variantsDb.countDirty(c.env, user.id),
    hooksDb.countDirty(c.env, user.id),
  ]);
  return c.json({ dirty: ideas + variants + hooks, by_type: { ideas, variants, hooks } });
}

/** Đối soát toàn hệ thống — chỉ dành cho ADMIN_TOKEN. */
export async function reindexAdmin(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
  const scope = body['scope'] ?? 'dirty';
  const limitRaw = Number(body['limit'] ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 100;
  const userId = typeof body['user_id'] === 'string' ? (body['user_id'] as string) : undefined;

  if (scope === 'all') {
    // Ép mọi hàng thành bẩn rồi mới đối soát — đây cũng là quy trình đổi model, và là
    // cách chạy lại sau khi thêm một metadata index mới trên Vectorize.
    await Promise.all([
      ideasDb.markAllDirty(c.env, userId),
      variantsDb.markAllDirty(c.env, userId),
      hooksDb.markAllDirty(c.env, userId),
    ]);
  } else if (scope !== 'dirty' && scope !== 'user') {
    throw badRequest('invalid_scope', 'scope phải là dirty, all hoặc user.');
  }

  const result = await reconcileAll(c.env, limit, userId);
  const gc = await drainVectorGc(c.env, 100);
  return c.json({ ...result, gc_drained: gc });
}

/**
 * Chạy tay toàn bộ việc bảo trì.
 *
 * Pages Functions không có cron trigger, và dự án cố ý KHÔNG dựng Worker riêng chỉ
 * để có lịch: cùng những việc này đã chạy theo kiểu cơ hội trên một phần nhỏ số lần
 * đăng nhập (xem src/routes/auth.ts), còn việc index ý tưởng thì người dùng bấm nút
 * "Index" của từng mục khi cần. Endpoint này là đường quét toàn bộ một lần, dùng khi
 * muốn dọn ngay thay vì chờ lưu lượng.
 */
export async function maintenance(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const [sessionsGc, rateGc, vecGc] = await Promise.all([
    sweepExpiredSessions(c.env, 500),
    sweepRateLimits(c.env),
    drainVectorGc(c.env, 100),
  ]);
  const reindexed = await reconcileAll(c.env, 50);
  await recordMaintenanceRun(
    c.env,
    { sessions: sessionsGc, rate: rateGc, vector: vecGc, reindexed: reindexed.processed },
    'manual',
  );
  return c.json({
    sessions_gc: sessionsGc,
    rate_gc: rateGc,
    vector_gc: vecGc,
    reindexed,
  });
}
