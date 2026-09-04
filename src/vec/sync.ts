import type { Env, IdeaRow } from '../types';
import type { HookRow } from '../db/hooks';
import type { VariantRow } from '../db/variants';
import * as ideasDb from '../db/ideas';
import * as hooksDb from '../db/hooks';
import * as variantsDb from '../db/variants';
import { tagsForIdeas } from '../db/tags';
import { embed, embedOne, MODEL_ID } from './embeddings';
import { hookEmbedText, ideaEmbedText, variantEmbedText } from '../content';
import {
  getVectors,
  queryIdeas,
  upsertHooks,
  upsertIdeas,
  upsertVariants,
  vectorId,
} from './index';

/**
 * Giữ D1 và Vectorize đồng bộ.
 *
 * BẤT BIẾN: D1 là nguồn sự thật, vector là sản phẩm dẫn xuất.
 *
 * Tạo và sửa KHÔNG đụng tới Vectorize — chúng chỉ ghi D1, và hàng trở thành "bẩn".
 * Toàn bộ việc index dồn về đây. Giao diện chỉ đi qua nút Index của riêng từng mục
 * (indexOne); đối soát hàng loạt (reconcileAll) chỉ còn là đường bảo trì cho admin.
 *
 * Hai cột quyết định một hàng có bẩn hay không — cùng một cặp cột ở cả ba bảng:
 *   embedded_hash     — nội dung đã nhúng lần gần nhất
 *   indexed_meta_hash — chữ ký metadata đã gửi lần gần nhất
 * Không cần hàng đợi: hai cột đó LÀ hàng đợi, và đếm được bằng một câu SQL.
 */

/** Kích thước lô: cân giữa số subrequest và độ lớn mỗi lời gọi. */
const EMBED_BATCH = 20;
const UPSERT_BATCH = 100;

/**
 * Ngưỡng coi hai ý tưởng là trùng nhau, trên cosine của bge-m3.
 *
 * Chỉnh được: hạ xuống thì cảnh báo nhiều hơn và có nhiễu, nâng lên thì chỉ bắt được
 * những bản gần như chép lại. 0.90 bắt "cùng một ý tưởng viết lại bằng chữ khác" mà
 * chưa réo lên với hai ý tưởng chỉ cùng chủ đề.
 */
export const DUP_THRESHOLD = 0.9;

/** Xin vài ứng viên rồi mới lọc theo ngưỡng — trả về hết thì danh sách cảnh báo dài vô ích. */
const DUP_TOPK = 5;

export interface DuplicateMatch {
  id: string;
  title: string;
  score: number;
}

export interface ReconcileResult {
  processed: number;
  failed: number;
  remaining: number;
}

export interface ReconcileAllResult extends ReconcileResult {
  by_type: { ideas: ReconcileResult; variants: ReconcileResult; hooks: ReconcileResult };
}

export interface IndexOneResult {
  /** Đã lên tới Vectorize chưa. false nghĩa là hỏng và hàng vẫn bẩn. */
  indexed: boolean;
  /** Chỉ có với ý tưởng, và chỉ khi vượt ngưỡng. Cảnh báo, không chặn. */
  duplicates: DuplicateMatch[];
}

// --- Đồng bộ riêng metadata --------------------------------------------------

/**
 * Cập nhật metadata của vector mà KHÔNG embed lại.
 *
 * Cần thiết vì có những trường nằm trong metadata của vector nhưng KHÔNG nằm trong văn
 * bản đem đi nhúng — `status` của ý tưởng, `category_id` của hook — nên đổi chúng không
 * làm content_hash đổi. Nếu chỉ dựa vào hash để quyết định có upsert hay không thì
 * metadata trên Vectorize mốc lại ở giá trị cũ. Hậu quả im lặng: `/api/search?status=…`
 * lọc sai, và gợi ý vẫn kéo về những ý tưởng đã publish.
 *
 * Dùng lại vector đã lưu qua getByIds thay vì gọi lại Workers AI — rẻ hơn hẳn.
 * Trả về false nếu chưa có vector; khi đó phía gọi sẽ đi đường nhúng đầy đủ.
 */
export async function refreshVectorMetadata(env: Env, idea: IdeaRow): Promise<boolean> {
  return refreshMeta(env, 'idea', idea.id, (values) => upsertIdeas(env, [{ idea, values }]))
    .then(async (ok) => {
      if (ok) await ideasDb.markMetaSynced(env, idea.id);
      return ok;
    });
}

async function refreshMeta(
  env: Env,
  type: 'idea' | 'variant' | 'hook',
  id: string,
  upsert: (values: number[]) => Promise<void>,
): Promise<boolean> {
  try {
    const values = (await getVectors(env, [vectorId(type, id)])).get(id);
    if (!values) return false;
    await upsert(values);
    return true;
  } catch (err) {
    console.error('refreshMeta failed', type, id, err);
    return false;
  }
}

// --- Vòng nhúng + upsert dùng chung cho cả ba loại ---------------------------

interface EmbedPlan<Row> {
  text: (row: Row) => string;
  id: (row: Row) => string;
  hash: (row: Row) => string;
  upsert: (items: Array<{ row: Row; values: number[] }>) => Promise<void>;
  markEmbedded: (id: string, hash: string) => Promise<void>;
  markFailed: (id: string) => Promise<void>;
}

/**
 * Nhúng theo lô rồi upsert theo lô. Một lô embed hỏng chỉ giết đúng lô đó — phần còn
 * lại vẫn đi tiếp, và mọi hàng hỏng đều được đánh dấu để lần sau thử lại.
 */
async function embedAndUpsert<Row>(
  env: Env,
  rows: Row[],
  plan: EmbedPlan<Row>,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const chunk = rows.slice(i, i + EMBED_BATCH);
    let vectors: number[][];
    try {
      vectors = await embed(env, chunk.map(plan.text));
    } catch (err) {
      console.error('embed batch failed', err);
      failed += chunk.length;
      await Promise.all(chunk.map((r) => plan.markFailed(plan.id(r)).catch(() => {})));
      continue;
    }

    const pairs = chunk
      .map((row, j) => ({ row, values: vectors[j] }))
      .filter((p): p is { row: Row; values: number[] } => Array.isArray(p.values));

    for (let k = 0; k < pairs.length; k += UPSERT_BATCH) {
      const slice = pairs.slice(k, k + UPSERT_BATCH);
      try {
        await plan.upsert(slice);
        await Promise.all(slice.map(({ row }) => plan.markEmbedded(plan.id(row), plan.hash(row))));
        processed += slice.length;
      } catch (err) {
        console.error('upsert batch failed', err);
        failed += slice.length;
        await Promise.all(slice.map(({ row }) => plan.markFailed(plan.id(row)).catch(() => {})));
      }
    }
  }
  return { processed, failed };
}

// --- Đối soát hàng loạt ------------------------------------------------------

/**
 * Đối soát các hàng bẩn theo lô. Idempotent và tiếp tục được: gọi lặp lại cho tới
 * khi `remaining === 0`. Đây cũng là công cụ chuyển đổi model — đổi MODEL_ID thì
 * mọi content_hash đổi theo và mọi hàng thành bẩn.
 */
export async function reconcile(
  env: Env,
  limit: number,
  userId?: string,
): Promise<ReconcileResult> {
  const rows = await ideasDb.listDirty(env, limit, userId);
  if (rows.length === 0) {
    return { processed: 0, failed: 0, remaining: await ideasDb.countDirty(env, userId) };
  }

  // Hai loại hàng bẩn, và tách chúng ra là điều đáng làm: loại chỉ đổi metadata
  // (ví dụ đổi trạng thái từ "ý tưởng" sang "đã đăng") dùng lại được vector đã lưu,
  // nên KHÔNG tốn một lời gọi Workers AI nào. Với người dùng hay đổi trạng thái thì
  // đây là phần lớn công việc đồng bộ.
  const needEmbed = rows.filter(ideasDb.needsEmbedding);
  const metaOnly = rows.filter((r) => !ideasDb.needsEmbedding(r));

  let processed = 0;
  let failed = 0;

  for (const idea of metaOnly) {
    if (await refreshVectorMetadata(env, idea)) {
      processed++;
    } else {
      // Không lấy được vector cũ (chưa từng index, hoặc Vectorize lỗi) → xử lý như
      // hàng cần nhúng lại, để lần sau đi đường đầy đủ.
      needEmbed.push(idea);
    }
  }

  if (needEmbed.length > 0) {
    const ids = needEmbed.map((r) => r.id);
    // Hai truy vấn gom cho cả lô, không phải mỗi hàng một truy vấn.
    const [tagMap, variantMap] = await Promise.all([
      tagsForIdeas(env, ids),
      variantsDb.listForIdeas(env, ids),
    ]);
    const res = await embedAndUpsert(env, needEmbed, {
      text: (r) => ideaEmbedText(r, tagMap.get(r.id) ?? [], variantMap.get(r.id) ?? []),
      id: (r) => r.id,
      hash: (r) => r.content_hash,
      upsert: (items) => upsertIdeas(env, items.map(({ row, values }) => ({ idea: row, values }))),
      markEmbedded: (id, hash) => ideasDb.markEmbedded(env, id, hash, MODEL_ID),
      markFailed: (id) => ideasDb.markEmbedFailed(env, id),
    });
    processed += res.processed;
    failed += res.failed;
  }

  return { processed, failed, remaining: await ideasDb.countDirty(env, userId) };
}

/**
 * Hook và biến thể: văn bản nhúng của chúng là hàm THUẦN của chính hàng đó (xem
 * src/content.ts), nên không có bước gom tag hay gom bảng con nào cả.
 */
export async function reconcileHooks(
  env: Env,
  limit: number,
  userId?: string,
): Promise<ReconcileResult> {
  const rows = await hooksDb.listDirty(env, limit, userId);
  if (rows.length === 0) {
    return { processed: 0, failed: 0, remaining: await hooksDb.countDirty(env, userId) };
  }

  const needEmbed = rows.filter(hooksDb.hookNeedsEmbedding);
  const metaOnly = rows.filter((r) => !hooksDb.hookNeedsEmbedding(r));

  let processed = 0;
  let failed = 0;
  for (const hook of metaOnly) {
    const ok = await refreshMeta(env, 'hook', hook.id, (values) =>
      upsertHooks(env, [{ hook, values }]),
    );
    if (ok) {
      await hooksDb.markMetaSynced(env, hook.id);
      processed++;
    } else {
      needEmbed.push(hook);
    }
  }

  const res = await embedAndUpsert<HookRow>(env, needEmbed, {
    text: hookEmbedText,
    id: (r) => r.id,
    hash: (r) => r.content_hash,
    upsert: (items) => upsertHooks(env, items.map(({ row, values }) => ({ hook: row, values }))),
    markEmbedded: (id, hash) => hooksDb.markEmbedded(env, id, hash, MODEL_ID),
    markFailed: (id) => hooksDb.markEmbedFailed(env, id),
  });

  return {
    processed: processed + res.processed,
    failed: failed + res.failed,
    remaining: await hooksDb.countDirty(env, userId),
  };
}

export async function reconcileVariants(
  env: Env,
  limit: number,
  userId?: string,
): Promise<ReconcileResult> {
  const rows = await variantsDb.listDirty(env, limit, userId);
  if (rows.length === 0) {
    return { processed: 0, failed: 0, remaining: await variantsDb.countDirty(env, userId) };
  }

  const needEmbed = rows.filter(variantsDb.variantNeedsEmbedding);
  const metaOnly = rows.filter((r) => !variantsDb.variantNeedsEmbedding(r));

  let processed = 0;
  for (const variant of metaOnly) {
    const ok = await refreshMeta(env, 'variant', variant.id, (values) =>
      upsertVariants(env, [{ variant, values }]),
    );
    if (ok) {
      await variantsDb.markMetaSynced(env, variant.id);
      processed++;
    } else {
      needEmbed.push(variant);
    }
  }

  const res = await embedAndUpsert<VariantRow>(env, needEmbed, {
    text: variantEmbedText,
    id: (r) => r.id,
    hash: (r) => r.content_hash,
    upsert: (items) =>
      upsertVariants(env, items.map(({ row, values }) => ({ variant: row, values }))),
    markEmbedded: (id, hash) => variantsDb.markEmbedded(env, id, hash, MODEL_ID),
    markFailed: (id) => variantsDb.markEmbedFailed(env, id),
  });

  return {
    processed: processed + res.processed,
    failed: res.failed,
    remaining: await variantsDb.countDirty(env, userId),
  };
}

/** Đối soát admin chạy cả ba loại. `limit` áp cho TỪNG loại, không phải tổng. */
export async function reconcileAll(
  env: Env,
  limit: number,
  userId?: string,
): Promise<ReconcileAllResult> {
  // Tuần tự chứ không Promise.all: cả ba đều gọi Workers AI, và chạy song song chỉ
  // dồn ba lô vào cùng một khoảnh khắc để cùng đụng giới hạn tốc độ.
  const ideas = await reconcile(env, limit, userId);
  const variants = await reconcileVariants(env, limit, userId);
  const hooks = await reconcileHooks(env, limit, userId);
  return {
    processed: ideas.processed + variants.processed + hooks.processed,
    failed: ideas.failed + variants.failed + hooks.failed,
    remaining: ideas.remaining + variants.remaining + hooks.remaining,
    by_type: { ideas, variants, hooks },
  };
}

// --- Index đúng MỘT mục ------------------------------------------------------

/**
 * Index đúng một hàng mà người dùng vừa bấm nút cho nó.
 *
 * CỐ Ý KHÔNG dùng lại reconcile(limit=1): worklist của reconcile sắp theo `updated_at`,
 * nên nó sẽ index một hàng bẩn NÀO ĐÓ chứ không phải hàng vừa được bấm — và người dùng
 * thấy nút mình bấm chạy xong mà mục đó vẫn "chưa index".
 *
 * Trả về null khi hàng không tồn tại hoặc thuộc người khác; phía route dịch thành 404.
 */
export async function indexOne(
  env: Env,
  userId: string,
  kind: 'idea',
  id: string,
): Promise<IndexOneResult | null>;
export async function indexOne(
  env: Env,
  userId: string,
  kind: 'variant' | 'hook',
  id: string,
): Promise<IndexOneResult | null>;
export async function indexOne(
  env: Env,
  userId: string,
  kind: 'idea' | 'variant' | 'hook',
  id: string,
): Promise<IndexOneResult | null> {
  if (kind === 'idea') return indexOneIdea(env, userId, id);
  if (kind === 'hook') return indexOneHook(env, userId, id);
  return indexOneVariant(env, userId, id);
}

async function indexOneIdea(
  env: Env,
  userId: string,
  id: string,
): Promise<IndexOneResult | null> {
  const idea = await ideasDb.getById(env, userId, id);
  if (!idea) return null;

  // Chỉ metadata lệch → dùng lại vector đã lưu, không tốn lời gọi AI nào. Không có
  // vector cũ thì rơi xuống đường nhúng đầy đủ bên dưới.
  if (!ideasDb.needsEmbedding(idea) && (await refreshVectorMetadata(env, idea))) {
    return { indexed: true, duplicates: [] };
  }

  const [tagMap, variants] = await Promise.all([
    tagsForIdeas(env, [idea.id]),
    variantsDb.listForIdea(env, userId, idea.id),
  ]);
  const text = ideaEmbedText(idea, tagMap.get(idea.id) ?? [], variants);

  let values: number[];
  try {
    values = await embedOne(env, text);
  } catch (err) {
    console.error('indexOne embed failed', id, err);
    await ideasDb.markEmbedFailed(env, id).catch(() => {});
    return { indexed: false, duplicates: [] };
  }

  // Kiểm tra trùng TRƯỚC khi upsert, bằng chính vector vừa nhúng. Làm sau thì luôn ra
  // rỗng: Vectorize mất khoảng một phút mới truy vấn được vector vừa ghi, nên ý tưởng
  // sẽ không bao giờ tự thấy mình, mà cũng chưa kịp so với ai.
  const duplicates = await findDuplicates(env, userId, id, values);

  try {
    await upsertIdeas(env, [{ idea, values }]);
    await ideasDb.markEmbedded(env, id, idea.content_hash, MODEL_ID);
  } catch (err) {
    console.error('indexOne upsert failed', id, err);
    await ideasDb.markEmbedFailed(env, id).catch(() => {});
    return { indexed: false, duplicates };
  }
  return { indexed: true, duplicates };
}

async function indexOneHook(
  env: Env,
  userId: string,
  id: string,
): Promise<IndexOneResult | null> {
  const hook = await hooksDb.getHook(env, userId, id);
  if (!hook) return null;

  if (!hooksDb.hookNeedsEmbedding(hook)) {
    const ok = await refreshMeta(env, 'hook', id, (values) => upsertHooks(env, [{ hook, values }]));
    if (ok) {
      await hooksDb.markMetaSynced(env, id);
      return { indexed: true, duplicates: [] };
    }
  }

  try {
    const values = await embedOne(env, hookEmbedText(hook));
    await upsertHooks(env, [{ hook, values }]);
    await hooksDb.markEmbedded(env, id, hook.content_hash, MODEL_ID);
  } catch (err) {
    console.error('indexOne hook failed', id, err);
    await hooksDb.markEmbedFailed(env, id).catch(() => {});
    return { indexed: false, duplicates: [] };
  }
  return { indexed: true, duplicates: [] };
}

async function indexOneVariant(
  env: Env,
  userId: string,
  id: string,
): Promise<IndexOneResult | null> {
  const variant = await variantsDb.getById(env, userId, id);
  if (!variant) return null;

  if (!variantsDb.variantNeedsEmbedding(variant)) {
    const ok = await refreshMeta(env, 'variant', id, (values) =>
      upsertVariants(env, [{ variant, values }]),
    );
    if (ok) {
      await variantsDb.markMetaSynced(env, id);
      return { indexed: true, duplicates: [] };
    }
  }

  try {
    const values = await embedOne(env, variantEmbedText(variant));
    await upsertVariants(env, [{ variant, values }]);
    await variantsDb.markEmbedded(env, id, variant.content_hash, MODEL_ID);
  } catch (err) {
    console.error('indexOne variant failed', id, err);
    await variantsDb.markEmbedFailed(env, id).catch(() => {});
    return { indexed: false, duplicates: [] };
  }
  return { indexed: true, duplicates: [] };
}

/**
 * Ý tưởng nào của CHÍNH người dùng này gần trùng với vector vừa nhúng.
 *
 * Cảnh báo chứ không chặn: hàng đã nằm trong D1 rồi, chặn ở bước index không cứu được
 * gì mà chỉ để lại một ý tưởng vĩnh viễn không tìm được. Việc bỏ hay giữ là của người
 * dùng, nên đưa họ danh sách kèm liên kết.
 *
 * Lỗi ở đây KHÔNG được làm hỏng việc index: kiểm tra trùng là tiện ích, còn đưa được
 * vector lên Vectorize mới là việc người dùng vừa bấm nút để làm.
 */
async function findDuplicates(
  env: Env,
  userId: string,
  selfId: string,
  values: number[],
): Promise<DuplicateMatch[]> {
  try {
    const matches = await queryIdeas(env, values, {
      userId,
      topK: DUP_TOPK,
      excludeId: selfId,
    });
    const near = matches.filter((m) => m.score >= DUP_THRESHOLD);
    if (near.length === 0) return [];

    // Lấy tiêu đề từ D1 — vẫn ràng buộc user_id, nên một id lạ lọt qua filter của
    // Vectorize cũng không thể lộ tiêu đề của người khác.
    const rows = await ideasDb.getManyByIds(env, userId, near.map((m) => m.id));
    return near
      .map((m) => {
        const row = rows.get(m.id);
        return row ? { id: m.id, title: row.title, score: m.score } : null;
      })
      .filter((x): x is DuplicateMatch => x !== null);
  } catch (err) {
    console.error('findDuplicates failed', selfId, err);
    return [];
  }
}

/** Rút hàng đợi vector mồ côi. */
export async function drainVectorGc(env: Env, limit = 100): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT vector_id FROM vector_gc ORDER BY queued_at LIMIT ?1`,
  )
    .bind(limit)
    .all<{ vector_id: string }>();
  if (results.length === 0) return 0;

  const ids = results.map((r) => r.vector_id);
  try {
    await env.VEC.deleteByIds(ids);
  } catch (err) {
    console.error('drainVectorGc failed', err);
    const ph = ids.map((_, i) => `?${i + 1}`).join(', ');
    await env.DB.prepare(
      `UPDATE vector_gc SET attempts = attempts + 1 WHERE vector_id IN (${ph})`,
    )
      .bind(...ids)
      .run();
    return 0;
  }
  const ph = ids.map((_, i) => `?${i + 1}`).join(', ');
  await env.DB.prepare(`DELETE FROM vector_gc WHERE vector_id IN (${ph})`).bind(...ids).run();
  return ids.length;
}
