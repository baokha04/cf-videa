import { del, get, post } from './api.js';
import { $, esc, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/variants');

const listEl = $('#list');
const msgEl = $('#msg');
const moreBtn = $('#more');
const scopeEl = $('#scope');

let cursor = null;
let items = [];
// Lọc theo một ý tưởng gốc. Cố ý KHÔNG làm ô chọn đổ sẵn danh sách ý tưởng: API phân
// trang tối đa 50 nên một ô như vậy sẽ âm thầm cụt khi người dùng có nhiều ý tưởng hơn.
// Bấm chip ý tưởng trên thẻ là cách vào đây, và luôn đúng với dữ liệu đang có.
// Bộ lọc theo ý tưởng gốc đọc thẳng từ URL: chip trên thẻ là một liên kết thật, nên
// trạng thái lọc chia sẻ được, tải lại được, và nút Back của trình duyệt chạy đúng.
const ideaFilter = new URLSearchParams(location.search).get('idea');

function query(withCursor) {
  const p = new URLSearchParams();
  const q = $('#q').value.trim();
  if (q) p.set('q', q);
  if (ideaFilter) p.set('idea', ideaFilter);
  p.set('limit', '20');
  if (withCursor && cursor) p.set('cursor', cursor);
  return `/api/variants?${p.toString()}`;
}

function card(v) {
  const script = v.script_outline.trim() ? 'dàn ý riêng' : 'dùng dàn ý gốc';
  const pending = v.indexed
    ? ''
    : '<span class="chip pending" title="Chưa nằm trong tìm kiếm ngữ nghĩa">chưa index</span>';
  return `<article class="card variant">
    <h3><a href="/idea?id=${encodeURIComponent(v.idea_id)}">${esc(v.title)}</a></h3>
    ${v.angle ? `<p class="hook">${esc(v.angle)}</p>` : ''}
    <div class="meta">
      <a class="chip" href="/variants?idea=${encodeURIComponent(v.idea_id)}"
         title="Chỉ xem biến thể của ý tưởng này">${esc(v.idea_title)}</a>
      <span class="chip">${script}</span>
      ${pending}
      <button class="link" type="button" data-index="${esc(v.id)}">Index</button>
      <a class="link" href="/idea?id=${encodeURIComponent(v.idea_id)}">Sửa ở ý tưởng gốc</a>
      <button class="link" type="button" data-del="${esc(v.id)}">Xoá</button>
    </div>
  </article>`;
}

function renderScope() {
  if (!ideaFilter) {
    scopeEl.hidden = true;
    return;
  }
  const known = items.find((v) => v.idea_id === ideaFilter);
  scopeEl.innerHTML =
    `Đang lọc theo ý tưởng <strong>${esc(known ? known.idea_title : ideaFilter)}</strong>. `
    + '<a href="/variants">Bỏ lọc</a>';
  scopeEl.hidden = false;
}

async function load(append = false) {
  try {
    const data = await get(query(append));
    items = append ? items.concat(data.variants) : data.variants;
    cursor = data.next_cursor;
    listEl.innerHTML = items.length
      ? items.map(card).join('')
      : '<p class="empty">Chưa có biến thể nào khớp. Thêm biến thể ở trang một ý tưởng gốc.</p>';
    moreBtn.hidden = !cursor;
    renderScope();
  } catch (err) {
    show(msgEl, err.message);
  }
}

$('#filters').addEventListener('submit', (e) => {
  e.preventDefault();
  cursor = null;
  load(false);
});

moreBtn.addEventListener('click', () => load(true));

listEl.addEventListener('click', async (e) => {
  const indexId = e.target?.dataset?.index;
  if (indexId) {
    e.target.disabled = true;
    e.target.textContent = '…';
    try {
      const r = await post(`/api/variants/${encodeURIComponent(indexId)}/index`);
      show(msgEl, r.indexed
        ? 'Đã index biến thể. Tìm được sau khoảng một phút nữa.'
        : 'Index chưa xong, thử lại sau.', r.indexed ? 'ok' : 'note');
    } catch (err) {
      show(msgEl, err.message);
    }
    cursor = null;
    await load(false);
    return;
  }

  const delId = e.target?.dataset?.del;
  if (delId) {
    if (!confirm('Xoá biến thể này? Ý tưởng gốc vẫn được giữ nguyên.')) return;
    try {
      await del(`/api/variants/${encodeURIComponent(delId)}`);
      show(msgEl, 'Đã xoá biến thể.', 'ok');
    } catch (err) {
      show(msgEl, err.message);
    }
    cursor = null;
    await load(false);
  }
});

await load(false);
