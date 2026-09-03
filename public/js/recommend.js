import { get, post } from './api.js';
import { $, bindIndexButtons, esc, renderList, show } from './ui.js';
import { mountNav } from './nav.js';

await mountNav('/recommend');

const msg = $('#msg');
const cmsg = $('#cmsg');
const listEl = $('#list');

// Nút Index trên thẻ gợi ý. Gợi ý thường đến từ Vectorize nên đã index, nhưng nhánh
// cold_start đọc thẳng D1 và trả về được ý tưởng chưa index — nút vẫn có việc để làm.
bindIndexButtons(listEl, { onMessage: (text, kind) => show(msg, text, kind) });

// --- Danh sách gợi ý -------------------------------------------------------

try {
  const data = await get('/api/recommendations?limit=20');
  if (data.basis === 'cold_start') {
    show(
      msg,
      data.message || 'Hãy thích vài ý tưởng để gợi ý bám sát gu của bạn hơn.',
      'note',
    );
  } else {
    show(msg, `Dựa trên ${data.source_count} ý tưởng bạn đã thích.`, 'ok');
  }
  renderList(
    listEl,
    data.items,
    'Chưa có gì để gợi ý. Hãy thêm ý tưởng và thích vài cái bạn tâm đắc.',
  );
} catch (err) {
  show(msg, err.message);
  listEl.innerHTML = '';
}

// --- Kết hợp ---------------------------------------------------------------
//
// Dùng đúng POST /api/ideas/combine mà trang ý tưởng đang dùng; ở đây chỉ là một lối
// vào thứ hai. Ô chọn ý tưởng lấy TOÀN KHO qua /api/ideas/titles chứ không lấy từ danh
// sách gợi ý phía trên: gợi ý bị giới hạn 20 mục, còn thứ bạn muốn ghép vào có thể là
// bất kỳ ý tưởng nào.

const cidea = $('#cidea');
const cvariant = $('#cvariant');
const chook = $('#chook');

/** Bật/tắt cả hai nút cùng lúc, kèm lý do — nút chết câm là thứ tệ nhất. */
function setReady(ready, why) {
  $('#cgen').disabled = !ready;
  $('#csave').disabled = !ready;
  if (why) show(cmsg, why, 'note');
}

async function loadIdeaOptions() {
  try {
    const { ideas, truncated, limit } = await get('/api/ideas/titles');
    cidea.innerHTML = ideas.length
      ? ideas.map((i) => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')
      : '<option value="">— Chưa có ý tưởng gốc nào —</option>';

    const note = $('#cidea-note');
    note.hidden = !truncated;
    if (truncated) {
      note.textContent =
        `Chỉ hiện ${limit} ý tưởng gần đây nhất. Muốn ghép từ ý tưởng cũ hơn thì mở thẳng `
        + 'ý tưởng đó và dùng khối Kết hợp ở trang của nó.';
    }
    return ideas.length > 0;
  } catch (err) {
    show(cmsg, `Không tải được danh sách ý tưởng: ${err.message}`);
    return false;
  }
}

/**
 * Biến thể THUỘC VỀ một ý tưởng, nên đổi ý tưởng là phải nạp lại ô này.
 *
 * src/combine.ts từ chối cặp không khớp bằng lỗi `variant_mismatch`; chặn ngay ở đây
 * để người dùng không bao giờ phải gặp lỗi 400 đó.
 */
async function loadVariantOptions() {
  const ideaId = cidea.value;
  if (!ideaId) {
    cvariant.innerHTML = '';
    setReady(false, 'Hãy tạo một ý tưởng gốc trước đã.');
    return;
  }
  try {
    const { variants } = await get(`/api/ideas/${encodeURIComponent(ideaId)}/variants`);
    cvariant.innerHTML = variants
      .map((v) => `<option value="${esc(v.id)}">${esc(v.title)}</option>`)
      .join('');
    if (variants.length === 0) {
      setReady(false, 'Ý tưởng này chưa có biến thể nào — thêm một biến thể để ghép được.');
    } else {
      setReady(true);
      show(cmsg, '');
    }
  } catch (err) {
    cvariant.innerHTML = '';
    setReady(false, `Không tải được biến thể: ${err.message}`);
  }
}

async function loadHookOptions() {
  try {
    const [{ hooks }, { categories }] = await Promise.all([
      get('/api/hooks'),
      get('/api/hook-categories'),
    ]);
    const nameOf = new Map(categories.map((c) => [c.id, c.name]));
    chook.innerHTML = '<option value="">— Không dùng hook —</option>'
      + hooks.map((h) => {
          const cat = nameOf.get(h.category_id) ?? 'Chưa phân loại';
          const short = h.text.length > 60 ? `${h.text.slice(0, 60)}…` : h.text;
          return `<option value="${esc(h.id)}">[${esc(cat)}] ${esc(short)}</option>`;
        }).join('');
  } catch (err) {
    // Ghép không hook vẫn được, nhưng phải NÓI ra thay vì để ô rỗng không lý do.
    show(cmsg, `Không tải được thư viện hook: ${err.message}`, 'note');
  }
}

cidea.addEventListener('change', () => {
  $('#cout').hidden = true;
  void loadVariantOptions();
});

$('#cgen').addEventListener('click', async () => {
  const vid = cvariant.value;
  if (!vid) return;
  $('#cgen').disabled = true;
  try {
    const q = new URLSearchParams({ variant_id: vid });
    if (chook.value) q.set('hook_id', chook.value);
    const r = await get(`/api/prompt?${q.toString()}`);
    $('#cout').textContent = r.prompt;
    $('#cout').hidden = false;
    show(cmsg, '');
  } catch (err) {
    show(cmsg, err.message);
  } finally {
    $('#cgen').disabled = false;
  }
});

$('#csave').addEventListener('click', async () => {
  const ideaId = cidea.value;
  const vid = cvariant.value;
  if (!ideaId || !vid) return;
  $('#csave').disabled = true;
  $('#csave').textContent = 'Đang tạo…';
  try {
    const r = await post('/api/ideas/combine', {
      idea_id: ideaId,
      variant_id: vid,
      hook_id: chook.value || null,
    });
    // Ở LẠI trang: kết hợp nhiều lần liên tiếp từ cùng danh sách gợi ý là việc thường
    // làm, và điều hướng đi sẽ vứt mất danh sách đang xem.
    cmsg.innerHTML =
      `Đã tạo <a href="/idea?id=${encodeURIComponent(r.idea.id)}">${esc(r.idea.title)}</a>`
      + ' và lưu vào kho ý tưởng gốc. Ý tưởng mới đang ở trạng thái <strong>chưa index</strong>'
      + ' — mở nó ra rồi bấm "Index ý tưởng này" để đưa vào tìm kiếm ngữ nghĩa.';
    cmsg.className = 'msg ok';
    cmsg.hidden = false;
    $('#cout').hidden = true;
  } catch (err) {
    show(cmsg, err.message);
  } finally {
    $('#csave').disabled = false;
    $('#csave').textContent = 'Tạo ý tưởng mới';
  }
});

setReady(false);
if (await loadIdeaOptions()) {
  await loadVariantOptions();
  await loadHookOptions();
} else {
  setReady(false, 'Chưa có ý tưởng gốc nào để ghép. Hãy tạo một ý tưởng trước.');
}
