import { del, get, patch, post } from './api.js';
import { $, bindIndexButtons, bindSubmit, esc, renderList, show } from './ui.js';
import { mountNavSafe } from './nav.js';

// Ba thông báo, gom lại một chỗ để chúng không lệch nhau khi sửa.
const SAVED_MSG =
  'Đã lưu vào cơ sở dữ liệu. Ý tưởng chưa nằm trong tìm kiếm ngữ nghĩa — '
  + 'bấm "Index ý tưởng này" khi bạn viết xong.';
const SAVED_INDEXED_MSG = 'Đã lưu. Ý tưởng vẫn đang khớp với tìm kiếm ngữ nghĩa.';
const CREATED_MSG =
  'Đã tạo ý tưởng và lưu vào cơ sở dữ liệu. Bấm "Index ý tưởng này" để nó xuất hiện '
  + 'trong tìm kiếm ngữ nghĩa.';

const id = new URLSearchParams(location.search).get('id');
const isNew = !id;
const msg = $('#msg');
const saveBtn = $('#save');
const likeBtn = $('#like');
const delBtn = $('#del');
const indexBtn = $('#index-one');
const dupWarn = $('#dup-warn');
const variantsLink = $('#to-variants');

let liked = false;

function readForm() {
  return {
    title: $('#title').value.trim(),
    script_outline: $('#script_outline').value,
    negative_prompt: $('#negative_prompt').value,
    platform: $('#platform').value,
    status: $('#status').value,
    niche: $('#niche').value.trim(),
    tags: $('#tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

function fill(idea) {
  $('#title').value = idea.title;
  $('#script_outline').value = idea.script_outline;
  $('#negative_prompt').value = idea.negative_prompt ?? '';
  $('#platform').value = idea.platform;
  $('#status').value = idea.status;
  $('#niche').value = idea.niche;
  $('#tags').value = idea.tags.join(', ');
  liked = idea.liked;
  likeBtn.textContent = liked ? '♥ Bỏ thích' : '♡ Thích';
  likeBtn.hidden = false;
  delBtn.hidden = false;
  $('#heading').textContent = idea.title;
  $('#sub').textContent = idea.indexed
    ? 'Đã nằm trong tìm kiếm ngữ nghĩa.'
    : 'Chưa index — bấm "Index ý tưởng này" khi bạn viết xong.';
  indexBtn.hidden = false;
  // Trang này không quản lý biến thể nữa, nên phải chỉ đường sang chỗ quản lý — bỏ
  // khối đi mà không để lối sang thì biến thể của ý tưởng này thành ngõ cụt.
  variantsLink.href = `/variants?idea=${encodeURIComponent(id)}`;
  variantsLink.hidden = false;
  // Form đã mang dữ liệu thật — giờ mới cho bấm Lưu (xem chú thích ở nút Lưu bên dưới).
  saveBtn.disabled = false;
  // Đã sạch thì vẫn bấm được, chỉ là không có việc gì để làm. Ghi rõ trên nhãn thay
  // vì vô hiệu hoá nút: nút chết mà không nói lý do là kiểu tệ nhất.
  indexBtn.textContent = idea.indexed ? 'Index lại ý tưởng này' : 'Index ý tưởng này';

  if (idea.source_idea_id) {
    $('#sub').textContent += ' Ý tưởng này được tạo bằng chức năng kết hợp.';
  }
}

/** Cảnh báo trùng — có liên kết đi tới từng ý tưởng để người dùng tự so. */
function showDuplicates(list) {
  if (!list || list.length === 0) {
    dupWarn.hidden = true;
    dupWarn.textContent = '';
    return;
  }
  const items = list
    .map((d) => `<li><a href="/idea?id=${encodeURIComponent(d.id)}">${esc(d.title)}</a>`
      + ` <span class="muted small">(giống ${(d.score * 100).toFixed(0)}%)</span></li>`)
    .join('');
  dupWarn.innerHTML =
    `<strong>Có thể đã có ý tưởng tương tự:</strong><ul>${items}</ul>`
    + '<p class="muted small">Ý tưởng vẫn được index bình thường — đây chỉ là cảnh báo.'
    + ' Hai ý tưởng index cách nhau dưới một phút có thể chưa thấy nhau, vì Vectorize'
    + ' mất khoảng chừng đó mới truy vấn được vector vừa ghi.</p>';
  dupWarn.hidden = false;
}

// Ý tưởng tương tự lấy từ vector đã lưu, nhưng một ý tưởng đã sửa sau lần index gần
// nhất vẫn hiện ra ở đây kèm chip "chưa index" — nên nút Index vẫn phải chạy.
bindIndexButtons($('#similar'), { onMessage: (text, kind) => show(msg, text, kind) });

async function loadSimilar() {
  try {
    const data = await get(`/api/ideas/${encodeURIComponent(id)}/similar?limit=5`);
    if (data.mode !== 'vector' || data.items.length === 0) return;
    $('#similar-wrap').hidden = false;
    renderList($('#similar'), data.items, '');
  } catch {
    // Gợi ý tương tự là phần thêm; hỏng thì im lặng bỏ qua.
  }
}

// enable chỉ khi là ý tưởng mới: ý tưởng đã có thì nút Lưu mở trong fill(), tức là sau
// khi form đã mang dữ liệu THẬT. Bấm Lưu trên một form còn rỗng sẽ ghi đè ý tưởng bằng
// đúng cái rỗng đó; nạp hỏng thì nút ở lại khoá và thông báo lỗi nói vì sao.
bindSubmit($('#f'), saveBtn, async () => {
  show(msg, '');
  const body = readForm();
  if (!body.title) {
    show(msg, 'Tiêu đề không được để trống.');
    return;
  }
  saveBtn.disabled = true;
  saveBtn.textContent = 'Đang lưu…';
  try {
    const res = isNew
      ? await post('/api/ideas', body)
      : await patch(`/api/ideas/${encodeURIComponent(id)}`, body);
    if (isNew) {
      location.replace(`/idea?id=${encodeURIComponent(res.idea.id)}&created=1`);
      return;
    }
    fill(res.idea);
    // Lưu ý tưởng cố ý CHỈ ghi D1 — không nhúng, không đụng Vectorize. Nói đúng
    // điều đó thay vì để người dùng tưởng tìm kiếm ngữ nghĩa đã cập nhật theo.
    show(msg, res.indexed ? SAVED_INDEXED_MSG : SAVED_MSG, res.indexed ? 'ok' : 'note');
  } catch (err) {
    show(msg, err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Lưu';
  }
}, { enable: isNew });

if (!isNew) {
  indexBtn.addEventListener('click', async () => {
    indexBtn.disabled = true;
    const label = indexBtn.textContent;
    indexBtn.textContent = 'Đang index…';
    showDuplicates([]);
    try {
      const res = await post(`/api/ideas/${encodeURIComponent(id)}/index`);
      fill(res.idea);
      showDuplicates(res.duplicates);
      show(msg, res.indexed
        ? 'Đã index. Tìm kiếm ngữ nghĩa thấy được sau khoảng một phút nữa.'
        : 'Index chưa xong — ý tưởng vẫn ở trạng thái chưa đồng bộ. Thử lại sau.',
        res.indexed ? 'ok' : 'note');
    } catch (err) {
      show(msg, err.message);
      indexBtn.textContent = label;
    } finally {
      indexBtn.disabled = false;
    }
  });
}

likeBtn.addEventListener('click', async () => {
  likeBtn.disabled = true;
  try {
    const path = `/api/ideas/${encodeURIComponent(id)}/like`;
    if (liked) await del(path);
    else await post(path);
    liked = !liked;
    likeBtn.textContent = liked ? '♥ Bỏ thích' : '♡ Thích';
  } catch (err) {
    show(msg, err.message);
  } finally {
    likeBtn.disabled = false;
  }
});

delBtn.addEventListener('click', async () => {
  if (!confirm('Xoá ý tưởng này? Không khôi phục lại được.')) return;
  delBtn.disabled = true;
  try {
    await del(`/api/ideas/${encodeURIComponent(id)}`);
    location.replace('/app');
  } catch (err) {
    show(msg, err.message);
    delBtn.disabled = false;
  }
});

// --- Nạp dữ liệu ------------------------------------------------------------
//
// PHẢI nằm CUỐI CÙNG, sau khi mọi trình xử lý ở trên đã gắn xong. Đây là lần `await`
// đầu tiên của module, và trước nó không được có cái nào khác.
//
// Lý do là một lỗi thật đã gặp: form ý tưởng gốc hiện ra ngay từ HTML tĩnh, nhưng
// trình xử lý `submit` của nó lại gắn SAU mấy lời gọi mạng này. Bấm "Lưu" (hoặc gõ
// Enter trong một ô văn bản) trong khoảng chờ đó thì trình duyệt submit form theo kiểu
// HTML thuần: điều hướng GET về chính trang này với query dựng từ các ô nhập. Không ô
// nào có thuộc tính `name`, nên query ra RỖNG — `?id=…` biến mất, `isNew` thành true,
// và trang nạp lại thành "Ý tưởng mới": form trắng, mất tiêu đề, mất khối nguồn gốc,
// không một thông báo lỗi nào. Trên máy local lời gọi xong trong vài chục mili giây
// nên gần như không bao giờ dính; trên production thì cửa sổ đó đủ rộng.
//
// Gắn trình xử lý trước rồi mới `await` là cách đóng cửa sổ đó. Nút Lưu để `disabled`
// sẵn trong HTML và chỉ được mở khi trình xử lý đã gắn là lớp chắn thứ hai, cho khoảng
// trống còn lại giữa lúc trình duyệt dựng xong HTML và lúc module bắt đầu chạy.

// Hỏng cũng không giết cả trang — xem chú thích của mountNavSafe trong nav.js.
await mountNavSafe('/app');

if (!isNew) {
  try {
    const { idea } = await get(`/api/ideas/${encodeURIComponent(id)}`);
    fill(idea);
    // Thông báo "vừa tạo xong" phải phản ánh trạng thái THẬT sau khi đã đọc lại
    // bản ghi, chứ không phải giả định lạc quan — ý tưởng chưa index sẽ không
    // xuất hiện trong tìm kiếm ngữ nghĩa, và người dùng cần biết ngay.
    if (new URLSearchParams(location.search).get('created') === '1') {
      show(msg, CREATED_MSG, 'ok');
    }
    void loadSimilar();
  } catch (err) {
    show(msg, err.message);
  }
}
