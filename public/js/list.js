import { get, post } from './api.js';
import { $, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/app');

const listEl = $('#list');
const msgEl = $('#msg');
const moreBtn = $('#more');
const reindexBtn = $('#reindex');
const syncBox = $('#sync');
const syncTitle = $('#sync-title');
const syncNote = $('#sync-note');

let cursor = null;
let items = [];

function query(withCursor) {
  const p = new URLSearchParams();
  const q = $('#q').value.trim();
  if (q) p.set('q', q);
  for (const id of ['status', 'platform', 'tag', 'kind']) {
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
    renderList(listEl, items, 'Chưa có ý tưởng nào khớp. Hãy tạo ý tưởng đầu tiên.', {
      sync: true,
    });
    moreBtn.hidden = !cursor;
  } catch (err) {
    show(msgEl, err.message);
  }
}

/**
 * Trạng thái đồng bộ hỏi thẳng server, KHÔNG đếm trên danh sách đang hiển thị:
 * danh sách bị phân trang và lọc, nên đếm trên đó sẽ bỏ sót những ý tưởng chưa
 * index nằm ngoài trang hiện tại — và người dùng sẽ tưởng đã đồng bộ xong.
 */
async function refreshSyncState() {
  let dirty = null;
  try {
    const r = await get('/api/sync');
    dirty = typeof r.dirty === 'number' ? r.dirty : null;
  } catch {
    dirty = null;
  }

  if (dirty === null) {
    syncBox.classList.remove('pending');
    syncTitle.textContent = 'Không kiểm tra được trạng thái index';
    syncNote.textContent = 'Vẫn bấm đồng bộ được.';
    reindexBtn.disabled = false;
    return dirty;
  }

  const pending = dirty > 0;
  syncBox.classList.toggle('pending', pending);
  syncTitle.textContent = pending
    ? `${dirty} ý tưởng chưa được index`
    : 'Mọi ý tưởng đã được index';
  syncNote.textContent = pending
    ? 'Chưa tìm được bằng tìm kiếm ngữ nghĩa cho tới khi bạn đồng bộ.'
    : 'Tìm kiếm ngữ nghĩa đang bám sát dữ liệu.';
  reindexBtn.disabled = !pending;
  return dirty;
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
  show(msgEl, '');
  let done = 0;
  let failed = 0;
  try {
    // Endpoint xử lý theo lô 50 hàng, nên gọi lặp cho tới khi hết. Giới hạn số vòng
    // để một lỗi lặp lại không biến thành vòng lặp vô hạn trên trình duyệt.
    let remaining = Infinity;
    for (let round = 0; round < 40 && remaining > 0; round++) {
      const r = await post('/api/reindex');
      done += r.processed;
      failed += r.failed;
      remaining = r.remaining;
      reindexBtn.textContent = `Đang đồng bộ… (${done})`;
      // Không tiến thêm được nữa thì dừng, đừng quay vòng vô ích.
      if (r.processed === 0) break;
    }

    if (remaining > 0) {
      show(
        msgEl,
        `Đã đồng bộ ${done} ý tưởng, còn ${remaining} chưa xong` +
          (failed > 0 ? ` (${failed} lỗi)` : '') +
          '. Thử lại sau ít phút.',
        'note',
      );
    } else {
      // Vector vừa ghi phải mất khoảng một phút mới truy vấn được — nói rõ để người
      // dùng không tưởng tìm kiếm bị hỏng khi thử ngay lập tức.
      show(
        msgEl,
        `Đã đồng bộ ${done} ý tưởng. Tìm kiếm ngữ nghĩa sẽ thấy chúng sau khoảng một phút.`,
        'ok',
      );
    }
    await refreshSyncState();
    await load(false);
  } catch (err) {
    show(msgEl, err.message);
    await refreshSyncState();
  } finally {
    reindexBtn.textContent = 'Đồng bộ index';
  }
});

/**
 * Nút đồng bộ của RIÊNG một thẻ.
 *
 * Uỷ quyền sự kiện trên cả danh sách thay vì gắn handler cho từng nút: danh sách
 * được render lại bằng innerHTML sau mỗi lần lọc hay tải thêm, nên handler gắn
 * trực tiếp sẽ biến mất cùng với DOM cũ.
 */
listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.sync-one');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;

  const original = btn.textContent.trim();
  btn.disabled = true;
  btn.textContent = 'Đang đồng bộ…';
  show(msgEl, '');
  try {
    const r = await post(`/api/ideas/${encodeURIComponent(id)}/reindex`);
    if (r.outcome === 'failed') {
      show(msgEl, 'Đồng bộ ý tưởng này không thành công. Thử lại sau ít phút.');
    } else if (r.outcome === 'clean') {
      show(msgEl, 'Ý tưởng này vốn đã khớp với tìm kiếm ngữ nghĩa.', 'ok');
    } else {
      // Vector vừa ghi mất khoảng một phút mới truy vấn được — nói rõ để người dùng
      // không tưởng tìm kiếm hỏng khi thử ngay lập tức.
      show(
        msgEl,
        'Đã đồng bộ ý tưởng này. Tìm kiếm ngữ nghĩa sẽ thấy nó sau khoảng một phút.',
        'ok',
      );
    }
    await refreshSyncState();
    await load(false);
  } catch (err) {
    show(msgEl, err.message);
    btn.disabled = false;
    btn.textContent = original;
  }
});

// Đọc bộ lọc từ URL để trang chia sẻ được.
const initial = new URLSearchParams(location.search);
for (const id of ['q', 'status', 'platform', 'tag', 'kind']) {
  const v = initial.get(id);
  if (v) $(`#${id}`).value = v;
}

await loadTags();
await load(false);
await refreshSyncState();
