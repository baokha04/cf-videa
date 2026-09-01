/**
 * Đồng hồ cho cf-videa.
 *
 * Pages Functions không có cron trigger, nên các việc định kỳ (dọn phiên hết hạn,
 * dọn bảng rate limit, rút hàng đợi vector mồ côi, đối soát ý tưởng chưa index)
 * không có gì đánh thức chúng. Worker độc lập này giải đúng chỗ đó và không làm
 * gì khác: toàn bộ logic vẫn nằm trong app Pages, ở /api/admin/cron.
 *
 * Deploy riêng:
 *   cd cron-worker
 *   npx wrangler secret put ADMIN_TOKEN     # PHẢI trùng secret của dự án Pages
 *   npx wrangler deploy
 */

interface Env {
  PAGES_ORIGIN: string;
  ADMIN_TOKEN: string;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },

  // Cho phép kích hoạt thủ công khi cần kiểm tra, vẫn đòi đúng ADMIN_TOKEN.
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get('Authorization') ?? '';
    if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
      return new Response('forbidden', { status: 403 });
    }
    const res = await runCron(env);
    return new Response(res, { headers: { 'Content-Type': 'application/json' } });
  },
} satisfies ExportedHandler<Env>;

async function runCron(env: Env): Promise<string> {
  const url = `${env.PAGES_ORIGIN}/api/admin/cron`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
      // Không có header này thì requireAdmin() từ chối, vì nó chỉ nhận yêu cầu
      // quản trị đến từ ngoài trình duyệt.
      'Sec-Fetch-Site': 'none',
    },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('cron thất bại', res.status, text.slice(0, 500));
  } else {
    console.log('cron ok', text.slice(0, 500));
  }
  return text;
}
