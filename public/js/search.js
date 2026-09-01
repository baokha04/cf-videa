import { get } from './api.js';
import { $, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/search');

const listEl = $('#list');
const msg = $('#msg');
const go = $('#go');

async function run(q) {
  show(msg, '');
  go.disabled = true;
  go.textContent = 'Đang tìm…';
  try {
    const data = await get(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
    // Server lùi về tìm từ khoá khi Vectorize hoặc Workers AI không dùng được.
    // Người dùng cần biết mình đang xem kết quả loại nào.
    if (data.mode === 'fallback') {
      show(
        msg,
        'Tìm kiếm ngữ nghĩa tạm thời không dùng được — đang hiển thị kết quả khớp từ khoá.',
        'note',
      );
    }
    renderList(
      listEl,
      data.items,
      'Không tìm thấy ý tưởng nào. Ý tưởng vừa tạo cần khoảng một phút mới xuất hiện ở đây.',
    );
    const url = new URL(location.href);
    url.searchParams.set('q', q);
    history.replaceState(null, '', url);
  } catch (err) {
    show(msg, err.message);
  } finally {
    go.disabled = false;
    go.textContent = 'Tìm';
  }
}

$('#f').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (q) void run(q);
});

const initial = new URLSearchParams(location.search).get('q');
if (initial) {
  $('#q').value = initial;
  void run(initial);
}
