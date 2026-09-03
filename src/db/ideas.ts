import type { Env, IdeaRow, IdeaStatus, Platform } from '../types';
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
 * migrations/0004 — lệch một ký tự là SQLite bỏ qua index và quét toàn bảng.
 *
 * Hai loại bẩn, và loại thứ hai KHÔNG cần gọi AI:
 *  - nội dung đổi   → embedded_hash lệch content_hash → phải nhúng lại
 *  - metadata đổi   → indexed_meta_hash lệch chữ ký hiện tại → chỉ ghi đè metadata
 */
export const DIRTY_SQL = `(
  embedded_hash IS NULL
  OR embedded_hash <> content_hash
  OR indexed_meta_hash IS NULL
  OR indexed_meta_hash <> status || '|' || platform || '|' || visibility
)`;

/** Hàng này cần nhúng lại (không chỉ cập nhật metadata)? */
export function needsEmbedding(row: IdeaRow): boolean {
  return row.embedded_hash === null || row.embedded_hash !== row.content_hash;
}

export interface IdeaInput {
  title: string;
  script_outline: string;
  platform: Platform;
  niche: string;
  status: IdeaStatus;
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
  await env.DB.prepare(
    `INSERT INTO ideas (id, user_id, title, script_outline, platform, niche, status,
                        visibility, lang, content_hash, embed_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'private', 'vi', ?8, 0, ?9, ?9)`,
  )
    .bind(
      id,
      userId,
      input.title,
      input.script_outline,
      input.platform,
      input.niche,
      input.status,
      contentHash,
      t,
    )
    .run();
  return {
    id,
    user_id: userId,
    ...input,
    visibility: 'private',
    lang: 'vi',
    content_hash: contentHash,
    embedded_hash: null,
    indexed_meta_hash: null,
    embedding_model: null,
    embedded_at: null,
    embed_attempts: 0,
    created_at: t,
    updated_at: t,
  };
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
        SET title = ?3, script_outline = ?4, platform = ?5, niche = ?6,
            status = ?7, content_hash = ?8, updated_at = ?9
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(
      id,
      userId,
      input.title,
      input.script_outline,
      input.platform,
      input.niche,
      input.status,
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
            indexed_meta_hash = status || '|' || platform || '|' || visibility
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
        SET indexed_meta_hash = status || '|' || platform || '|' || visibility,
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
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    // Tìm cả trong biến thể: người dùng nhớ góc triển khai chứ không phải lúc nào
    // cũng nhớ tiêu đề gốc.
    where.push(
      `(i.title LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR i.script_outline LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR i.niche LIKE ${bind(like)} ESCAPE '\\'` +
        ` OR EXISTS (SELECT 1 FROM idea_variants v WHERE v.idea_id = i.id` +
        ` AND (v.title LIKE ${bind(like)} ESCAPE '\\' OR v.angle LIKE ${bind(like)} ESCAPE '\\')))`,
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
