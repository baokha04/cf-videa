import { get } from './api.js';
import { $, bindIndexButtons, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/app');

const listEl = $('#list');
const msgEl = $('#msg');
const moreBtn = $('#more');

let cursor = null;
let items = [];

function query(withCursor) {
  const p = new URLSearchParams();
  const q = $('#q').value.trim();
  if (q) p.set('q', q);
  for (const id of ['status', 'platform', 'tag']) {
    const v = $(`#${id}`).value;
    if (v) p.set(id, v);
  }
  p.set('limit', '20');
  if (withCursor && cursor) p.set('cursor', cursor);
  return `/api/ideas?${p.toString()}`;
}

async function load(append = false) {
  try {
    const data = await get(query(append));
    items = append ? items.concat(data.items) : data.items;
    cursor = data.next_cursor;
    renderList(listEl, items, 'Chưa có ý tưởng nào khớp. Hãy tạo ý tưởng đầu tiên.');
    moreBtn.hidden = !cursor;
  } catch (err) {
    show(msgEl, err.message);
  }
}

async function loadTags() {
  try {
    const { tags } = await get('/api/tags');
    const sel = $('#tag');
    for (const t of tags) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = `${t.name} (${t.count})`;
      sel.append(opt);
    }
  } catch {
    // Danh sách tag chỉ là tiện ích lọc; hỏng thì bỏ qua, không chặn cả trang.
  }
}

$('#filters').addEventListener('submit', (e) => {
  e.preventDefault();
  cursor = null;
  load(false);
});

moreBtn.addEventListener('click', () => load(true));

/**
 * Nút Index trên từng thẻ ý tưởng — xử lý dùng chung ở ui.js, vì cùng cái nút đó cũng
 * xuất hiện ở /search, /recommend và mục "Ý tưởng tương tự".
 *
 * Đây là đường index DUY NHẤT của giao diện: mỗi ý tưởng tự index bằng nút của nó, và
 * chỉ đường này mới trả về cảnh báo trùng.
 */
bindIndexButtons(listEl, { onMessage: (text, kind) => show(msgEl, text, kind) });

// Đọc bộ lọc từ URL để trang chia sẻ được.
const initial = new URLSearchParams(location.search);
for (const id of ['q', 'status', 'platform', 'tag']) {
  const v = initial.get(id);
  if (v) $(`#${id}`).value = v;
}

await loadTags();
await load(false);
