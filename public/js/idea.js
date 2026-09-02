import { del, get, patch, post } from './api.js';
import { $, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/app');

// Ba thông báo, gom lại một chỗ để chúng không lệch nhau khi sửa.
const SAVED_MSG =
  'Đã lưu vào cơ sở dữ liệu. Ý tưởng chưa nằm trong tìm kiếm ngữ nghĩa — '
  + 'bấm "Đồng bộ index" ngay bên cạnh khi bạn viết xong.';
const SAVED_INDEXED_MSG = 'Đã lưu. Ý tưởng vẫn đang khớp với tìm kiếm ngữ nghĩa.';
const CREATED_MSG =
  'Đã tạo ý tưởng và lưu vào cơ sở dữ liệu. Nhớ bấm "Đồng bộ index" để nó xuất hiện '
  + 'trong tìm kiếm ngữ nghĩa.';

const id = new URLSearchParams(location.search).get('id');
const isNew = !id;
const msg = $('#msg');
const saveBtn = $('#save');
const syncBtn = $('#sync');
const likeBtn = $('#like');
const delBtn = $('#del');
const variantBtn = $('#new-variant');

let liked = false;
let kind = 'origin';

function readForm() {
  return {
    title: $('#title').value.trim(),
    hook: $('#hook').value.trim(),
    script_outline: $('#script_outline').value,
    source_idea: $('#source_idea').value,
    prompt_recipe: $('#prompt_recipe').value,
    negative_prompt: $('#negative_prompt').value,
    platform: $('#platform').value,
    status: $('#status').value,
    niche: $('#niche').value.trim(),
    tags: $('#tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    // Mỗi dòng một hook. Ô nhiều dòng thay vì danh sách nút thêm/xoá: người ta chép
    // cả nắm hook từ nơi khác về, và dán một lần vẫn nhanh hơn bấm mười lần.
    hooks: $('#hooks')
      .value.split('\n')
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

function fill(idea) {
  $('#title').value = idea.title;
  $('#hook').value = idea.hook;
  $('#script_outline').value = idea.script_outline;
  $('#source_idea').value = idea.source_idea;
  $('#prompt_recipe').value = idea.prompt_recipe;
  $('#negative_prompt').value = idea.negative_prompt;
  $('#platform').value = idea.platform;
  $('#status').value = idea.status;
  $('#niche').value = idea.niche;
  $('#tags').value = idea.tags.join(', ');
  $('#hooks').value = idea.hooks.join('\n');
  liked = idea.liked;
  kind = idea.kind;
  likeBtn.textContent = liked ? '♥ Bỏ thích' : '♡ Thích';
  likeBtn.hidden = false;
  delBtn.hidden = false;
  syncBtn.hidden = false;
  syncBtn.textContent = idea.indexed ? 'Đồng bộ lại' : 'Đồng bộ index';
  $('#heading').textContent = idea.title;
  $('#sub').textContent = idea.indexed
    ? 'Đã nằm trong tìm kiếm ngữ nghĩa.'
    : 'Chưa index — bấm "Đồng bộ index" khi bạn viết xong.';

  // Biến thể trỏ ngược về ý tưởng gốc của nó, và KHÔNG có danh mục biến thể riêng:
  // cây đúng một tầng, nên hiện một mục rỗng không bao giờ có gì chỉ gây hiểu nhầm.
  const parentOf = $('#parent-of');
  if (idea.kind === 'variant' && idea.parent_id) {
    $('#parent-link').href = `/idea?id=${encodeURIComponent(idea.parent_id)}`;
    parentOf.hidden = false;
  } else {
    parentOf.hidden = true;
  }
  $('#variants-wrap').hidden = idea.kind !== 'origin';
  if (idea.kind === 'origin') void loadVariants();
}

/**
 * Đồng bộ index cho một thẻ trong danh sách (dùng chung cho danh mục biến thể).
 * Trả về true nếu sự kiện này là của một nút đồng bộ và đã được xử lý.
 */
async function handleCardSync(e) {
  const btn = e.target.closest('button.sync-one');
  if (!btn || !btn.dataset.id) return false;
  const original = btn.textContent.trim();
  btn.disabled = true;
  btn.textContent = 'Đang đồng bộ…';
  show(msg, '');
  try {
    const r = await post(`/api/ideas/${encodeURIComponent(btn.dataset.id)}/reindex`);
    show(
      msg,
      r.outcome === 'failed'
        ? 'Đồng bộ biến thể này không thành công. Thử lại sau ít phút.'
        : r.outcome === 'clean'
          ? 'Biến thể này vốn đã khớp với tìm kiếm ngữ nghĩa.'
          : 'Đã đồng bộ. Tìm kiếm ngữ nghĩa sẽ thấy nó sau khoảng một phút.',
      r.outcome === 'failed' ? 'error' : 'ok',
    );
    await loadVariants();
  } catch (err) {
    show(msg, err.message);
    btn.disabled = false;
    btn.textContent = original;
  }
  return true;
}

// Uỷ quyền sự kiện trên cả danh sách: danh mục được render lại bằng innerHTML sau
// mỗi lần đồng bộ, nên handler gắn thẳng vào nút sẽ biến mất cùng DOM cũ.
$('#variants').addEventListener('click', (e) => {
  void handleCardSync(e);
});

/** Danh mục ý tưởng biến thể của ý tưởng gốc đang mở. */
async function loadVariants() {
  try {
    const { items } = await get(`/api/ideas/${encodeURIComponent(id)}/variants`);
    $('#variants-sub').textContent = items.length
      ? `${items.length} biến thể mọc ra từ ý tưởng gốc này.`
      : 'Chưa có biến thể nào. Tạo một bản để thử cách kể khác.';
    renderList($('#variants'), items, '', { sync: true });
  } catch (err) {
    show(msg, err.message);
  }
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

/**
 * Nút đồng bộ index của RIÊNG ý tưởng này.
 *
 * Có nút cho cả kho ở trang danh sách rồi, nhưng ở đây người dùng vừa sửa xong đúng
 * một ý tưởng — bắt họ quay về trang kho rồi đồng bộ tất cả chỉ để đẩy một hàng lên
 * là bắt trả giá cho việc mình không làm.
 */
syncBtn.addEventListener('click', async () => {
  if (!id) return;
  syncBtn.disabled = true;
  const original = syncBtn.textContent;
  syncBtn.textContent = 'Đang đồng bộ…';
  show(msg, '');
  try {
    const r = await post(`/api/ideas/${encodeURIComponent(id)}/reindex`);
    if (r.outcome === 'failed') {
      show(msg, 'Đồng bộ không thành công. Thử lại sau ít phút.');
    } else if (r.outcome === 'clean') {
      show(msg, 'Ý tưởng này vốn đã khớp với tìm kiếm ngữ nghĩa.', 'ok');
    } else {
      // Vector vừa ghi mất khoảng một phút mới truy vấn được.
      show(
        msg,
        'Đã đồng bộ. Tìm kiếm ngữ nghĩa sẽ thấy ý tưởng này sau khoảng một phút.',
        'ok',
      );
    }
    const { idea } = await get(`/api/ideas/${encodeURIComponent(id)}`);
    fill(idea);
  } catch (err) {
    show(msg, err.message);
  } finally {
    syncBtn.disabled = false;
    if (syncBtn.textContent === 'Đang đồng bộ…') syncBtn.textContent = original;
  }
});

variantBtn.addEventListener('click', async () => {
  if (!id || kind !== 'origin') return;
  variantBtn.disabled = true;
  show(msg, '');
  try {
    // Server tự chép nguyên liệu của bản gốc sang (ý tưởng gốc, công thức prompt,
    // negative prompt, niche, nền tảng, tag) — client không dựng lại logic đó.
    const res = await post(`/api/ideas/${encodeURIComponent(id)}/variants`);
    location.href = `/idea?id=${encodeURIComponent(res.idea.id)}&created=1`;
  } catch (err) {
    show(msg, err.message);
    variantBtn.disabled = false;
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
