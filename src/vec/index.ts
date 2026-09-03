import type { Env, IdeaRow } from '../types';
import type { HookRow } from '../db/hooks';
import type { VariantRow } from '../db/variants';
import { now } from '../util/id';
import { DIMENSIONS } from './embeddings';

/**
 * CÁCH LY ĐA NGƯỜI DÙNG: dùng metadata filter theo user_id, KHÔNG dùng
 * namespace-per-user. Lý do quyết định: mỗi index chỉ chứa được 1.000 namespace,
 * nên namespace-per-user biến 1.000 người dùng thành trần kiến trúc. Metadata
 * filter không giới hạn số giá trị và kết hợp được nhiều điều kiện trong một truy vấn.
 *
 * BA LOẠI THỰC THỂ, MỘT INDEX: ý tưởng, biến thể và hook đều có vector riêng và nằm
 * chung một index Vectorize, phân biệt bằng metadata `type`. Cũng vì trần 1.000
 * namespace ở trên, và vì ba index riêng nghĩa là ba binding, ba lần tạo metadata
 * index, ba chỗ để quên một cái.
 *
 * CHÚ Ý KHI VẬN HÀNH: metadata index phải được tạo TRƯỚC lần upsert đầu tiên.
 * Vector ghi trước khi index tồn tại sẽ KHÔNG nằm trong index đó, và cách sửa duy
 * nhất là upsert lại toàn bộ. Xem README, phần "Khởi tạo hạ tầng". Điều này áp dụng
 * cho chính `type`: chưa tạo metadata index cho nó thì mọi filter theo `type` trả về
 * rỗng, im lặng, và tìm kiếm trông như bị hỏng.
 */

export type VectorType = 'idea' | 'variant' | 'hook';

/**
 * Id của vector trên Vectorize.
 *
 * Ý tưởng giữ id TRẦN, không tiền tố: vector ý tưởng đã tồn tại từ trước khi có ba
 * loại, và đổi id của chúng nghĩa là bỏ lại một bản sao mồ côi cho mỗi ý tưởng.
 * Hook và biến thể — hai loại mới — mang tiền tố cho dễ đọc khi soi index bằng tay.
 *
 * Tiền tố KHÔNG phải là thứ bảo đảm tính đúng đắn: id đều là UUID v4 nên không thể
 * đụng nhau, và thứ tách các loại ra khi truy vấn là metadata `type`. Tiền tố chỉ để
 * người đọc log không phải tra id ngược về ba bảng mới biết mình đang nhìn cái gì.
 */
export function vectorId(type: VectorType, id: string): string {
  return type === 'idea' ? id : `${type}:${id}`;
}

/** Ngược của vectorId. Id không có tiền tố nào thì đó là ý tưởng. */
export function entityId(vectorId: string): string {
  const i = vectorId.indexOf(':');
  return i < 0 ? vectorId : vectorId.slice(i + 1);
}

interface BaseMeta extends Record<string, VectorizeVectorMetadataValue> {
  user_id: string;
  type: VectorType;
  updated_at: number;
}

export interface IdeaVectorMeta extends BaseMeta {
  status: string;
  platform: string;
  visibility: string;
}

/**
 * Chữ ký metadata của một ý tưởng.
 *
 * Phải khớp CHÍNH XÁC biểu thức trong SQL ở migrations/0004 và src/db/ideas.ts:
 *   status || '|' || platform || '|' || visibility
 * Lệch nhau thì hàng sẽ hoặc bẩn vĩnh viễn, hoặc không bao giờ được đồng bộ lại.
 *
 * `type` không có mặt trong chữ ký vì nó là hằng của cả bảng — nó không đổi được cho
 * một hàng, nên không có gì để theo dõi.
 */
export function metaSignature(
  idea: Pick<IdeaRow, 'status' | 'platform' | 'visibility'>,
): string {
  return `${idea.status}|${idea.platform}|${idea.visibility}`;
}

export function metaFor(idea: IdeaRow): IdeaVectorMeta {
  return {
    user_id: idea.user_id,
    type: 'idea',
    status: idea.status,
    platform: idea.platform,
    visibility: idea.visibility,
    updated_at: idea.updated_at,
  };
}

/**
 * Metadata của hook và biến thể.
 *
 * `category_id` và `idea_id` ở đây là để đọc khi soi index, KHÔNG phải để lọc: lọc
 * theo chúng đòi thêm metadata index trên Vectorize, mà metadata index phải tạo trước
 * lần upsert đầu tiên. Ngày nào cần lọc thật thì tạo index cho property đó rồi mới
 * upsert lại toàn bộ — thêm điều kiện vào filter mà quên bước đó chỉ cho ra kết quả
 * rỗng, không có lỗi nào.
 */
export function metaForHook(hook: HookRow): BaseMeta & { category_id: string } {
  return {
    user_id: hook.user_id,
    type: 'hook',
    category_id: hook.category_id ?? '',
    updated_at: hook.updated_at,
  };
}

export function metaForVariant(v: VariantRow): BaseMeta & { idea_id: string } {
  return {
    user_id: v.user_id,
    type: 'variant',
    idea_id: v.idea_id,
    updated_at: v.updated_at,
  };
}

function assertDimensions(items: Array<{ values: number[] }>): void {
  for (const { values } of items) {
    if (values.length !== DIMENSIONS) {
      throw new Error(`Vector có ${values.length} chiều, index cần ${DIMENSIONS}`);
    }
  }
}

export async function upsertIdeas(
  env: Env,
  items: Array<{ idea: IdeaRow; values: number[] }>,
): Promise<void> {
  if (items.length === 0) return;
  assertDimensions(items);
  await env.VEC.upsert(
    items.map(({ idea, values }) => ({
      id: vectorId('idea', idea.id),
      values,
      metadata: metaFor(idea),
    })),
  );
}

export async function upsertHooks(
  env: Env,
  items: Array<{ hook: HookRow; values: number[] }>,
): Promise<void> {
  if (items.length === 0) return;
  assertDimensions(items);
  await env.VEC.upsert(
    items.map(({ hook, values }) => ({
      id: vectorId('hook', hook.id),
      values,
      metadata: metaForHook(hook),
    })),
  );
}

export async function upsertVariants(
  env: Env,
  items: Array<{ variant: VariantRow; values: number[] }>,
): Promise<void> {
  if (items.length === 0) return;
  assertDimensions(items);
  await env.VEC.upsert(
    items.map(({ variant, values }) => ({
      id: vectorId('variant', variant.id),
      values,
      metadata: metaForVariant(variant),
    })),
  );
}

/** Xoá theo id ĐÃ có tiền tố — dùng vectorId() để dựng, đừng truyền id thô của bảng. */
export async function deleteVectors(env: Env, vectorIds: string[]): Promise<void> {
  if (vectorIds.length === 0) return;
  await env.VEC.deleteByIds(vectorIds);
}

/** Xoá vector thất bại → xếp hàng để lần bảo trì kế tiếp rút dần. */
export async function queueGc(env: Env, vectorIds: string[], userId: string): Promise<void> {
  if (vectorIds.length === 0) return;
  const t = now();
  await env.DB.batch(
    vectorIds.map((id) =>
      env.DB.prepare(
        `INSERT INTO vector_gc (vector_id, user_id, queued_at, attempts) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(vector_id) DO NOTHING`,
      ).bind(id, userId, t),
    ),
  );
}

export interface QueryOpts {
  userId: string;
  topK: number;
  status?: string[];
  platform?: string;
  /** Bỏ đúng một id ra khỏi kết quả — dùng cho "ý tưởng tương tự" và cho kiểm tra trùng. */
  excludeId?: string;
}

export interface Match {
  id: string;
  score: number;
}

/**
 * topK tối đa là 100, nhưng tụt xuống 50 khi bật returnValues hoặc
 * returnMetadata:'all'. Ở đây không cần cả hai — nội dung thật lấy từ D1 — nên
 * cứ để 'none' và giữ khoảng cách an toàn với trần.
 *
 * `type = 'idea'` là điều kiện BẮT BUỘC, không phải tối ưu hoá. Thiếu nó thì vector
 * hook và biến thể chiếm suất trong topK rồi bị tầng hydrate (getManyByIds trên bảng
 * ideas) lặng lẽ loại đi — người dùng thấy kết quả tìm kiếm ít đi mà không có dấu
 * hiệu nào cho biết vì sao.
 */
export async function queryIdeas(
  env: Env,
  vector: number[],
  opts: QueryOpts,
): Promise<Match[]> {
  const filter: Record<string, unknown> = {
    user_id: { $eq: opts.userId },
    type: { $eq: 'idea' },
  };
  if (opts.status && opts.status.length > 0) {
    filter['status'] = opts.status.length === 1 ? { $eq: opts.status[0] } : { $in: opts.status };
  }
  if (opts.platform) filter['platform'] = { $eq: opts.platform };

  return runQuery(env, vector, filter, opts.topK, opts.excludeId);
}

/** Truy vấn trong kho hook hoặc kho biến thể. Trả về id của BẢNG, đã bỏ tiền tố. */
export async function queryByType(
  env: Env,
  vector: number[],
  type: Exclude<VectorType, 'idea'>,
  opts: { userId: string; topK: number; excludeId?: string },
): Promise<Match[]> {
  const filter: Record<string, unknown> = {
    user_id: { $eq: opts.userId },
    type: { $eq: type },
  };
  return runQuery(env, vector, filter, opts.topK, opts.excludeId);
}

async function runQuery(
  env: Env,
  vector: number[],
  filter: Record<string, unknown>,
  topK: number,
  excludeId?: string,
): Promise<Match[]> {
  // Xin dư một suất khi có id cần loại, nếu không thì bỏ chính nó ra xong còn topK-1
  // kết quả — người dùng xin 10 mà nhận 9 mà không hiểu vì sao.
  const want = Math.min(excludeId ? topK + 1 : topK, 100);
  const res = await env.VEC.query(vector, {
    topK: want,
    returnMetadata: 'none',
    returnValues: false,
    filter: filter as VectorizeVectorMetadataFilter,
  });
  return res.matches
    .map((m) => ({ id: entityId(m.id), score: m.score }))
    .filter((m) => m.id !== excludeId)
    .slice(0, topK);
}

/** Lấy lại vector đã lưu — dùng cho "ý tưởng tương tự" và cho vector sở thích,
 *  rẻ hơn nhiều so với embed lại. */
export async function getVectors(env: Env, vectorIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (vectorIds.length === 0) return out;
  const rows = await env.VEC.getByIds(vectorIds);
  for (const r of rows) {
    if (Array.isArray(r.values) && r.values.length === DIMENSIONS) {
      out.set(entityId(r.id), r.values as number[]);
    }
  }
  return out;
}
