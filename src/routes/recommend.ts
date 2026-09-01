import type { Ctx } from '../http/guard';
import { requireUser } from '../http/guard';
import * as ideasDb from '../db/ideas';
import * as likesDb from '../db/likes';
import { queryIdeas } from '../vec/index';
import { getTasteVector } from '../vec/profile';
import { hydrate } from './ideas';
import { clampLimit } from '../util/validate';

/**
 * Gợi ý cá nhân hoá. KHÔNG có LLM: chỉ là truy vấn láng giềng gần nhất quanh
 * trung bình cộng các vector ý tưởng mà người dùng đã thích.
 *
 * GIỚI HẠN SẢN PHẨM CẦN NÓI THẲNG: vì mọi ý tưởng đều riêng tư của tác giả, tính
 * năng này chỉ khơi lại ý tưởng của CHÍNH người dùng mà họ chưa thích — nó là
 * "khơi lại ý tưởng cũ bạn đã quên", không phải "khám phá ý tưởng mới". Giao diện
 * phải nói đúng như vậy. Muốn có kho chung thật thì bật visibility='public' và
 * mở rộng filter; cột và metadata index cho việc đó đã sẵn sàng từ ngày đầu.
 */
export async function recommendations(c: Ctx): Promise<Response> {
  const user = requireUser(c);
  const limit = clampLimit(c.req.query('limit') ?? null);

  const taste = await getTasteVector(c.env, user.id);

  // Chưa thích ý tưởng nào → không bao giờ trả danh sách rỗng cho người mới.
  if (!taste) {
    const { rows } = await ideasDb.list(c.env, user.id, { status: 'idea' }, limit, null);
    return c.json({
      items: await hydrate(c, user.id, rows),
      basis: 'cold_start',
      source_count: 0,
      message: 'Hãy thích vài ý tưởng để gợi ý bám sát gu của bạn hơn.',
    });
  }

  const matches = await queryIdeas(c.env, taste.vector, {
    userId: user.id,
    topK: Math.min(limit * 3, 100),
    status: ['idea', 'scripted'],
  });

  const likedIds = new Set(await likesDb.likedIds(c.env, user.id, 200));
  const ids = matches.map((m) => m.id).filter((id) => !likedIds.has(id));
  const rowMap = await ideasDb.getManyByIds(c.env, user.id, ids);
  const scores = new Map(matches.map((m) => [m.id, m.score]));
  const rows = ids
    .map((id) => rowMap.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .slice(0, limit);

  // Đã thích hết mọi thứ khớp → lùi về danh sách mới nhất thay vì trả rỗng.
  if (rows.length === 0) {
    const { rows: recent } = await ideasDb.list(c.env, user.id, { status: 'idea' }, limit, null);
    const fresh = recent.filter((r) => !likedIds.has(r.id));
    return c.json({
      items: await hydrate(c, user.id, fresh),
      basis: 'cold_start',
      source_count: taste.sourceCount,
      message: 'Chưa tìm được ý tưởng nào gần gu bạn mà bạn chưa thích.',
    });
  }

  return c.json({
    items: await hydrate(c, user.id, rows, scores),
    basis: 'likes',
    source_count: taste.sourceCount,
  });
}
