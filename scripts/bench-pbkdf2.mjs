// Đo chi phí PBKDF2 bằng WebCrypto (cùng thuật toán, cùng nền native như workerd).
//
// LƯU Ý QUAN TRỌNG: workerd chặn cứng số vòng ở 100.000 — vượt qua sẽ ném
// NotSupportedError, KHÔNG phụ thuộc gói cước. Node không có giới hạn này, nên
// script vẫn đo được các mức cao hơn để so sánh, nhưng chỉ mức ≤ 100.000 mới
// chạy được thật trên Cloudflare.
const enc = new TextEncoder();

async function derive(pw, iterations, hash) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash, salt: new Uint8Array(16), iterations },
    key,
    256,
  );
}

const R = 5;
for (const hash of ['SHA-256', 'SHA-512']) {
  for (const n of [50_000, 100_000, 210_000, 600_000]) {
    await derive('warmup', 1000, hash);
    const t0 = performance.now();
    for (let i = 0; i < R; i++) await derive('matkhau-rat-dai-12345', n, hash);
    const ms = (performance.now() - t0) / R;
    const cap = n > 100_000 ? '  (workerd TỪ CHỐI)' : '';
    console.log(`${hash}  ${String(n).padStart(7)} vòng  →  ${ms.toFixed(1).padStart(6)} ms${cap}`);
  }
}
