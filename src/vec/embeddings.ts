import type { Env, IdeaRow } from '../types';
import { sha256Hex } from '../util/hash';

/**
 * ĐÂY LÀ NƠI DUY NHẤT GỌI AI TRONG TOÀN BỘ DỰ ÁN, và nó chỉ gọi một model NHÚNG.
 * Không có sinh văn bản, không có LLM, không có endpoint "tạo ý tưởng" ở đâu cả:
 * app chỉ index và truy vấn lại chính dữ liệu người dùng đã tự nhập.
 *
 * bge-m3 trả vector 1024 chiều, đa ngôn ngữ và xử lý tiếng Việt tốt.
 */
export const MODEL_ID = '@cf/baai/bge-m3';
export const DIMENSIONS = 1024;

/** Giới hạn độ dài để một ý tưởng dài không nuốt trọn cửa sổ ngữ cảnh. */
const MAX_EMBED_CHARS = 4000;

/**
 * Văn bản đem đi nhúng. Một nguồn sự thật duy nhất: cả lúc ghi, lúc đối soát và
 * lúc tính content_hash đều đi qua hàm này, nên hash không bao giờ lệch với vector.
 */
export function buildEmbedText(idea: Pick<IdeaRow, 'title' | 'hook' | 'script_outline' | 'niche' | 'platform'>, tags: string[]): string {
  const parts = [
    idea.title,
    idea.hook,
    idea.script_outline,
    idea.niche ? `Niche: ${idea.niche}` : '',
    `Nền tảng: ${idea.platform}`,
    tags.length ? `Tags: ${tags.join(', ')}` : '',
  ].filter(Boolean);
  return parts.join('\n').slice(0, MAX_EMBED_CHARS);
}

/**
 * Gộp MODEL_ID vào hash là chi tiết quan trọng: đổi model thì mọi content_hash
 * đổi theo, mọi hàng tự động thành "bẩn", và công cụ đối soát có sẵn trở thành
 * công cụ chuyển đổi model — không cần viết thêm gì.
 */
export function contentHash(embedText: string): Promise<string> {
  return sha256Hex(`${embedText}|${MODEL_ID}`);
}

/**
 * Vector giả lập tất định cho unit test và làm việc offline: cùng văn bản luôn cho
 * cùng vector, văn bản gần nhau KHÔNG cho vector gần nhau. Chỉ dùng để kiểm thử
 * phần kế toán đồng bộ, không bao giờ để đánh giá chất lượng tìm kiếm.
 */
async function stubVector(text: string): Promise<number[]> {
  const seedHex = await sha256Hex(text);
  const out = new Array<number>(DIMENSIONS);
  let s = 0;
  for (let i = 0; i < seedHex.length; i++) s = (s * 31 + seedHex.charCodeAt(i)) >>> 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return normalize(out);
}

/**
 * Chuẩn hoá vỏ bọc phản hồi của Workers AI ở đúng một chỗ. Một vài model trả
 * `{ data: [...] }`, số khác lồng dưới `.response` — nếu hình dạng đổi thì đây là
 * chỗ duy nhất phải sửa.
 */
function extractVectors(raw: unknown, expected: number): number[][] {
  const obj = raw as { data?: unknown; response?: { data?: unknown } };
  const data = (obj?.data ?? obj?.response?.data) as unknown;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(
      `Workers AI trả về hình dạng không mong đợi: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return data.map((v, i) => {
    if (!Array.isArray(v) || v.length !== DIMENSIONS) {
      throw new Error(`Vector thứ ${i} có ${Array.isArray(v) ? v.length : '?'} chiều, cần ${DIMENSIONS}`);
    }
    return v as number[];
  });
}

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (env.EMBEDDINGS_MODE === 'stub') {
    return Promise.all(texts.map(stubVector));
  }
  const raw = await env.AI.run(MODEL_ID as never, { text: texts } as never);
  return extractVectors(raw, texts.length);
}

export async function embedOne(env: Env, text: string): Promise<number[]> {
  const [v] = await embed(env, [text]);
  if (!v) throw new Error('Không nhận được vector từ Workers AI');
  return v;
}

export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}
