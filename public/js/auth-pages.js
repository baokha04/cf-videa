import { api, post } from './api.js';
import { $, show } from './ui.js';
import { mountThemeToggle } from './theme.js';

// Một file phục vụ cả trang đăng nhập (`/`, xem index.html) lẫn register.html —
// hai form giống nhau tới mức tách ra thành hai file chỉ tạo thêm chỗ để chúng lệch nhau.
const isRegister = location.pathname.startsWith('/register');

// Trang đăng nhập/đăng ký không có thanh điều hướng, nên nút giao diện gắn riêng.
const themeBar = $('#themebar');
if (themeBar) mountThemeToggle(themeBar);
const form = $('#f');
const msg = $('#msg');
const submit = $('#submit');

function nextUrl() {
  const raw = new URLSearchParams(location.search).get('next');
  // Chỉ nhận đường dẫn nội bộ: "//evil.example" và "https://evil.example" đều bị
  // loại, nếu không thì ?next trở thành lỗ chuyển hướng mở.
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/app';
  // Và không nhận ?next trỏ ngược về chính trang này. Từ khi trang đăng nhập là `/`,
  // `?next=/` sẽ thành vòng chuyển hướng vô hạn với người đã có phiên: vào `/`, bị
  // đẩy sang `/`, lặp lại mãi. `/login` cũng vậy vì nó 302 về `/`.
  const path = raw.split(/[?#]/)[0];
  if (path === '/' || path === '/login') return '/app';
  return raw;
}

// `/` vừa là màn hình đầu tiên vừa là trang đăng nhập, nên người còn phiên hợp lệ
// mở lên phải được đưa thẳng vào ứng dụng. Kiểm tra này chạy NGẦM, cố ý không chặn
// hiển thị: form đã vẽ xong và gõ được trước khi lượt gọi này trả lời — đó là điểm
// khác với màn hình "Đang chuyển hướng…" trước đây, thứ bắt mọi người chờ mạng.
//
// redirectOn401 = false: ở đây 401 là câu trả lời hợp lệ ("chưa đăng nhập"), không
// phải lỗi cần đá về trang đăng nhập kèm ?next — mà trang đăng nhập chính là đây.
if (!isRegister) {
  api('/api/auth/me', { redirectOn401: false }).then(
    () => location.replace(nextUrl()),
    () => {},
  );
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  show(msg, '');
  submit.disabled = true;
  submit.textContent = isRegister ? 'Đang tạo…' : 'Đang đăng nhập…';

  const body = {
    email: $('#email').value.trim(),
    password: $('#password').value,
    // Gửi tường minh cả khi không tích: server phân biệt "không chọn" với "không gửi",
    // và với đăng ký thì "không gửi" mặc định là có ghi nhớ.
    remember: $('#remember')?.checked === true,
  };
  if (isRegister) {
    const dn = $('#display_name').value.trim();
    if (dn) body.display_name = dn;
  }

  try {
    await post(isRegister ? '/api/auth/register' : '/api/auth/login', body);
    location.replace(nextUrl());
  } catch (err) {
    show(msg, err.message || 'Không thực hiện được.');
    submit.disabled = false;
    submit.textContent = isRegister ? 'Đăng ký' : 'Đăng nhập';
  }
});
