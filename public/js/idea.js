import { del, get, patch, post } from './api.js';
import { $, esc, renderList, show } from './ui.js';
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
const hookList = $('#hook-list');
const hookNew = $('#hook-new');

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
    // Danh mục hook CỐ Ý không nằm trong form này. Nó có endpoint riêng cho từng
    // mục (xem loadHooks bên dưới), nên gửi kèm ở đây sẽ là nguồn sự thật thứ hai
    // và lần bấm "Lưu" sẽ ghi đè mất những gì vừa sửa trong danh mục.
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
  liked = idea.liked;
  kind = idea.kind;
  likeBtn.textContent = liked ? '♥ Bỏ thích' : '♡ Thích';
  likeBtn.hidden = false;
  delBtn.hidden = false;
  syncBtn.hidden = false;
  $('#heading').textContent = idea.title;
  applyIndexState(idea);

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
  $('#hooks-wrap').hidden = false;
  void loadHooks();
}

/**
 * Nhãn nút đồng bộ và dòng phụ, tách riêng khỏi fill().
 *
 * Sửa danh mục hook làm ý tưởng "bẩn" trở lại, nhưng lúc đó KHÔNG được gọi fill():
 * fill() vẽ lại cả danh mục hook, nên nếu người dùng đang gõ dở ở một dòng khác thì
 * chữ vừa gõ biến mất. Đây là phần duy nhất cần cập nhật.
 */
function applyIndexState(idea) {
  syncBtn.textContent = idea.indexed ? 'Đồng bộ lại' : 'Đồng bộ index';
  $('#sub').textContent = idea.indexed
    ? 'Đã nằm trong tìm kiếm ngữ nghĩa.'
    : 'Chưa index — bấm "Đồng bộ index" khi bạn viết xong.';
}

/** Đọc lại trạng thái index sau một thay đổi ngoài form (thêm/sửa/xoá hook). */
async function refreshIndexState() {
  try {
    const { idea } = await get(`/api/ideas/${encodeURIComponent(id)}`);
    applyIndexState(idea);
  } catch {
    // Chỉ là nhãn trên nút; hỏng thì bỏ qua, không chặn thao tác vừa thành công.
  }
}

/** Một dòng trong danh mục hook. Mọi giá trị người dùng nhập đều qua esc(). */
function hookRow(h, i, total) {
  return `<div class="hook-row" data-id="${esc(h.id)}">
    <span class="hook-no">${i + 1}</span>
    <input class="hook-text" maxlength="500" value="${esc(h.text)}"
           aria-label="Nội dung hook ${i + 1}">
    <div class="hook-actions">
      <button type="button" data-act="up" aria-label="Đưa lên trên"
              ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" data-act="down" aria-label="Đưa xuống dưới"
              ${i === total - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" data-act="del" class="danger" aria-label="Xoá hook">Xoá</button>
    </div>
  </div>`;
}

function renderHooks(items) {
  $('#hooks-sub').textContent = items.length
    ? `${items.length} hook cho ý tưởng này.`
    : 'Chưa có hook nào. Thêm cách mở đầu đầu tiên bên dưới.';
  hookList.innerHTML = items
    .map((h, i) => hookRow(h, i, items.length))
    .join('');
}

async function loadHooks() {
  try {
    const { items } = await get(`/api/ideas/${encodeURIComponent(id)}/hooks`);
    renderHooks(items);
  } catch (err) {
    show(msg, err.message);
  }
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

/**
 * Xoá một biến thể ngay từ danh mục.
 *
 * Dùng chung endpoint DELETE /api/ideas/:id với nút Xoá ở trang ý tưởng, nên nó
 * cũng dọn vector trên Vectorize y hệt — không có đường xoá thứ hai nào bỏ sót
 * việc đó. Trả về true nếu sự kiện này là của một nút xoá và đã được xử lý.
 */
async function handleCardDelete(e) {
  const btn = e.target.closest('button.delete-one');
  if (!btn || !btn.dataset.id) return false;
  if (!confirm(`Xoá biến thể "${btn.dataset.title}"? Không khôi phục lại được.`)) return true;
  btn.disabled = true;
  show(msg, '');
  try {
    await del(`/api/ideas/${encodeURIComponent(btn.dataset.id)}`);
    show(msg, 'Đã xoá biến thể.', 'ok');
    await loadVariants();
  } catch (err) {
    show(msg, err.message);
    btn.disabled = false;
  }
  return true;
}

// Uỷ quyền sự kiện trên cả danh sách: danh mục được render lại bằng innerHTML sau
// mỗi lần đồng bộ hay xoá, nên handler gắn thẳng vào nút sẽ biến mất cùng DOM cũ.
$('#variants').addEventListener('click', async (e) => {
  if (await handleCardDelete(e)) return;
  await handleCardSync(e);
});

// ---------------------------------------------------------------------------
// Quản lý danh mục video hook
// ---------------------------------------------------------------------------

/**
 * Mỗi thao tác trên hook đều làm ý tưởng "bẩn" trở lại, vì hook nằm trong văn bản
 * đem đi nhúng. Nên sau mỗi lần ghi phải đọc lại trạng thái index — nếu không, nút
 * vẫn ghi "Đồng bộ lại" trong khi thực tế đã lệch, và người dùng tưởng mọi thứ đang
 * khớp với tìm kiếm ngữ nghĩa.
 */
async function afterHookChange(text, items) {
  if (items) renderHooks(items);
  else await loadHooks();
  await refreshIndexState();
  show(msg, text, 'ok');
}

hookList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.hook-row');
  if (!row) return;
  const hookId = row.dataset.id;
  const act = btn.dataset.act;

  if (act === 'del') {
    const text = row.querySelector('.hook-text').value.trim();
    if (!confirm(`Xoá hook "${text}"?`)) return;
  }

  // Khoá cả dòng chứ không riêng nút vừa bấm: bấm ↑ rồi bấm Xoá ngay lúc lệnh đầu
  // chưa xong sẽ thao tác trên một danh mục đã cũ.
  for (const b of row.querySelectorAll('button')) b.disabled = true;
  try {
    if (act === 'del') {
      await del(`/api/ideas/${encodeURIComponent(id)}/hooks/${encodeURIComponent(hookId)}`);
      await afterHookChange('Đã xoá hook.');
    } else {
      const r = await post(
        `/api/ideas/${encodeURIComponent(id)}/hooks/${encodeURIComponent(hookId)}/move`,
        { dir: act },
      );
      // moved = false nghĩa là đã ở đầu hoặc cuối danh mục: vẽ lại cho nút nhả ra,
      // nhưng không báo "đã lưu" vì thật sự không có gì đổi.
      if (r.moved) await afterHookChange('Đã đổi thứ tự hook.', r.items);
      else renderHooks(r.items);
    }
  } catch (err) {
    show(msg, err.message);
    await loadHooks();
  }
});

/**
 * Lưu khi người dùng bấm ra ngoài ô. Dùng sự kiện `change` (chỉ bắn khi giá trị
 * THỰC SỰ đổi) thay vì thêm một nút Lưu cho từng dòng: mỗi dòng đã có ba nút, thêm
 * nút thứ tư thì trên màn hình điện thoại không còn chỗ cho chính nội dung hook.
 */
hookList.addEventListener('change', async (e) => {
  const input = e.target.closest('.hook-text');
  if (!input) return;
  const row = input.closest('.hook-row');
  const text = input.value.trim();
  if (!text) {
    show(msg, 'Hook không được để trống. Muốn bỏ hẳn thì bấm Xoá.');
    await loadHooks();
    return;
  }
  input.disabled = true;
  try {
    const r = await patch(
      `/api/ideas/${encodeURIComponent(id)}/hooks/${encodeURIComponent(row.dataset.id)}`,
      { text },
    );
    await afterHookChange('Đã lưu hook.', r.items);
  } catch (err) {
    show(msg, err.message);
    await loadHooks();
  }
});

$('#hook-add').addEventListener('click', async () => {
  const text = hookNew.value.trim();
  if (!text) {
    show(msg, 'Nhập nội dung hook trước đã.');
    return;
  }
  $('#hook-add').disabled = true;
  try {
    await post(`/api/ideas/${encodeURIComponent(id)}/hooks`, { text });
    hookNew.value = '';
    await afterHookChange('Đã thêm hook.');
  } catch (err) {
    show(msg, err.message);
  } finally {
    $('#hook-add').disabled = false;
  }
});

// Enter trong ô thêm = bấm nút Thêm. Ô nằm ngoài <form> nên không có hành vi này sẵn.
hookNew.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#hook-add').click();
  }
});

/** Danh mục ý tưởng biến thể của ý tưởng gốc đang mở. */
async function loadVariants() {
  try {
    const { items } = await get(`/api/ideas/${encodeURIComponent(id)}/variants`);
    $('#variants-sub').textContent = items.length
      ? `${items.length} biến thể mọc ra từ ý tưởng gốc này.`
      : 'Chưa có biến thể nào. Tạo một bản để thử cách kể khác.';
    renderList($('#variants'), items, '', { sync: true, manage: true });
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
