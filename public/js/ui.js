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

const KIND_LABEL = {
  origin: 'Ý tưởng gốc',
  variant: 'Biến thể',
};

export const kindLabel = (k) => KIND_LABEL[k] ?? k;

/**
 * Một thẻ ý tưởng. Trả về chuỗi HTML đã escape đầy đủ.
 *
 * `opts.sync` gắn nút đồng bộ index của RIÊNG thẻ này; `opts.manage` gắn thêm nút
 * Sửa và Xoá. Cả hai mặc định tắt: thẻ còn xuất hiện trong kết quả tìm kiếm và danh
 * sách gợi ý, nơi những nút đó chỉ làm nhiễu.
 */
export function ideaCard(idea, opts = {}) {
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
  // Chỉ dán nhãn cho biến thể. Ý tưởng gốc là mặc định, dán nhãn cho cả hai chỉ làm
  // mọi thẻ dài ra mà không thêm thông tin nào.
  const kind =
    idea.kind === 'variant' ? '<span class="chip variant">biến thể</span>' : '';
  const variants =
    idea.variant_count > 0
      ? `<span class="chip">${idea.variant_count} biến thể</span>`
      : '';
  const hooks =
    idea.hooks && idea.hooks.length > 0
      ? `<span class="chip">${idea.hooks.length} hook</span>`
      : '';
  // data-indexed để nút biết mình đang là "đồng bộ" hay "đồng bộ lại" mà không phải
  // gọi lại API chỉ để hỏi một trạng thái đã nằm sẵn trong dữ liệu vừa render.
  const syncBtn = opts.sync
    ? `<button type="button" class="sync-one" data-id="${esc(idea.id)}"
               data-indexed="${idea.indexed ? '1' : '0'}">
         ${idea.indexed ? 'Đồng bộ lại' : 'Đồng bộ index'}
       </button>`
    : '';
  // Sửa là một liên kết mở thẳng trang ý tưởng, không phải sửa tại chỗ: một ý tưởng
  // có cả chục trường, nên sửa tại chỗ chỉ vài trường là một lời hứa nửa vời.
  const manageBtns = opts.manage
    ? `<a class="btn-link" href="/idea?id=${encodeURIComponent(idea.id)}"><button type="button">Sửa</button></a>
       <button type="button" class="delete-one danger" data-id="${esc(idea.id)}"
               data-title="${esc(idea.title)}">Xoá</button>`
    : '';
  const actions =
    syncBtn || manageBtns
      ? `<div class="idea-actions">${manageBtns}${syncBtn}</div>`
      : '';

  return `<article class="card idea">
    <h3><a href="/idea?id=${encodeURIComponent(idea.id)}">${esc(idea.title)}</a></h3>
    ${idea.hook ? `<p class="hook">${esc(idea.hook)}</p>` : ''}
    <div class="meta">
      <span class="chip">${esc(platformLabel(idea.platform))}</span>
      <span class="chip">${esc(statusLabel(idea.status))}</span>
      ${idea.niche ? `<span class="chip">${esc(idea.niche)}</span>` : ''}
      ${kind}${variants}${hooks}${tags}${liked}${score}${pending}
    </div>
    ${actions}
  </article>`;
}

export function renderList(container, items, emptyText, opts = {}) {
  if (!items || items.length === 0) {
    container.innerHTML = `<p class="empty">${esc(emptyText)}</p>`;
    return;
  }
  container.innerHTML = items.map((idea) => ideaCard(idea, opts)).join('');
}
