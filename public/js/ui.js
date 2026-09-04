// Helper render nhỏ. Không có template engine, nên quy tắc là tuyệt đối:
// MỌI giá trị do người dùng nhập đều phải đi qua esc() trước khi ghép vào HTML.
// CSP nghiêm ngặt trong public/_headers là lớp chắn cuối, không phải lớp đầu.

// api.js KHÔNG import ngược lại ui.js, nên chiều phụ thuộc này không tạo vòng lặp.
import { post } from './api.js';

/**
 * Bộ icon inline.
 *
 * SVG viết thẳng vào HTML chứ không phải font icon hay ảnh: CSP trong public/_headers
 * chỉ cho tài nguyên CÙNG GỐC (`default-src 'self'`, `img-src 'self' data:`), nên mọi
 * bộ icon tải từ CDN đều bị chặn câm. `stroke: currentColor` để icon tự đổi màu theo
 * nút chứa nó — nút primary, nút danger và chế độ tối dùng chung một đường vẽ.
 *
 * Đường vẽ theo phong cách Feather (24×24, nét 2, không tô).
 */
const ICONS = {
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  index: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
  signup: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  devices: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  revoke: '<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>',
  busy: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  // Ba trạng thái của nút đổi giao diện: theo hệ thống / sáng / tối.
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18" fill="currentColor" stroke="none"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
};

/** SVG của một icon. `aria-hidden` vì nhãn nằm ở aria-label của nút, không phải ở đây. */
export function iconMarkup(name) {
  // data-busy để CSS cho riêng icon "đang chạy" quay tròn.
  const busy = name === 'busy' ? ' data-busy' : '';
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"${busy}>${ICONS[name] ?? ICONS.x}</svg>`;
}

/**
 * Nút thật sự bị bấm trong một trình xử lý uỷ quyền.
 *
 * BẮT BUỘC dùng thay cho `e.target` từ khi nút chỉ còn icon: cú bấm rơi vào chính
 * `<svg>` (hay `<path>`) bên trong nút, nên `e.target.dataset` RỖNG và mọi handler
 * uỷ quyền im lặng không làm gì — không lỗi, không dấu hiệu. Đã dính đúng lỗi này khi
 * đổi sang icon: Sửa / Xoá / Index / Thu hồi đều thành nút chết câm.
 */
export function btnOf(e) {
  return e.target?.closest?.('button') ?? null;
}

/**
 * Đặt icon + nhãn cho một nút CHỈ CÓ ICON.
 *
 * `label` là bắt buộc và đi vào cả `aria-label` lẫn `title`: nút không còn chữ, nên
 * thiếu nhãn là nó thành ô vuông câm — người dùng trình đọc màn hình không biết nó làm
 * gì, người nhìn thấy cũng phải đoán. Dùng hàm này thay cho `btn.textContent = …`, vì
 * gán textContent sẽ xoá luôn SVG bên trong.
 */
export function setIcon(btn, name, label) {
  if (!btn) return;
  btn.innerHTML = iconMarkup(name);
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

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
 * trang này với query dựng từ các ô nhập. Ở các trang trong app không ô nào có thuộc
 * tính `name`, nên query ra RỖNG và mọi tham số trên URL bay sạch: /idea mất `?id=` rồi
 * nạp lại thành "Ý tưởng mới" — mất tiêu đề, mất khối nguồn gốc, không một thông báo
 * nào; /variants mất `?idea=`; /search mất `?q=`. Ở login/register thì ngược lại, ô
 * nhập CÓ `name`, nên query không rỗng mà mang thẳng mật khẩu lên URL.
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
      <button class="link" type="button" data-index="${esc(idea.id)}"
              aria-label="Index ý tưởng này" title="Index ý tưởng này">${iconMarkup('index')}</button>
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
    const btn = btnOf(e);
    const id = btn?.dataset?.index;
    if (!id) return;

    const card = btn.closest('.card');
    btn.disabled = true;
    // Nút chỉ có icon: phải đổi qua setIcon, gán textContent sẽ xoá mất SVG bên trong.
    const label = btn.title;
    setIcon(btn, 'busy', 'Đang index…');
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
        setIcon(btn, 'check', 'Đã index');
      } else {
        setIcon(btn, 'index', label);
        btn.disabled = false;
      }
    } catch (err) {
      onMessage?.(err.message);
      setIcon(btn, 'index', label);
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
