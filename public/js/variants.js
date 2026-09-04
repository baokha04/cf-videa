import { del, get, patch, post } from './api.js';
import { $, bindSubmit, esc, show } from './ui.js';
import { mountNavSafe } from './nav.js';

const listEl = $('#list');
const msgEl = $('#msg');
const moreBtn = $('#more');
const scopeEl = $('#scope');
const vmsg = $('#vmsg');

// null = đang ở chế độ thêm mới; có giá trị = đang sửa biến thể đó.
let editingId = null;

let cursor = null;
let items = [];
// Lọc theo một ý tưởng gốc. Cố ý KHÔNG làm ô chọn đổ sẵn danh sách ý tưởng: API phân
// trang tối đa 50 nên một ô như vậy sẽ âm thầm cụt khi người dùng có nhiều ý tưởng hơn.
// Bấm chip ý tưởng trên thẻ là cách vào đây, và luôn đúng với dữ liệu đang có.
// Bộ lọc theo ý tưởng gốc đọc thẳng từ URL: chip trên thẻ là một liên kết thật, nên
// trạng thái lọc chia sẻ được, tải lại được, và nút Back của trình duyệt chạy đúng.
const ideaFilter = new URLSearchParams(location.search).get('idea');

/**
 * Đổ ô chọn ý tưởng gốc. Dùng /api/ideas/titles chứ không phải /api/ideas: cái sau
 * phân trang tối đa 50 nên ô chọn sẽ âm thầm thiếu ý tưởng.
 */
async function loadIdeaOptions() {
  const sel = $('#videa');
  try {
    const { ideas, truncated, limit } = await get('/api/ideas/titles');
    const keep = sel.value;
    sel.innerHTML = ideas.length
      ? ideas.map((i) => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')
      : '<option value="">— Chưa có ý tưởng gốc nào —</option>';
    // Ưu tiên giữ lựa chọn cũ; nếu chưa chọn gì mà đang lọc theo một ý tưởng thì
    // mặc định vào chính ý tưởng đó — gần như luôn là thứ người dùng đang muốn thêm.
    const want = keep || ideaFilter;
    if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;

    const note = $('#videa-note');
    note.hidden = !truncated;
    if (truncated) {
      note.textContent =
        `Chỉ hiện ${limit} ý tưởng gần đây nhất. Muốn thêm biến thể cho ý tưởng cũ hơn `
        + 'thì mở thẳng ý tưởng đó rồi thêm từ trang của nó.';
    }
    return ideas.length > 0;
  } catch (err) {
    show(vmsg, `Không tải được danh sách ý tưởng gốc: ${err.message}`);
    return false;
  }
}

function resetForm() {
  editingId = null;
  $('#vtitle').value = '';
  $('#vangle').value = '';
  $('#vscript').value = '';
  $('#videa').disabled = false;
  $('#vsave').textContent = 'Thêm biến thể';
  $('#vcancel').hidden = true;
}

function query(withCursor) {
  const p = new URLSearchParams();
  const q = $('#q').value.trim();
  if (q) p.set('q', q);
  if (ideaFilter) p.set('idea', ideaFilter);
  p.set('limit', '20');
  if (withCursor && cursor) p.set('cursor', cursor);
  return `/api/variants?${p.toString()}`;
}

function card(v) {
  const script = v.script_outline.trim() ? 'dàn ý riêng' : 'dùng dàn ý gốc';
  const pending = v.indexed
    ? ''
    : '<span class="chip pending" title="Chưa nằm trong tìm kiếm ngữ nghĩa">chưa index</span>';
  return `<article class="card variant">
    <h3><a href="/idea?id=${encodeURIComponent(v.idea_id)}">${esc(v.title)}</a></h3>
    ${v.angle ? `<p class="hook">${esc(v.angle)}</p>` : ''}
    <div class="meta">
      <a class="chip" href="/variants?idea=${encodeURIComponent(v.idea_id)}"
         title="Chỉ xem biến thể của ý tưởng này">${esc(v.idea_title)}</a>
      <span class="chip">${script}</span>
      ${pending}
      <button class="link" type="button" data-index="${esc(v.id)}">Index</button>
      <button class="link" type="button" data-edit="${esc(v.id)}">Sửa</button>
      <button class="link" type="button" data-del="${esc(v.id)}">Xoá</button>
    </div>
  </article>`;
}

function renderScope() {
  if (!ideaFilter) {
    scopeEl.hidden = true;
    return;
  }
  const known = items.find((v) => v.idea_id === ideaFilter);
  scopeEl.innerHTML =
    `Đang lọc theo ý tưởng <strong>${esc(known ? known.idea_title : ideaFilter)}</strong>. `
    + '<a href="/variants">Bỏ lọc</a>';
  scopeEl.hidden = false;
}

async function load(append = false) {
  try {
    const data = await get(query(append));
    items = append ? items.concat(data.variants) : data.variants;
    cursor = data.next_cursor;
    listEl.innerHTML = items.length
      ? items.map(card).join('')
      : '<p class="empty">Chưa có biến thể nào khớp. Thêm biến thể ở trang một ý tưởng gốc.</p>';
    moreBtn.hidden = !cursor;
    renderScope();
  } catch (err) {
    show(msgEl, err.message);
  }
}

bindSubmit($('#vform'), $('#vsave'), async () => {
  const body = {
    title: $('#vtitle').value.trim(),
    angle: $('#vangle').value.trim(),
    script_outline: $('#vscript').value,
  };
  if (!body.title) {
    show(vmsg, 'Tên biến thể không được để trống.');
    return;
  }
  const ideaId = $('#videa').value;
  if (!editingId && !ideaId) {
    show(vmsg, 'Hãy chọn ý tưởng gốc cho biến thể này.');
    return;
  }

  $('#vsave').disabled = true;
  try {
    if (editingId) {
      // Cố ý KHÔNG gửi idea_id: API không cho chuyển biến thể sang ý tưởng khác, và
      // gửi một trường bị bỏ qua thì người dùng tưởng mình vừa chuyển được.
      await patch(`/api/variants/${encodeURIComponent(editingId)}`, body);
      show(vmsg, 'Đã lưu. Bấm "Index" trên thẻ để nó vào tìm kiếm.', 'note');
    } else {
      await post(`/api/ideas/${encodeURIComponent(ideaId)}/variants`, body);
      show(vmsg, 'Đã thêm biến thể. Bấm "Index" trên thẻ để nó vào tìm kiếm.', 'note');
    }
    resetForm();
    cursor = null;
    await loadIdeaOptions();
await load(false);
  } catch (err) {
    show(vmsg, err.message);
  } finally {
    $('#vsave').disabled = false;
  }
});

$('#vcancel').addEventListener('click', () => {
  resetForm();
  show(vmsg, '');
});

bindSubmit($('#filters'), $('#vfilter-go'), () => {
  cursor = null;
  load(false);
});

moreBtn.addEventListener('click', () => load(true));

listEl.addEventListener('click', async (e) => {
  const editId = e.target?.dataset?.edit;
  if (editId) {
    const v = items.find((x) => x.id === editId);
    if (!v) return;
    editingId = v.id;
    $('#vtitle').value = v.title;
    $('#vangle').value = v.angle;
    $('#vscript').value = v.script_outline;
    // Ý tưởng cha không đổi được: API không hỗ trợ chuyển biến thể sang ý tưởng khác.
    // Vẫn hiện đúng ý tưởng hiện tại, nhưng khoá lại thay vì để người dùng đổi hụt.
    if ([...$('#videa').options].some((o) => o.value === v.idea_id)) $('#videa').value = v.idea_id;
    $('#videa').disabled = true;
    $('#vsave').textContent = 'Lưu thay đổi';
    $('#vcancel').hidden = false;
    show(vmsg, `Đang sửa "${v.title}". Ý tưởng gốc không đổi được ở đây.`, 'note');
    $('#vtitle').focus();
    $('#vtitle').scrollIntoView({ block: 'center' });
    return;
  }

  const indexId = e.target?.dataset?.index;
  if (indexId) {
    e.target.disabled = true;
    e.target.textContent = '…';
    try {
      const r = await post(`/api/variants/${encodeURIComponent(indexId)}/index`);
      show(msgEl, r.indexed
        ? 'Đã index biến thể. Tìm được sau khoảng một phút nữa.'
        : 'Index chưa xong, thử lại sau.', r.indexed ? 'ok' : 'note');
    } catch (err) {
      show(msgEl, err.message);
    }
    cursor = null;
    await loadIdeaOptions();
await load(false);
    return;
  }

  const delId = e.target?.dataset?.del;
  if (delId) {
    if (!confirm('Xoá biến thể này? Ý tưởng gốc vẫn được giữ nguyên.')) return;
    try {
      await del(`/api/variants/${encodeURIComponent(delId)}`);
      // Đang sửa đúng cái vừa xoá thì phải thoát chế độ sửa, nếu không lần bấm Lưu
      // kế tiếp sẽ ném 404 mà người dùng không hiểu vì sao.
      if (editingId === delId) resetForm();
      show(msgEl, 'Đã xoá biến thể.', 'ok');
    } catch (err) {
      show(msgEl, err.message);
    }
    cursor = null;
    await loadIdeaOptions();
await load(false);
  }
});

await loadIdeaOptions();
await load(false);

// Thanh điều hướng dựng SAU CÙNG, sau khi mọi trình xử lý ở trên đã gắn.
//
// Trước đây nó là `await mountNav(...)` ở dòng đầu module. Hai hệ quả, cả hai đều đã
// gặp thật: mountNav ném một cái là cả trang chết câm, và trong lúc nó còn đang chờ
// mạng thì các form đã hiện mà chưa có trình xử lý — bấm Lưu hay gõ Enter sẽ submit
// theo kiểu HTML thuần, điều hướng GET làm mất luôn tham số trên URL.
await mountNavSafe('/variants');
