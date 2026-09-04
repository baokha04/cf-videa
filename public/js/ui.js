// Helper render nhỏ. Không có template engine, nên quy tắc là tuyệt đối:
// MỌI giá trị do người dùng nhập đều phải đi qua esc() trước khi ghép vào HTML.
// CSP nghiêm ngặt trong public/_headers là lớp chắn cuối, không phải lớp đầu.

// api.js KHÔNG import ngược lại ui.js, nên chiều phụ thuộc này không tạo vòng lặp.
import { post } from './api.js';

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

/**
 * Gắn trình xử lý `submit` cho một form, rồi MỞ KHOÁ nút gửi của nó.
 *
 * Bất biến duy nhất mà hàm này giữ: nút bấm được ⇔ đã có trình xử lý. Nút gửi để
 * `disabled` sẵn trong HTML và chỉ được mở ở đây.
 *
 * Không có nó thì có một khoảng trống thật: form nằm sẵn trong HTML tĩnh nên hiện ra
 * và bấm được ngay, còn trình xử lý thì phải chờ module tải và chạy xong. Bấm trong
 * khoảng đó, trình duyệt submit form theo kiểu HTML thuần — điều hướng GET về chính
 * trang này với query dựng từ các ô nhập. Không ô nào trong dự án có thuộc tính `name`,
 * nên query ra RỖNG và mọi tham số trên URL bay sạch. Ở /idea nó làm mất `?id=`, trang
 * nạp lại thành "Ý tưởng mới" và mất luôn khối biến thể lẫn khối kết hợp — không một
 * thông báo nào. Ở /variants là mất `?idea=`, ở /search là mất `?q=`.
 *
 * `enable: false` dành cho form phải chờ dữ liệu về rồi mới cho gửi: ở /idea, bấm Lưu
 * trên form còn rỗng sẽ ghi đè ý tưởng bằng đúng cái rỗng đó.
 */
export function bindSubmit(form, button, handler, { enable = true } = {}) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handler(e);
  });
  if (enable) button.disabled = false;
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

  const combined = idea.source_idea_id
    ? '<span class="chip" title="Được tạo bằng chức năng kết hợp">kết hợp</span>'
    : '';

  return `<article class="card idea">
    <h3><a href="/idea?id=${encodeURIComponent(idea.id)}">${esc(idea.title)}</a></h3>
    ${idea.script_outline ? `<p class="hook">${esc(idea.script_outline.slice(0, 140))}</p>` : ''}
    <div class="meta">
      <span class="chip">${esc(platformLabel(idea.platform))}</span>
      <span class="chip">${esc(statusLabel(idea.status))}</span>
      ${idea.niche ? `<span class="chip">${esc(idea.niche)}</span>` : ''}
      ${variants}${tags}${liked}${score}${combined}${pending}
      <button class="link" type="button" data-index="${esc(idea.id)}">Index</button>
    </div>
  </article>`;
}

/**
 * Gắn xử lý cho nút "Index" nằm trong ideaCard.
 *
 * PHẢI ở đây chứ không phải trong từng trang: ideaCard dùng chung cho bốn trang (/app,
 * /search, /recommend và mục "Ý tưởng tương tự" của /idea), và trước đây chỉ /app viết
 * trình xử lý — ba trang kia render ra một cái nút bấm vào không có gì xảy ra.
 *
 * Cập nhật ĐÚNG thẻ vừa bấm tại chỗ, cố ý không tải lại cả danh sách: trên /search một
 * lần tải lại là một lần nhúng câu truy vấn, tốn lời gọi Workers AI và ăn vào rate
 * limit; trên /recommend thì danh sách nhảy làm mất chỗ đang đọc.
 */
export function bindIndexButtons(container, { onMessage } = {}) {
  container.addEventListener('click', async (e) => {
    const btn = e.target;
    const id = btn?.dataset?.index;
    if (!id) return;

    const card = btn.closest('.card');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '…';
    try {
      const r = await post(`/api/ideas/${encodeURIComponent(id)}/index`);
      if (r.duplicates?.length) {
        const names = r.duplicates.map((d) => d.title).join(', ');
        onMessage?.(`Đã index. Có thể trùng với: ${names}. Mở ý tưởng để xem chi tiết.`, 'note');
      } else {
        onMessage?.(r.indexed
          ? 'Đã index. Tìm kiếm ngữ nghĩa thấy được sau khoảng một phút nữa.'
          : 'Index chưa xong, thử lại sau.', r.indexed ? 'ok' : 'note');
      }

      if (r.indexed) {
        card?.querySelector('.chip.pending')?.remove();
        btn.textContent = 'Đã index';
      } else {
        btn.textContent = label;
        btn.disabled = false;
      }
    } catch (err) {
      onMessage?.(err.message);
      btn.textContent = label;
      btn.disabled = false;
    }
  });
}

export function renderList(container, items, emptyText) {
  if (!items || items.length === 0) {
    container.innerHTML = `<p class="empty">${esc(emptyText)}</p>`;
    return;
  }
  container.innerHTML = items.map(ideaCard).join('');
}
