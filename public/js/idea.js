import { del, get, patch, post } from './api.js';
import { $, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/app');

// Ba thông báo, gom lại một chỗ để chúng không lệch nhau khi sửa.
const SAVED_MSG =
  'Đã lưu vào cơ sở dữ liệu. Ý tưởng chưa nằm trong tìm kiếm ngữ nghĩa — '
  + 'bấm "Đồng bộ index" ở trang kho ý tưởng khi bạn viết xong.';
const SAVED_INDEXED_MSG = 'Đã lưu. Ý tưởng vẫn đang khớp với tìm kiếm ngữ nghĩa.';
const CREATED_MSG =
  'Đã tạo ý tưởng và lưu vào cơ sở dữ liệu. Nhớ bấm "Đồng bộ index" ở trang kho ý '
  + 'tưởng để nó xuất hiện trong tìm kiếm ngữ nghĩa.';

const id = new URLSearchParams(location.search).get('id');
const isNew = !id;
const msg = $('#msg');
const saveBtn = $('#save');
const likeBtn = $('#like');
const delBtn = $('#del');

let liked = false;

function readForm() {
  return {
    title: $('#title').value.trim(),
    hook: $('#hook').value.trim(),
    script_outline: $('#script_outline').value,
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
  $('#hook').value = idea.hook;
  $('#script_outline').value = idea.script_outline;
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
    : 'Chưa index — bấm "Đồng bộ index" ở trang kho ý tưởng khi bạn viết xong.';
}

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

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
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
});

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
