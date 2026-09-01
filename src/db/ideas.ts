import type { Env, IdeaRow, IdeaStatus, Platform } from '../types';
import { newId, now } from '../util/id';

/**
 * QUY TẮC KHÔNG NGOẠI LỆ: mọi hàm ở đây nhận userId làm tham số đầu tiên và mọi
 * câu lệnh đều có `WHERE user_id = ?`. Không route nào được viết SQL thô trên
 * bảng ideas. Kiểm tra quyền sở hữu là một vị từ trong câu lệnh, không phải một
 * lệnh `if` sau khi đã lấy dữ liệu về — và không khớp thì trả 404 chứ không phải
 * 403, để không xác nhận sự tồn tại của hàng thuộc user khác.
 */

export interface IdeaInput {
  title: string;
  hook: string;
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
    `INSERT INTO ideas (id, user_id, title, hook, script_outline, platform, niche, status,
                        visibility, lang, content_hash, embed_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'private', 'vi', ?9, 0, ?10, ?10)`,
  )
    .bind(
      id,
      userId,
      input.title,
      input.hook,
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
        SET title = ?3, hook = ?4, script_outline = ?5, platform = ?6, niche = ?7,
            status = ?8, content_hash = ?9, updated_at = ?10
      WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(
      id,
      userId,
      input.title,
      input.hook,
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

/** Ghi nhận embed thành công. Có điều kiện content_hash để không đánh dấu nhầm
 *  khi người dùng vừa sửa nội dung trong lúc lệnh embed đang chạy. */
export async function markEmbedded(
  env: Env,
  id: string,
  contentHash: string,
  model: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ideas
        SET embedded_hash = ?2, embedding_model = ?3, embedded_at = ?4, embed_attempts = 0
      WHERE id = ?1 AND content_hash = ?2`,
  )
    .bind(id, contentHash, model, now())
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
  const p = () => `?${binds.length + 1}`;

  if (filters.status) {
    where.push(`i.status = ${p()}`);
    binds.push(filters.status);
  }
  if (filters.platform) {
    where.push(`i.platform = ${p()}`);
    binds.push(filters.platform);
  }
  if (filters.niche) {
    where.push(`i.niche = ${p()}`);
    binds.push(filters.niche);
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(
      `(i.title LIKE ${p()} ESCAPE '\\' OR i.hook LIKE ${p()} ESCAPE '\\'` +
        ` OR i.script_outline LIKE ${p()} ESCAPE '\\' OR i.niche LIKE ${p()} ESCAPE '\\')`,
    );
    binds.push(like, like, like, like);
  }
  if (filters.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM idea_tags it JOIN tags t ON t.id = it.tag_id
                WHERE it.idea_id = i.id AND t.user_id = ?1 AND t.name = ${p()})`,
    );
    binds.push(filters.tag);
  }
  if (filters.likedOnly) {
    where.push(`EXISTS (SELECT 1 FROM idea_likes l WHERE l.idea_id = i.id AND l.user_id = ?1)`);
  }
  if (cursor) {
    where.push(`(i.updated_at < ${p()} OR (i.updated_at = ${p()} AND i.id < ${p()}))`);
    binds.push(cursor.updated_at, cursor.updated_at, cursor.id);
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
    ? `SELECT * FROM ideas
        WHERE (embedded_hash IS NULL OR embedded_hash <> content_hash) AND user_id = ?2
        ORDER BY updated_at LIMIT ?1`
    : `SELECT * FROM ideas
        WHERE embedded_hash IS NULL OR embedded_hash <> content_hash
        ORDER BY updated_at LIMIT ?1`;
  const stmt = userId
    ? env.DB.prepare(sql).bind(limit, userId)
    : env.DB.prepare(sql).bind(limit);
  const { results } = await stmt.all<IdeaRow>();
  return results;
}

export async function countDirty(env: Env, userId?: string): Promise<number> {
  const sql = userId
    ? `SELECT COUNT(*) AS n FROM ideas
        WHERE (embedded_hash IS NULL OR embedded_hash <> content_hash) AND user_id = ?1`
    : `SELECT COUNT(*) AS n FROM ideas WHERE embedded_hash IS NULL OR embedded_hash <> content_hash`;
  const stmt = userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql);
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

/** Đánh dấu mọi hàng của một user là bẩn — dùng khi ép reindex toàn bộ. */
export async function markAllDirty(env: Env, userId?: string): Promise<number> {
  const sql = userId
    ? `UPDATE ideas SET embedded_hash = NULL WHERE user_id = ?1`
    : `UPDATE ideas SET embedded_hash = NULL`;
  const stmt = userId ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql);
  const res = await stmt.run();
  return res.meta.changes ?? 0;
}
