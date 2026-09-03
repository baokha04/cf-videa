import { del, get, patch, post } from './api.js';
import { $, esc, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/hooks');

const catsEl = $('#cats');
const listEl = $('#list');
let categories = [];
let editingId = null;

/** Đổ danh mục vào cả ba ô chọn — giữ nguyên giá trị đang chọn nếu còn hợp lệ. */
function fillSelects() {
  for (const [sel, extra] of [[$('#hcat'), null], [$('#filter'), 'none']]) {
    const keep = sel.value;
    sel.innerHTML = sel === $('#filter')
      ? '<option value="">Tất cả</option>'
      : '<option value="">Chưa phân loại</option>';
    if (extra === 'none') {
      sel.insertAdjacentHTML('beforeend', '<option value="none">Chưa phân loại</option>');
    }
    for (const c of categories) {
      sel.insertAdjacentHTML('beforeend',
        `<option value="${esc(c.id)}">${esc(c.name)}</option>`);
    }
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
}

async function loadCategories() {
  const data = await get('/api/hook-categories');
  categories = data.categories;
  catsEl.innerHTML = [
    ...categories.map((c) => `<span class="chip cat">${esc(c.name)} · ${c.count}
      <button class="chip-x" type="button" data-delcat="${esc(c.id)}"
              aria-label="Xoá danh mục ${esc(c.name)}">×</button></span>`),
    `<span class="chip">Chưa phân loại · ${data.uncategorized}</span>`,
  ].join('');
  fillSelects();
}

function hookCard(h) {
  const cat = categories.find((c) => c.id === h.category_id);
  return `<article class="card hook">
    <p class="hook-text">${esc(h.text)}</p>
    <div class="meta">
      <span class="chip">${esc(cat ? cat.name : 'Chưa phân loại')}</span>
      ${h.note ? `<span class="chip">${esc(h.note)}</span>` : ''}
      <button class="link" type="button" data-edit="${esc(h.id)}">Sửa</button>
      <button class="link" type="button" data-del="${esc(h.id)}">Xoá</button>
    </div>
  </article>`;
}

async function loadHooks() {
  const f = $('#filter').value;
  const q = f ? `?category=${encodeURIComponent(f)}` : '';
  const { hooks } = await get(`/api/hooks${q}`);
  listEl.innerHTML = hooks.length
    ? hooks.map(hookCard).join('')
    : '<p class="empty">Chưa có hook nào. Thêm hook đầu tiên ở trên.</p>';
}

$('#catform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#catname').value.trim();
  if (!name) return;
  try {
    await post('/api/hook-categories', { name });
    $('#catname').value = '';
    show($('#catmsg'), '');
    await loadCategories();
  } catch (err) {
    show($('#catmsg'), err.message);
  }
});

catsEl.addEventListener('click', async (e) => {
  const id = e.target?.dataset?.delcat;
  if (!id) return;
  if (!confirm('Xoá danh mục này? Hook bên trong được giữ lại và chuyển về "Chưa phân loại".')) return;
  try {
    await del(`/api/hook-categories/${encodeURIComponent(id)}`);
    await loadCategories();
    await loadHooks();
  } catch (err) {
    show($('#catmsg'), err.message);
  }
});

function resetForm() {
  editingId = null;
  $('#hookform').reset();
  $('#hsave').textContent = 'Thêm hook';
  $('#hcancel').hidden = true;
  fillSelects();
}

$('#hookform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    text: $('#htext').value.trim(),
    note: $('#hnote').value.trim(),
    category_id: $('#hcat').value || null,
  };
  if (!body.text) return;
  try {
    if (editingId) await patch(`/api/hooks/${encodeURIComponent(editingId)}`, body);
    else await post('/api/hooks', body);
    show($('#hookmsg'), editingId ? 'Đã cập nhật hook.' : 'Đã thêm hook.', 'ok');
    resetForm();
    await loadCategories();
    await loadHooks();
  } catch (err) {
    show($('#hookmsg'), err.message);
  }
});

$('#hcancel').addEventListener('click', resetForm);

listEl.addEventListener('click', async (e) => {
  const editId = e.target?.dataset?.edit;
  const delId = e.target?.dataset?.del;
  if (editId) {
    const { hooks } = await get('/api/hooks');
    const h = hooks.find((x) => x.id === editId);
    if (!h) return;
    editingId = h.id;
    $('#htext').value = h.text;
    $('#hnote').value = h.note;
    $('#hcat').value = h.category_id ?? '';
    $('#hsave').textContent = 'Lưu thay đổi';
    $('#hcancel').hidden = false;
    $('#htext').focus();
    return;
  }
  if (delId) {
    if (!confirm('Xoá hook này?')) return;
    try {
      await del(`/api/hooks/${encodeURIComponent(delId)}`);
      await loadCategories();
      await loadHooks();
    } catch (err) {
      show($('#hookmsg'), err.message);
    }
  }
});

$('#filter').addEventListener('change', loadHooks);

await loadCategories();
await loadHooks();
