// Đo chi phí PBKDF2 bằng chính WebCrypto của Node (cùng thuật toán, cùng nền
// native như workerd). Đây là ước lượng bậc độ lớn, không thay thế được số đo
// thật trên edge qua `wrangler pages deployment tail`.
const enc = new TextEncoder();
async function derive(pw, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations }, key, 256);
}
for (const n of [50_000, 100_000, 210_000, 600_000]) {
  await derive('warmup', 1000);
  const t0 = performance.now();
  const R = 5;
  for (let i = 0; i < R; i++) await derive('matkhau-rat-dai-12345', n);
  const ms = (performance.now() - t0) / R;
  console.log(`${String(n).padStart(7)} vòng  →  ${ms.toFixed(1)} ms/lần băm`);
}
