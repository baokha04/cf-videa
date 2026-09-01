/**
 * Đồng hồ cho cf-videa.
 *
 * Pages Functions không có cron trigger, nên các việc định kỳ — dọn phiên hết hạn,
 * dọn bảng rate limit, rút hàng đợi vector mồ côi, đối soát ý tưởng chưa index —
 * không có gì đánh thức chúng. Worker độc lập này giải đúng chỗ đó.
 *
 * VÌ SAO GỌI THẲNG HÀM CHỨ KHÔNG GỌI HTTP SANG APP PAGES:
 * Bản đầu tiên fetch() tới POST /api/admin/cron của app Pages. Nó im lặng không
 * làm gì suốt nhiều chu kỳ: lịch cron có đăng ký, endpoint gọi tay thì chạy đúng,
 * nhưng đường qua worker thì không — và không chẩn đoán được vì log không lấy được.
 *
 * Vấn đề là chính kiến trúc đó: một chặng mạng, một secret dùng chung, và một lớp
 * xác thực nữa, tất cả chỉ để gọi đoạn code nằm ngay trong cùng repo. Vì `src/`
 * cố ý không import gì từ Pages, Worker này import thẳng được các hàm đó và chạy
 * trên binding của chính nó. Ít bộ phận hơn, không dùng chung secret, không có
 * chặng mạng nào để hỏng — và vẫn là đúng một bản code, không nhân bản logic.
 */
import type { Env } from '../../src/types';
import { sweepExpiredSessions } from '../../src/auth/session';
import { sweepRateLimits } from '../../src/auth/ratelimit';
import { drainVectorGc, reconcile } from '../../src/vec/sync';

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // await thẳng, không dùng waitUntil: runtime chờ promise mà scheduled() trả về,
    // nên đây là cách chắc chắn công việc chạy xong trước khi isolate bị thu hồi.
    const sessions = await sweepExpiredSessions(env, 500);
    const rate = await sweepRateLimits(env);
    const gc = await drainVectorGc(env, 100);
    const reindexed = await reconcile(env, 50);
    console.log(
      JSON.stringify({ sessions_gc: sessions, rate_gc: rate, vector_gc: gc, reindexed }),
    );
  },
} satisfies ExportedHandler<Env>;
