import { get, post } from './api.js';
import { $, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/app');

const listEl = $('#list');
const msgEl = $('#msg');
const moreBtn = $('#more');
const reindexBtn = $('#reindex');

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
    // Có bản ghi chưa index thì hiện nút đồng bộ — Pages không có cron nên đây là
    // đường thủ công để người dùng tự chạy đối soát.
    reindexBtn.hidden = !items.some((i) => !i.indexed);
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

reindexBtn.addEventListener('click', async () => {
  reindexBtn.disabled = true;
  reindexBtn.textContent = 'Đang đồng bộ…';
  try {
    // Endpoint xử lý theo lô, gọi lặp cho tới khi hết hàng bẩn.
    let remaining = Infinity;
    let rounds = 0;
    while (remaining > 0 && rounds < 20) {
      const r = await post('/api/reindex');
      remaining = r.remaining;
      rounds++;
      if (r.processed === 0 && r.failed > 0) break;
    }
    show(
      msgEl,
      remaining > 0
        ? `Còn ${remaining} ý tưởng chưa index được. Kiểm tra cấu hình Vectorize và Workers AI.`
        : 'Đã đồng bộ xong.',
      remaining > 0 ? 'note' : 'ok',
    );
    await load(false);
  } catch (err) {
    show(msgEl, err.message);
  } finally {
    reindexBtn.disabled = false;
    reindexBtn.textContent = 'Đồng bộ lại index';
  }
});

// Đọc bộ lọc từ URL để trang chia sẻ được.
const initial = new URLSearchParams(location.search);
for (const id of ['q', 'status', 'platform', 'tag']) {
  const v = initial.get(id);
  if (v) $(`#${id}`).value = v;
}

await loadTags();
await load(false);
