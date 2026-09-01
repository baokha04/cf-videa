import type { Env } from '../types';
import { likedIds } from '../db/likes';
import { sha256Hex } from '../util/hash';
import { now } from '../util/id';
import { DIMENSIONS, MODEL_ID, normalize } from './embeddings';
import { getVectors } from './index';

/**
 * "Vector sở thích": trung bình cộng đã chuẩn hoá của các vector ý tưởng mà user
 * đã thích. Không có LLM ở đây — chỉ là số học trên vector đã lưu sẵn.
 *
 * Vector được cache trong D1 dưới dạng BLOB Float32Array(1024) = 4096 byte, cùng
 * với source_hash để biết cache đã cũ hay chưa.
 */

function toBlob(v: number[]): ArrayBuffer {
  const f = new Float32Array(v);
  return f.buffer as ArrayBuffer;
}

function fromBlob(buf: ArrayBuffer | Uint8Array): number[] | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength !== DIMENSIONS * 4) return null;
  // Sao chép để bảo đảm căn lề trước khi dựng Float32Array.
  const copy = new Uint8Array(bytes);
  return Array.from(new Float32Array(copy.buffer));
}

export interface TasteVector {
  vector: number[];
  sourceCount: number;
}

export async function getTasteVector(env: Env, userId: string): Promise<TasteVector | null> {
  const liked = await likedIds(env, userId, 50);
  if (liked.length === 0) return null;

  const sourceHash = await sha256Hex([...liked].sort().join(','));

  const cached = await env.DB.prepare(
    `SELECT vector, source_count FROM user_profile_vectors
      WHERE user_id = ?1 AND source_hash = ?2 AND model = ?3`,
  )
    .bind(userId, sourceHash, MODEL_ID)
    .first<{ vector: ArrayBuffer; source_count: number }>();
  if (cached) {
    const v = fromBlob(cached.vector);
    if (v) return { vector: v, sourceCount: cached.source_count };
  }

  const vecMap = await getVectors(env, liked);
  if (vecMap.size === 0) return null;

  const mean = new Array<number>(DIMENSIONS).fill(0);
  for (const v of vecMap.values()) {
    const unit = normalize(v);
    for (let i = 0; i < DIMENSIONS; i++) {
      mean[i] = (mean[i] as number) + (unit[i] as number);
    }
  }
  for (let i = 0; i < DIMENSIONS; i++) mean[i] = (mean[i] as number) / vecMap.size;
  const vector = normalize(mean);

  await env.DB.prepare(
    `INSERT INTO user_profile_vectors (user_id, vector, model, source_count, source_hash, computed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       vector = ?2, model = ?3, source_count = ?4, source_hash = ?5, computed_at = ?6`,
  )
    .bind(userId, toBlob(vector), MODEL_ID, vecMap.size, sourceHash, now())
    .run();

  return { vector, sourceCount: vecMap.size };
}

/** Xoá cache khi danh sách like đổi — rẻ hơn là tính lại ngay. */
export async function invalidateTasteVector(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM user_profile_vectors WHERE user_id = ?1`)
    .bind(userId)
    .run();
}
