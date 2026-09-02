import type { Env, IdeaKind, IdeaRow, IdeaStatus, Platform } from '../types';
import { newId, now } from '../util/id';

/**
 * QUY TẮC KHÔNG NGOẠI LỆ: mọi hàm ở đây nhận userId làm tham số đầu tiên và mọi
 * câu lệnh đều có `WHERE user_id = ?`. Không route nào được viết SQL thô trên
 * bảng ideas. Kiểm tra quyền sở hữu là một vị từ trong câu lệnh, không phải một
 * lệnh `if` sau khi đã lấy dữ liệu về — và không khớp thì trả 404 chứ không phải
 * 403, để không xác nhận sự tồn tại của hàng thuộc user khác.
 */

/**
 * Điều kiện "hàng cần đồng bộ lại", dùng chung cho mọi truy vấn để chúng không thể
 * lệch nhau. Phải khớp CHÍNH XÁC mệnh đề WHERE của idx_ideas_dirty trong
 * migrations/0005 — lệch một ký tự là SQLite bỏ qua index và quét toàn bảng.
 * META_SIG_SQL cũng phải khớp từng ký tự với metaSignature() trong src/vec/index.ts.
 *
 * Hai loại bẩn, và loại thứ hai KHÔNG cần gọi AI:
 *  - nội dung đổi   → embedded_hash lệch content_hash → phải nhúng lại
 *  - metadata đổi   → indexed_meta_hash lệch chữ ký hiện tại → chỉ ghi đè metadata
 */
export const META_SIG_SQL = `status || '|' || platform || '|' || visibility || '|' || kind`;

export const DIRTY_SQL = `(
  embedded_hash IS NULL
  OR embedded_hash <> content_hash
  OR indexed_meta_hash IS NULL
  OR indexed_meta_hash <> ${META_SIG_SQL}
)`;

/**
 * Hàng cha hợp lệ của một biến thể, dưới dạng truy vấn con.
 *
 * Năm điều kiện, tất cả nằm TRONG câu lệnh chứ không phải trong một `if` ở tầng
 * route: cha phải tồn tại, phải thuộc đúng user đang thao tác, phải là ý tưởng gốc,
 * không được là chính hàng đang ghi, và hàng đang ghi không được đã có biến thể của
 * riêng nó — hai điều cuối giữ cây đúng MỘT tầng và không có chu trình. Trả NULL khi
 * bất kỳ điều kiện nào hỏng, và nơi gọi dùng NULL đó để ép `kind` về 'origin'.
 *
 * Đây là lưới an toàn cấu trúc, không phải nơi báo lỗi cho người dùng: route kiểm
 * trước và trả thông báo tử tế (src/routes/ideas.ts). Lưới này bắt phần còn lại —
 * hai request cùng lúc, hoặc hàng cha vừa bị xoá xong.
 *
 * ?1 = id hàng đang ghi, ?2 = user_id, ?12 = kind mong muốn, ?13 = parent_id mong muốn.
 */
const PARENT_SQL = `(SELECT p.id FROM ideas p
                      WHERE p.id = ?13 AND p.user_id = ?2 AND p.kind = 'origin'
                        AND p.id <> ?1 AND ?12 = 'variant'
                        AND NOT EXISTS (SELECT 1 FROM ideas c WHERE c.parent_id = ?1))`;

/** Hàng này cần nhúng lại (không chỉ cập nhật metadata)? */
export function needsEmbedding(row: IdeaRow): boolean {
  return row.embedded_hash === null || row.embedded_hash !== row.content_hash;
}

export interface IdeaInput {
  title: string;
  hook: string;
  script_outline: string;
  source_idea: string;
  prompt_recipe: string;
  negative_prompt: string;
  platform: Platform;
  niche: string;
  status: IdeaStatus;
  kind: IdeaKind;
  /** Bắt buộc NULL khi kind = 'origin'; khi 'variant' thì phải là id một ý tưởng gốc. */
  parent_id: string | null;
}

export async function getById(env: Env, userId: string, id: string): Promise<IdeaRow | null> {
  return env.DB.prepare(`SELECT * FROM ideas WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<IdeaRow>();
}

/** Nạp nhiều ý tưởng theo id, luôn lọc theo user — đây là lưới an toàn sau Vectorize. */
export async function getManyByIds(
  env: Env,
  userId: string,
  ids: string[],
): Promise<Map<string, IdeaRow>> {
  const map = new Map<string, IdeaRow>();
  if (ids.length === 0) return map;
  const ph = ids.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT * FROM ideas WHERE user_id = ?1 AND id IN (${ph})`,
  )
    .bind(userId, ...ids)
    .all<IdeaRow>();
  for (const r of results) map.set(r.id, r);
  return map;
}

export async function create(
  env: Env,
  userId: string,
  input: IdeaInput,
  contentHash: string,
): Promise<IdeaRow> {
  const t = now();
  const id = newId();
  // parent_id đi qua một truy vấn con chứ không bind thẳng: nó CHỈ nhận giá trị khi
  // hàng cha có thật, thuộc đúng user này và bản thân là ý tưởng gốc. Ràng buộc nằm
  // trong chính câu lệnh nên không thể bị quên ở tầng gọi.
  //
  // `kind` suy ra từ CHÍNH truy vấn con đó, không lấy thẳng từ input. Nhờ vậy cặp
  // (kind, parent_id) không bao giờ mâu thuẫn: không thể có biến thể mồ côi, kể cả
  // khi hàng cha vừa bị xoá ngay trước lệnh này.
  await env.DB.prepare(
    `INSERT INTO ideas (id, user_id, title, hook, script_outline, source_idea, prompt_recipe,
                        negative_prompt, platform, niche, status, kind, parent_id,
                        visibility, lang, content_hash, embed_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
             CASE WHEN ${PARENT_SQL} IS NULL THEN 'origin' ELSE 'variant' END,
             ${PARENT_SQL},
             'private', 'vi', ?14, 0, ?15, ?15)`,
  )
    .bind(
      id,
      userId,
      input.title,
      input.hook,
      input.script_outline,
      input.source_idea,
      input.prompt_recipe,
      input.negative_prompt,
      input.platform,
      input.niche,
      input.status,
      input.kind,
      input.parent_id,
      contentHash,
      t,
    )
    .run();
  // Đọc lại thay vì dựng đối tượng từ input: parent_id do SQL quyết định, và nếu
  // hàng cha không hợp lệ thì nó là NULL — dựng tay sẽ nói dối về trạng thái thật.
  const row = await getById(env, userId, id);
  if (!row) throw new Error('Ghi ý tưởng xong nhưng đọc lại không thấy');
  return row;
}

/** Trả về false nếu không có hàng nào khớp (không tồn tại, hoặc thuộc user khác). */
export async function update(
  env: Env,
  userId: string,
  id: string,
  input: IdeaInput,
  contentHash: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE ideas
        SET title = ?3, hook = ?4, script_outline = ?5, source_idea = ?6, prompt_recipe = ?7,
            negative_prompt = ?8, platform = ?9, niche = ?10, status = ?11,
            kind = CASE WHEN ${PARENT_SQL} IS NULL THEN 'origin' ELSE 'variant' END,
            parent_id = ${PARENT_SQL},
            content_hash = ?14, updated_at = ?15
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(
      id,
      userId,
      input.title,
      input.hook,
      input.script_outline,
      input.source_idea,
      input.prompt_recipe,
      input.negative_prompt,
      input.platform,
      input.niche,
      input.status,
      input.kind,
      input.parent_id,
      contentHash,
      now(),
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function remove(env: Env, userId: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM ideas WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Ghi nhận upsert thành công: cả nội dung lẫn metadata đều đã lên Vectorize.
 *
 * Điều kiện `content_hash = ?2` để không đánh dấu nhầm khi người dùng vừa sửa nội
 * dung trong lúc lệnh embed đang chạy — kết quả cũ về muộn thì bỏ qua.
 *
 * Chữ ký metadata lấy từ chính hàng trong DB (không truyền từ ngoài vào) để nó luôn
 * là trạng thái mới nhất, đúng thứ vừa được gửi lên trong metadata của vector.
 */
export async function markEmbedded(
  env: Env,
  id: string,
  contentHash: string,
  model: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ideas
        SET embedded_hash = ?2, embedding_model = ?3, embedded_at = ?4, embed_attempts = 0,
            indexed_meta_hash = ${META_SIG_SQL}
      WHERE id = ?1 AND content_hash = ?2`,
  )
    .bind(id, contentHash, model, now())
    .run();
}

/**
 * Ghi nhận đã đồng bộ RIÊNG metadata (dùng lại vector cũ, không gọi AI).
 * Không đụng embedded_hash: nội dung vẫn đúng như lần nhúng trước.
 */
export async function markMetaSynced(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE ideas
        SET indexed_meta_hash = ${META_SIG_SQL},
            embed_attempts = 0
      WHERE id = ?1`,
  )
    .bind(id)
    .run();
}

export async function markEmbedFailed(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE ideas SET embed_attempts = embed_attempts + 1 WHERE id = ?1`)
    .bind(id)
    .run();
}

export interface ListFilters {
  status?: IdeaStatus;
  platform?: Platform;
  niche?: string;
  tag?: string;
  /** 'origin' = chỉ ý tưởng gốc, 'variant' = chỉ ý tưởng biến thể. */
  kind?: IdeaKind;
  /** Danh mục biến thể của đúng một ý tưởng gốc. */
  parentId?: string;
  likedOnly?: boolean;
  /** Tìm từ khoá bằng LIKE — nhanh, luôn sẵn sàng, không phụ thuộc Vectorize. */
  q?: string;
}

export interface Cursor {
  updated_at: number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return `${c.updated_at}_${c.id}`;
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  const i = raw.indexOf('_');
  if (i < 0) return null;
  const updated_at = Number(raw.slice(0, i));
  const id = raw.slice(i + 1);
  if (!Number.isFinite(updated_at) || !id) return null;
  return { updated_at, id };
}

/**
 * Phân trang keyset trên (updated_at DESC, id DESC) chứ không dùng OFFSET:
 * kết quả vẫn đúng khi người dùng đang sửa dữ liệu, và không chậm đi ở trang sâu.
 */
export async function list(
  env: Env,
  userId: string,
  filters: ListFilters,
  limit: number,
  cursor: Cursor | null,
): Promise<{ rows: IdeaRow[]; nextCursor: string | null }> {
  const where: string[] = ['i.user_id = ?1'];
  const binds: unknown[] = [userId];
  // Đẩy giá trị vào mảng bind rồi trả về placeholder tương ứng NGAY tại chỗ.
  // Tách hai việc này ra (sinh placeholder trước, push sau) là cách chắc chắn sinh
  // ra hai placeholder trùng số trong cùng một mệnh đề.
  const bind = (v: unknown): string => {
    binds.push(v);
    return `?${binds.length}`;
  };

  if (filters.status) where.push(`i.status = ${bind(filters.status)}`);
  if (filters.platform) where.push(`i.platform = ${bind(filters.platform)}`);
  if (filters.niche) where.push(`i.niche = ${bind(filters.niche)}`);
  if (filters.kind) where.push(`i.kind = ${bind(filters.kind)}`);
  if (filters.parentId) where.push(`i.parent_id = ${bind(filters.parentId)}`);
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(
      `(i.title LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR i.hook LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR i.script_outline LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR i.source_idea LIKE ${bind(like)} ESCAPE '\\'` +
        // Công thức prompt và negative prompt cố ý KHÔNG đem đi nhúng (xem
        // src/vec/embeddings.ts), nên tìm từ khoá là đường DUY NHẤT tìm lại chúng.
        ` OR i.prompt_recipe LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR i.negative_prompt LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR i.niche LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR EXISTS (SELECT 1 FROM idea_hooks h
                      WHERE h.idea_id = i.id AND h.user_id = ?1
                        AND h.text LIKE ${bind(like)} ESCAPE '\\'))`,
    );
  }
  if (filters.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM idea_tags it JOIN tags t ON t.id = it.tag_id
                WHERE it.idea_id = i.id AND t.user_id = ?1 AND t.name = ${bind(filters.tag)})`,
    );
  }
  if (filters.likedOnly) {
    where.push(`EXISTS (SELECT 1 FROM idea_likes l WHERE l.idea_id = i.id AND l.user_id = ?1)`);
  }
  if (cursor) {
    where.push(
      `(i.updated_at < ${bind(cursor.updated_at)}` +
        ` OR (i.updated_at = ${bind(cursor.updated_at)} AND i.id < ${bind(cursor.id)}))`,
    );
  }

  // Lấy dư 1 hàng để biết còn trang sau hay không.
  const sql = `SELECT i.* FROM ideas i
                WHERE ${where.join(' AND ')}
                ORDER BY i.updated_at DESC, i.id DESC
                LIMIT ${limit + 1}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all<IdeaRow>();

  const hasMore = results.length > limit;
  const rows = hasMore ? results.slice(0, limit) : results;
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor:
      hasMore && last ? encodeCursor({ updated_at: last.updated_at, id: last.id }) : null,
  };
}

/** Worklist đối soát: hàng có vector thiếu hoặc đã cũ. */
export async function listDirty(
  env: Env,
  limit: number,
  userId?: string,
): Promise<IdeaRow[]> {
  const sql = userId
    ? `SELECT * FROM ideas WHERE ${DIRTY_SQL} AND user_id = ?2 ORDER BY updated_at LIMIT ?1`
    : `SELECT * FROM ideas WHERE ${DIRTY_SQL} ORDER BY updated_at LIMIT ?1`;
  const stmt = userId
    ? env.DB.prepare(sql).bind(limit, userId)
    : env.DB.prepare(sql).bind(limit);
  const { results } = await stmt.all<IdeaRow>();
  return results;
}

export async function countDirty(env: Env, userId?: string): Promise<number> {
  const sql = userId
    ? `SELECT COUNT(*) AS n FROM ideas WHERE ${DIRTY_SQL} AND user_id = ?1`
    : `SELECT COUNT(*) AS n FROM ideas WHERE ${DIRTY_SQL}`;
  const stmt = userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql);
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

/** Đánh dấu mọi hàng của một user là bẩn — dùng khi ép reindex toàn bộ. */
export async function markAllDirty(env: Env, userId?: string): Promise<number> {
  const sql = userId
    ? `UPDATE ideas SET embedded_hash = NULL, indexed_meta_hash = NULL WHERE user_id = ?1`
    : `UPDATE ideas SET embedded_hash = NULL, indexed_meta_hash = NULL`;
  const stmt = userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql);
  const res = await stmt.run();
  return res.meta.changes ?? 0;
}

/**
 * Danh mục ý tưởng biến thể của một ý tưởng gốc.
 *
 * Ràng buộc quyền sở hữu bằng CHÍNH câu lệnh chứ không tin vào việc người gọi đã
 * kiểm tra hàng cha: một biến thể chỉ trả về khi cả nó lẫn cha đều thuộc user này.
 */
export async function listVariants(
  env: Env,
  userId: string,
  parentId: string,
  limit = 100,
): Promise<IdeaRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.* FROM ideas c
       JOIN ideas p ON p.id = c.parent_id AND p.user_id = c.user_id
      WHERE c.parent_id = ?1 AND c.user_id = ?2
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?3`,
  )
    .bind(parentId, userId, limit)
    .all<IdeaRow>();
  return results;
}

/** Đếm biến thể cho một loạt ý tưởng gốc bằng đúng một truy vấn. */
export async function variantCounts(
  env: Env,
  userId: string,
  parentIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (parentIds.length === 0) return out;
  const ph = parentIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT parent_id, COUNT(*) AS n FROM ideas
      WHERE user_id = ?1 AND parent_id IN (${ph})
      GROUP BY parent_id`,
  )
    .bind(userId, ...parentIds)
    .all<{ parent_id: string; n: number }>();
  for (const r of results) out.set(r.parent_id, r.n);
  return out;
}

/**
 * Id các biến thể của một ý tưởng — phải lấy TRƯỚC khi xoá hàng cha.
 *
 * Xoá ý tưởng gốc sẽ cascade xoá cả biến thể trong D1, nhưng Vectorize không biết
 * gì về cascade: nếu không gom id con lại trước thì vector của chúng ở lại vĩnh viễn
 * và chiếm chỗ trong topK của mọi truy vấn về sau.
 */
export async function childIds(env: Env, userId: string, id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM ideas WHERE parent_id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Ý tưởng này đang có biến thể nào không? Dùng để từ chối biến nó thành biến thể. */
export async function hasVariants(env: Env, userId: string, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM ideas WHERE parent_id = ?1 AND user_id = ?2 LIMIT 1`,
  )
    .bind(id, userId)
    .first<{ x: number }>();
  return row !== null;
}
