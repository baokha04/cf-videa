import { del, get, post, put } from './api.js';
import { $, esc, show } from './ui.js';
import { mountNav } from './nav.js';

const user = await mountNav('/account');
$('#whoami').textContent = user.display_name
  ? `${user.display_name} · ${user.email}`
  : user.email;

function fmtWhen(ms) {
  return new Date(ms).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Rút gọn User-Agent thành thứ người ta đọc được. */
function device(ua) {
  if (!ua) return 'Không rõ';
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Mac OS X/i.test(ua) ? 'macOS'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux' : '';
  const br = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\//i.test(ua) ? 'Opera'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /curl/i.test(ua) ? 'curl' : '';
  return [br, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

async function loadSessions() {
  const tbody = $('#sessions');
  try {
    const { sessions } = await get('/api/auth/sessions');
    tbody.innerHTML = sessions
      .map(
        (s) => `<tr>
          <td>${esc(device(s.user_agent))}${s.current ? ' <span class="chip">phiên này</span>' : ''}</td>
          <td class="muted small">${esc(fmtWhen(s.last_seen_at))}</td>
          <td>${
            s.current
              ? ''
              : `<button class="link" type="button" data-revoke="${esc(s.id)}">Thu hồi</button>`
          }</td>
        </tr>`,
      )
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">${esc(err.message)}</td></tr>`;
  }
}

// Uỷ quyền sự kiện: CSP chặn onclick nội tuyến, và cách này sống sót qua mỗi lần
// render lại bảng.
$('#sessions').addEventListener('click', async (e) => {
  const id = e.target?.dataset?.revoke;
  if (!id) return;
  e.target.disabled = true;
  try {
    await del(`/api/auth/sessions/${encodeURIComponent(id)}`);
    await loadTemplate();
await loadSessions();
  } catch (err) {
    show($('#smsg'), err.message);
  }
});

// --- Mẫu prompt ------------------------------------------------------------

async function loadTemplate() {
  try {
    const t = await get('/api/prompt-template');
    $('#tpl').value = t.body;
    $('#tplvars').textContent = t.variables.map((v) => `{{${v}}}`).join('  ');
    if (t.unknown.length) {
      show($('#tplmsg'),
        `Mẫu đang có biến không nhận biết được: ${t.unknown.join(', ')}. `
        + 'Chúng sẽ xuất hiện nguyên văn trong prompt.', 'note');
    }
  } catch (err) {
    show($('#tplmsg'), err.message);
  }
}

$('#tplsave').addEventListener('click', async () => {
  const btn = $('#tplsave');
  btn.disabled = true;
  try {
    const r = await put('/api/prompt-template', { body: $('#tpl').value });
    show($('#tplmsg'),
      r.unknown.length
        ? `Đã lưu, nhưng có biến không nhận biết được: ${r.unknown.join(', ')}. `
          + 'Kiểm tra lại xem có gõ sai không.'
        : 'Đã lưu mẫu prompt.',
      r.unknown.length ? 'note' : 'ok');
  } catch (err) {
    show($('#tplmsg'), err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#tplreset').addEventListener('click', async () => {
  if (!confirm('Đưa mẫu về mặc định? Mẫu bạn đang sửa sẽ mất.')) return;
  try {
    const r = await del('/api/prompt-template');
    $('#tpl').value = r.body;
    show($('#tplmsg'), 'Đã đưa về mẫu mặc định.', 'ok');
  } catch (err) {
    show($('#tplmsg'), err.message);
  }
});

$('#pw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#pwsave');
  show($('#pwmsg'), '');
  btn.disabled = true;
  btn.textContent = 'Đang đổi…';
  try {
    const res = await post('/api/auth/change-password', {
      current_password: $('#current_password').value,
      new_password: $('#new_password').value,
    });
    $('#pw').reset();
    show(
      $('#pwmsg'),
      `Đã đổi mật khẩu. Đã thu hồi ${res.revoked_sessions} phiên khác.`,
      'ok',
    );
    await loadTemplate();
await loadSessions();
  } catch (err) {
    show($('#pwmsg'), err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Đổi mật khẩu';
  }
});

$('#revokeall').addEventListener('click', async () => {
  try {
    const res = await post('/api/auth/revoke-all');
    show($('#smsg'), `Đã thu hồi ${res.revoked_sessions} phiên khác.`, 'ok');
    await loadTemplate();
await loadSessions();
  } catch (err) {
    show($('#smsg'), err.message);
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await post('/api/auth/logout');
  } finally {
    location.replace('/login');
  }
});

await loadTemplate();
await loadSessions();
