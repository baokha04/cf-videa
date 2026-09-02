import { env } from 'cloudflare:test';
// Workerd không có filesystem, nên không đọc migration bằng fs được. Vite nhúng
// nội dung file vào bundle qua hậu tố ?raw. Điểm quan trọng: test dùng ĐÚNG file
// schema của production — nếu test tự viết lại CREATE TABLE thì nó sẽ trôi khỏi
// schema thật và trở nên vô dụng đúng lúc cần nhất.
import initSql from '../migrations/0001_init.sql?raw';
import cronSql from '../migrations/0002_cron_heartbeat.sql?raw';
import renameSql from '../migrations/0003_rename_maintenance.sql?raw';
import syncSql from '../migrations/0004_manual_sync_and_remember.sql?raw';
import type { Env } from '../src/types';

export function testEnv(): Env {
  return env as unknown as Env;
}

export async function migrate(): Promise<void> {
  const db = testEnv().DB;
  const already = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_runs'`)
    .first();
  if (already) return;

  const statements = [initSql, cronSql, renameSql, syncSql]
    .join('\n')
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
  for (const s of statements) {
    await db.prepare(s).run();
  }
}

/**
 * Vectorize giả trong bộ nhớ. Đủ để kiểm tra phần KẾ TOÁN đồng bộ một cách tất
 * định; cố ý không dùng để đánh giá chất lượng tìm kiếm — chất lượng embedding là
 * thuộc tính của một model được host và có thể đổi bất cứ lúc nào.
 */
export function fakeVectorize() {
  const store = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  return {
    store,
    async upsert(
      vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>,
    ) {
      for (const v of vectors) store.set(v.id, { values: v.values, metadata: v.metadata });
      return { mutationId: 'fake' };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) store.delete(id);
      return { mutationId: 'fake' };
    },
    async getByIds(ids: string[]) {
      return ids
        .filter((id) => store.has(id))
        .map((id) => {
          const v = store.get(id) as { values: number[]; metadata: Record<string, unknown> };
          return { id, values: v.values, metadata: v.metadata };
        });
    },
    async query(
      vector: number[],
      opts: { topK: number; filter?: Record<string, { $eq?: unknown }> },
    ) {
      const userId = opts.filter?.['user_id']?.$eq;
      const matches = [...store.entries()]
        .filter(([, v]) => userId === undefined || v.metadata['user_id'] === userId)
        .map(([id, v]) => ({ id, score: cosine(vector, v.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.topK);
      return { count: matches.length, matches };
    },
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
