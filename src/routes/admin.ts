import type { Ctx } from '../http/guard';
import { readJson, requireAdmin, requireUser } from '../http/guard';
import { badRequest } from '../http/response';
import * as ideasDb from '../db/ideas';
import { sweepExpiredSessions } from '../auth/session';
import { sweepRateLimits } from '../auth/ratelimit';
import { drainVectorGc, reconcile } from '../vec/sync';

export async function health(c: Ctx): Promise<Response> {
  const out: Record<string, unknown> = { ok: true, env: c.env.APP_ENV };
  try {
    const row = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM ideas
                WHERE embedded_hash IS NULL OR embedded_hash <> content_hash) AS dirty_ideas,
              (SELECT COUNT(*) FROM vector_gc)  AS gc_pending,
              (SELECT COUNT(*) FROM sessions WHERE expires_at > ?1) AS sessions_active`,
    )
      .bind(Date.now())
      .first<{ dirty_ideas: number; gc_pending: number; sessions_active: number }>();
    out['d1'] = 'ok';
    Object.assign(out, row ?? {});
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

/** Đối soát cho chính người dùng đang đăng nhập — nút "Đồng bộ lại index" trên UI. */
export async function reindexMine(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const result = await reconcile(c.env, 50, user.id);
  return c.json(result);
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
    // Ép mọi hàng thành bẩn rồi mới đối soát — đây cũng là quy trình đổi model.
    await ideasDb.markAllDirty(c.env, userId);
  } else if (scope !== 'dirty' && scope !== 'user') {
    throw badRequest('invalid_scope', 'scope phải là dirty, all hoặc user.');
  }

  const result = await reconcile(c.env, limit, userId);
  const gc = await drainVectorGc(c.env, 100);
  return c.json({ ...result, gc_drained: gc });
}

/**
 * Điểm vào cho công việc định kỳ. Pages Functions KHÔNG có cron trigger, nên
 * endpoint này được đánh thức bởi Worker riêng trong cron-worker/ (xem README).
 */
export async function cron(c: Ctx): Promise<Response> {
  requireAdmin(c);
  const [sessionsGc, rateGc, vecGc] = await Promise.all([
    sweepExpiredSessions(c.env, 500),
    sweepRateLimits(c.env),
    drainVectorGc(c.env, 100),
  ]);
  const reindexed = await reconcile(c.env, 50);
  return c.json({
    sessions_gc: sessionsGc,
    rate_gc: rateGc,
    vector_gc: vecGc,
    reindexed,
  });
}
