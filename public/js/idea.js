import { del, get, patch, post } from './api.js';
import { $, bindIndexButtons, esc, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/app');

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

let liked = false;
// Khai báo Ở ĐÂY chứ không phải cạnh các hàm dùng chúng: `let` nằm trong vùng chết
// tạm thời cho tới khi dòng khai báo được chạy, nên đặt sau đoạn nạp trang thì
// loadVariants() sẽ ném ReferenceError ngay lần chạy đầu — và vì lời gọi đó nằm
// trong try/catch, lỗi bị nuốt và các bước sau đó âm thầm không chạy.
let variants = [];
let editingVariant = null;

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
  $('#pidea').value = idea.title;
  $('#sub').textContent = idea.indexed
    ? 'Đã nằm trong tìm kiếm ngữ nghĩa.'
    : 'Chưa index — bấm "Index ý tưởng này" khi bạn viết xong.';
  indexBtn.hidden = false;
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
    $('#variants-wrap').hidden = false;
    $('#prompt-wrap').hidden = false;
    await loadVariants();
    await loadHooks();
    void loadSimilar();
  } catch (err) {
    show(msg, err.message);
  }
}

// --- Biến thể --------------------------------------------------------------

// Biến thể nay có vector RIÊNG, nên có trạng thái index riêng. Cờ `indexed` do server
// tính (routes/variants.ts) — giao diện không dựng lại phép so hash.
function variantCard(v) {
  return `<article class="card variant">
    <h3>${esc(v.title)}</h3>
    ${v.angle ? `<p class="hook">${esc(v.angle)}</p>` : ''}
    <div class="meta">
      <span class="chip">${v.script_outline.trim() ? 'dàn ý riêng' : 'dùng dàn ý gốc'}</span>
      ${v.indexed ? '' : '<span class="chip pending" title="Chưa nằm trong tìm kiếm ngữ nghĩa">chưa index</span>'}
      <button class="link" type="button" data-vindex="${esc(v.id)}">Index</button>
      <button class="link" type="button" data-vedit="${esc(v.id)}">Sửa</button>
      <button class="link" type="button" data-vdel="${esc(v.id)}">Xoá</button>
    </div>
  </article>`;
}

async function loadVariants() {
  const data = await get(`/api/ideas/${encodeURIComponent(id)}/variants`);
  variants = data.variants;
  $('#variants').innerHTML = variants.length
    ? variants.map(variantCard).join('')
    : '<p class="empty">Chưa có biến thể nào. Thêm biến thể đầu tiên ở trên.</p>';

  const sel = $('#pvariant');
  const keep = sel.value;
  sel.innerHTML = variants.map((v) => `<option value="${esc(v.id)}">${esc(v.title)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  // Không có biến thể thì không ghép được prompt — nói rõ thay vì để nút chết câm.
  $('#pgen').disabled = variants.length === 0;
  $('#psave').disabled = variants.length === 0;
  show($('#pmsg'), variants.length ? '' : 'Thêm ít nhất một biến thể để kết hợp.',
       variants.length ? 'ok' : 'note');
}

async function loadHooks() {
  try {
    const [{ hooks }, { categories }] = await Promise.all([
      get('/api/hooks'),
      get('/api/hook-categories'),
    ]);
    const nameOf = new Map(categories.map((c) => [c.id, c.name]));
    const sel = $('#phook');
    sel.innerHTML = '<option value="">— Không dùng hook —</option>'
      + hooks.map((h) => {
          const cat = nameOf.get(h.category_id) ?? 'Chưa phân loại';
          const short = h.text.length > 60 ? `${h.text.slice(0, 60)}…` : h.text;
          return `<option value="${esc(h.id)}">[${esc(cat)}] ${esc(short)}</option>`;
        }).join('');
  } catch (err) {
    // Vẫn tạo được prompt không hook, nhưng phải NÓI ra. Nuốt lỗi ở đây từng khiến
    // ô chọn hook rỗng mà không có dấu hiệu gì.
    show($('#pmsg'), `Không tải được thư viện hook: ${err.message}`, 'note');
  }
}

function resetVariantForm() {
  editingVariant = null;
  $('#vtitle').value = '';
  $('#vangle').value = '';
  $('#vscript').value = '';
  $('#vsave').textContent = 'Thêm biến thể';
  $('#vcancel').hidden = true;
}

if (!isNew) {
  $('#vform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: $('#vtitle').value.trim(),
      angle: $('#vangle').value.trim(),
      script_outline: $('#vscript').value,
    };
    if (!body.title) {
      show($('#vmsg'), 'Tên biến thể không được để trống.');
      return;
    }
    try {
      if (editingVariant) {
        await patch(`/api/variants/${encodeURIComponent(editingVariant)}`, body);
      } else {
        await post(`/api/ideas/${encodeURIComponent(id)}/variants`, body);
      }
      resetVariantForm();
      await loadVariants();
      // Biến thể nằm trong văn bản đem đi nhúng, nên ý tưởng vừa trở lại "chưa đồng bộ".
      show($('#vmsg'), 'Đã lưu. Bấm "Index" trên thẻ biến thể để nó vào tìm kiếm.', 'note');
    } catch (err) {
      show($('#vmsg'), err.message);
    }
  });

  $('#vcancel').addEventListener('click', resetVariantForm);

  $('#variants').addEventListener('click', async (e) => {
    const editId = e.target?.dataset?.vedit;
    const delId = e.target?.dataset?.vdel;
    const indexId = e.target?.dataset?.vindex;
    if (indexId) {
      e.target.disabled = true;
      e.target.textContent = '…';
      try {
        const res = await post(`/api/variants/${encodeURIComponent(indexId)}/index`);
        await loadVariants();
        show($('#vmsg'), res.indexed
          ? 'Đã index biến thể. Tìm được sau khoảng một phút nữa.'
          : 'Index chưa xong, thử lại sau.', res.indexed ? 'ok' : 'note');
      } catch (err) {
        show($('#vmsg'), err.message);
        await loadVariants();
      }
      return;
    }
    if (editId) {
      const v = variants.find((x) => x.id === editId);
      if (!v) return;
      editingVariant = v.id;
      $('#vtitle').value = v.title;
      $('#vangle').value = v.angle;
      $('#vscript').value = v.script_outline;
      $('#vsave').textContent = 'Lưu biến thể';
      $('#vcancel').hidden = false;
      $('#vtitle').focus();
      return;
    }
    if (delId) {
      if (!confirm('Xoá biến thể này?')) return;
      try {
        await del(`/api/variants/${encodeURIComponent(delId)}`);
        resetVariantForm();
        await loadVariants();
      } catch (err) {
        show($('#vmsg'), err.message);
      }
    }
  });

  // --- Sinh prompt ---------------------------------------------------------

  $('#pgen').addEventListener('click', async () => {
    const vid = $('#pvariant').value;
    if (!vid) return;
    const hid = $('#phook').value;
    $('#pgen').disabled = true;
    try {
      const q = new URLSearchParams({ variant_id: vid });
      if (hid) q.set('hook_id', hid);
      const r = await get(`/api/prompt?${q.toString()}`);
      $('#pout').textContent = r.prompt;
      $('#pout').hidden = false;
      $('#pcopy').hidden = false;
      show($('#pmsg'), '');
    } catch (err) {
      show($('#pmsg'), err.message);
    } finally {
      $('#pgen').disabled = false;
    }
  });

  $('#psave').addEventListener('click', async () => {
    const vid = $('#pvariant').value;
    if (!vid) return;
    const hid = $('#phook').value;
    $('#psave').disabled = true;
    $('#psave').textContent = 'Đang lưu…';
    try {
      const res = await post('/api/ideas/combine', {
        idea_id: id,
        variant_id: vid,
        hook_id: hid || null,
      });
      // Đi thẳng sang ý tưởng vừa tạo: nó là một ý tưởng gốc đầy đủ, và việc kế tiếp
      // gần như luôn là bấm Index cho nó.
      location.assign(`/idea?id=${encodeURIComponent(res.idea.id)}&created=1`);
    } catch (err) {
      show($('#pmsg'), err.message);
      $('#psave').disabled = false;
      $('#psave').textContent = 'Lưu thành ý tưởng gốc';
    }
  });

  $('#pcopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#pout').textContent);
      show($('#pmsg'), 'Đã chép prompt vào clipboard.', 'ok');
    } catch {
      // clipboard cần ngữ cảnh bảo mật và quyền; hỏng thì bảo người dùng tự bôi đen.
      show($('#pmsg'), 'Trình duyệt không cho chép tự động — hãy bôi đen và chép tay.', 'note');
    }
  });
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
