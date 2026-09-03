// Helper render nhỏ. Không có template engine, nên quy tắc là tuyệt đối:
// MỌI giá trị do người dùng nhập đều phải đi qua esc() trước khi ghép vào HTML.
// CSP nghiêm ngặt trong public/_headers là lớp chắn cuối, không phải lớp đầu.

export function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function show(el, text, kind = 'error') {
  if (!el) return;
  el.className = `msg ${kind}`;
  el.textContent = text ?? '';
}

export function clearMsg(el) {
  if (el) el.textContent = '';
}

const PLATFORM_LABEL = {
  tiktok: 'TikTok',
  reels: 'Reels',
  shorts: 'Shorts',
  other: 'Khác',
};

const STATUS_LABEL = {
  idea: 'Ý tưởng',
  scripted: 'Đã viết kịch bản',
  filmed: 'Đã quay',
  published: 'Đã đăng',
  archived: 'Lưu trữ',
};

export const platformLabel = (p) => PLATFORM_LABEL[p] ?? p;
export const statusLabel = (s) => STATUS_LABEL[s] ?? s;

export function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Một thẻ ý tưởng. Trả về chuỗi HTML đã escape đầy đủ. */
export function ideaCard(idea) {
  const tags = idea.tags
    .map((t) => `<span class="chip">#${esc(t)}</span>`)
    .join('');
  const score =
    typeof idea.score === 'number'
      ? `<span class="chip score">độ khớp ${(idea.score * 100).toFixed(0)}%</span>`
      : '';
  // Ý tưởng chưa index thì nói thẳng ra, vì nó sẽ không hiện trong tìm kiếm ngữ nghĩa.
  const pending = idea.indexed
    ? ''
    : '<span class="chip pending" title="Chưa nằm trong tìm kiếm ngữ nghĩa">chưa index</span>';
  const liked = idea.liked ? '<span class="chip">♥ đã thích</span>' : '';
  const variants = idea.variant_count > 0
    ? `<span class="chip">${idea.variant_count} biến thể</span>`
    : '';

  return `<article class="card idea">
    <h3><a href="/idea?id=${encodeURIComponent(idea.id)}">${esc(idea.title)}</a></h3>
    ${idea.script_outline ? `<p class="hook">${esc(idea.script_outline.slice(0, 140))}</p>` : ''}
    <div class="meta">
      <span class="chip">${esc(platformLabel(idea.platform))}</span>
      <span class="chip">${esc(statusLabel(idea.status))}</span>
      ${idea.niche ? `<span class="chip">${esc(idea.niche)}</span>` : ''}
      ${variants}${tags}${liked}${score}${pending}
    </div>
  </article>`;
}

export function renderList(container, items, emptyText) {
  if (!items || items.length === 0) {
    container.innerHTML = `<p class="empty">${esc(emptyText)}</p>`;
    return;
  }
  container.innerHTML = items.map(ideaCard).join('');
}
