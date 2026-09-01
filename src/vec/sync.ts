import type { Env, IdeaRow } from '../types';
import * as ideasDb from '../db/ideas';
import { tagsForIdeas } from '../db/tags';
import { buildEmbedText, embed, MODEL_ID } from './embeddings';
import { upsertIdeas } from './index';

/**
 * Giữ D1 và Vectorize đồng bộ.
 *
 * BẤT BIẾN: D1 là nguồn sự thật, vector là sản phẩm dẫn xuất.
 * `embedded_hash === content_hash` nghĩa là đã đồng bộ; khác đi nghĩa là "bẩn".
 * Không cần hàng đợi: chính cột đó LÀ hàng đợi thử lại, và đếm được bằng một câu SQL.
 */

/**
 * Index một ý tưởng ngay trong request. Cố ý đồng bộ chứ không đẩy sang waitUntil:
 * người dùng vừa lưu thì mong tìm thấy ngay, còn lỗi trong waitUntil thì vô hình và
 * không có ai thử lại. Chi phí là ~200–500ms chờ I/O (không phải CPU nên không đụng
 * hạn mức CPU), và giao diện hiển thị trạng thái đang lưu.
 *
 * Trả về true nếu index thành công. KHÔNG bao giờ ném lỗi ra ngoài: một trục trặc
 * của Workers AI không được phép làm mất bài viết của người dùng.
 */
export async function indexIdea(env: Env, idea: IdeaRow, tags: string[]): Promise<boolean> {
  try {
    const text = buildEmbedText(idea, tags);
    const [values] = await embed(env, [text]);
    if (!values) throw new Error('không nhận được vector');
    await upsertIdeas(env, [{ idea, values }]);
    await ideasDb.markEmbedded(env, idea.id, idea.content_hash, MODEL_ID);
    return true;
  } catch (err) {
    console.error('indexIdea failed', idea.id, err);
    await ideasDb.markEmbedFailed(env, idea.id).catch(() => {});
    return false;
  }
}

/** Kích thước lô: cân giữa số subrequest và độ lớn mỗi lời gọi. */
const EMBED_BATCH = 20;
const UPSERT_BATCH = 100;

export interface ReconcileResult {
  processed: number;
  failed: number;
  remaining: number;
}

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
    return { processed: 0, failed: 0, remaining: 0 };
  }

  const tagMap = await tagsForIdeas(env, rows.map((r) => r.id));
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const chunk = rows.slice(i, i + EMBED_BATCH);
    const texts = chunk.map((r) => buildEmbedText(r, tagMap.get(r.id) ?? []));
    let vectors: number[][];
    try {
      vectors = await embed(env, texts);
    } catch (err) {
      console.error('reconcile embed batch failed', err);
      failed += chunk.length;
      await Promise.all(chunk.map((r) => ideasDb.markEmbedFailed(env, r.id).catch(() => {})));
      continue;
    }

    const pairs = chunk
      .map((idea, j) => ({ idea, values: vectors[j] }))
      .filter((p): p is { idea: IdeaRow; values: number[] } => Array.isArray(p.values));

    for (let k = 0; k < pairs.length; k += UPSERT_BATCH) {
      const slice = pairs.slice(k, k + UPSERT_BATCH);
      try {
        await upsertIdeas(env, slice);
        await env.DB.batch(
          slice.map(({ idea }) =>
            env.DB.prepare(
              `UPDATE ideas SET embedded_hash = ?2, embedding_model = ?3, embedded_at = ?4,
                                embed_attempts = 0
                WHERE id = ?1 AND content_hash = ?2`,
            ).bind(idea.id, idea.content_hash, MODEL_ID, Date.now()),
          ),
        );
        processed += slice.length;
      } catch (err) {
        console.error('reconcile upsert batch failed', err);
        failed += slice.length;
        await Promise.all(
          slice.map(({ idea }) => ideasDb.markEmbedFailed(env, idea.id).catch(() => {})),
        );
      }
    }
  }

  const remaining = await ideasDb.countDirty(env, userId);
  return { processed, failed, remaining };
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
