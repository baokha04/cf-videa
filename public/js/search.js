import { get } from './api.js';
import { $, bindIndexButtons, renderList, show } from './ui.js';
import { mountNavSafe } from './nav.js';

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
      'Không tìm thấy ý tưởng nào. Ý tưởng mới chỉ xuất hiện ở đây sau khi bạn bấm '
        + 'nút "Index" trên chính ý tưởng đó, và chờ thêm khoảng một phút.',
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

// Kết quả tìm từ khoá (khi Vectorize hỏng) đọc thẳng D1 nên có thể chứa ý tưởng chưa
// index — nút Index trên thẻ vì thế vẫn có việc để làm.
bindIndexButtons(listEl, { onMessage: (text, kind) => show(msg, text, kind) });

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

// Thanh điều hướng dựng SAU CÙNG, sau khi mọi trình xử lý ở trên đã gắn.
//
// Trước đây nó là `await mountNav(...)` ở dòng đầu module. Hai hệ quả, cả hai đều đã
// gặp thật: mountNav ném một cái là cả trang chết câm, và trong lúc nó còn đang chờ
// mạng thì các form đã hiện mà chưa có trình xử lý — bấm Lưu hay gõ Enter sẽ submit
// theo kiểu HTML thuần, điều hướng GET làm mất luôn tham số trên URL.
await mountNavSafe('/search');
