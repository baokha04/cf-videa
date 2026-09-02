import type { Env, IdeaRow } from '../types';
import * as ideasDb from '../db/ideas';
import { tagsForIdeas } from '../db/tags';
import { hooksForIdeas } from '../db/hooks';
import { buildEmbedText, embed, embedOne, MODEL_ID } from './embeddings';
import { getVectors, metaSignature, upsertIdeas } from './index';

/**
 * Giữ D1 và Vectorize đồng bộ.
 *
 * BẤT BIẾN: D1 là nguồn sự thật, vector là sản phẩm dẫn xuất.
 *
 * Tạo và sửa ý tưởng KHÔNG đụng tới Vectorize — chúng chỉ ghi D1, và hàng trở thành
 * "bẩn". Toàn bộ việc index dồn về đây, chạy khi người dùng bấm nút đồng bộ.
 *
 * Hai cột quyết định một hàng có bẩn hay không, xem src/db/ideas.ts:
 *   embedded_hash     — nội dung đã nhúng lần gần nhất
 *   indexed_meta_hash — chữ ký metadata đã gửi lần gần nhất
 * Không cần hàng đợi: hai cột đó LÀ hàng đợi, và đếm được bằng một câu SQL.
 */

/**
 * Cập nhật metadata của vector mà KHÔNG embed lại.
 *
 * Cần thiết vì `status` nằm trong metadata của vector nhưng KHÔNG nằm trong văn bản
 * đem đi nhúng — nên đổi mỗi trạng thái không làm content_hash đổi, và nếu chỉ dựa
 * vào hash để quyết định có upsert hay không thì metadata trên Vectorize sẽ mốc lại
 * ở giá trị cũ. Hậu quả im lặng: `/api/search?status=…` lọc sai, và gợi ý vẫn kéo về
 * những ý tưởng đã publish.
 *
 * Dùng lại vector đã lưu qua getByIds thay vì gọi lại Workers AI — rẻ hơn hẳn.
 * Trả về false nếu chưa có vector; khi đó reconcile() sẽ đi đường nhúng đầy đủ.
 */
export async function refreshVectorMetadata(env: Env, idea: IdeaRow): Promise<boolean> {
  try {
    const values = (await getVectors(env, [idea.id])).get(idea.id);
    if (!values) return false;
    await upsertIdeas(env, [{ idea, values }]);
    await ideasDb.markMetaSynced(env, idea.id);
    return true;
  } catch (err) {
    console.error('refreshVectorMetadata failed', idea.id, err);
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
    const [tagMap, hookMap] = await Promise.all([
      tagsForIdeas(env, ids),
      hooksForIdeas(env, ids),
    ]);

    for (let i = 0; i < needEmbed.length; i += EMBED_BATCH) {
      const chunk = needEmbed.slice(i, i + EMBED_BATCH);
      const texts = chunk.map((r) =>
        buildEmbedText(r, tagMap.get(r.id) ?? [], hookMap.get(r.id) ?? []),
      );
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
          await Promise.all(
            slice.map(({ idea }) => ideasDb.markEmbedded(env, idea.id, idea.content_hash, MODEL_ID)),
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
  }

  const remaining = await ideasDb.countDirty(env, userId);
  return { processed, failed, remaining };
}

/**
 * Kết quả của nút "đồng bộ index" gắn trên TỪNG ý tưởng.
 *
 *  clean      — đã khớp sẵn, không phải làm gì (và không gọi AI)
 *  meta       — chỉ ghi đè metadata, dùng lại vector đã lưu, không gọi AI
 *  embedded   — nhúng lại rồi upsert
 *  failed     — Workers AI hoặc Vectorize hỏng; hàng vẫn nguyên vẹn và vẫn bẩn
 */
export type SyncIdeaOutcome = 'clean' | 'meta' | 'embedded' | 'failed';

export interface SyncIdeaResult {
  outcome: SyncIdeaOutcome;
  indexed: boolean;
}

/**
 * Đồng bộ ĐÚNG MỘT ý tưởng.
 *
 * Vì sao không dùng lại reconcile() với limit = 1: reconcile lấy hàng bẩn theo thứ
 * tự updated_at, nên nó sẽ đồng bộ một ý tưởng NÀO ĐÓ chứ không phải ý tưởng người
 * dùng vừa bấm nút. Nút gắn trên một thẻ mà lại đi làm việc cho thẻ khác là thứ
 * không giải thích được.
 *
 * Quyền sở hữu ràng buộc ngay ở truy vấn đầu tiên: id của người khác trả về null,
 * và route biến null thành 404 — không xác nhận sự tồn tại của hàng thuộc user khác.
 *
 * `force` bỏ qua bước kiểm tra "đã sạch" và ghi lại vector. Dùng khi vector biến mất
 * khỏi Vectorize mà D1 vẫn tưởng là sạch — trạng thái mà không cột nào phát hiện
 * được, vì D1 chỉ ghi lại thứ nó đã GỬI ĐI, không phải thứ hiện có ở đầu kia.
 */
export async function syncIdea(
  env: Env,
  userId: string,
  ideaId: string,
  force = false,
): Promise<SyncIdeaResult | null> {
  const row = await ideasDb.getById(env, userId, ideaId);
  if (!row) return null;

  const dirty = ideasDb.needsEmbedding(row) || row.indexed_meta_hash !== metaSignature(row);
  if (!dirty && !force) return { outcome: 'clean', indexed: true };

  // Đường rẻ trước: nội dung không đổi thì dùng lại vector đã lưu, chỉ ghi đè
  // metadata. Không tốn một lời gọi Workers AI nào.
  if (!ideasDb.needsEmbedding(row) && (await refreshVectorMetadata(env, row))) {
    return { outcome: 'meta', indexed: true };
  }

  const [tagMap, hookMap] = await Promise.all([
    tagsForIdeas(env, [ideaId]),
    hooksForIdeas(env, [ideaId]),
  ]);
  try {
    const values = await embedOne(
      env,
      buildEmbedText(row, tagMap.get(ideaId) ?? [], hookMap.get(ideaId) ?? []),
    );
    await upsertIdeas(env, [{ idea: row, values }]);
    await ideasDb.markEmbedded(env, row.id, row.content_hash, MODEL_ID);
    return { outcome: 'embedded', indexed: true };
  } catch (err) {
    console.error('syncIdea failed', ideaId, err);
    await ideasDb.markEmbedFailed(env, ideaId).catch(() => {});
    return { outcome: 'failed', indexed: false };
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
