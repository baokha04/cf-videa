import { post } from './api.js';
import { $, bindSubmit, setIcon, show } from './ui.js';
import { mountThemeToggle } from './theme.js';

// Một file phục vụ cả login.html lẫn register.html — hai form giống nhau tới mức
// tách ra thành hai file chỉ tạo thêm chỗ để chúng lệch nhau.
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
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/app';
}

/**
 * Ở đây nút gửi để `disabled` sẵn còn quan trọng hơn các trang khác: hai ô nhập của
 * form này CÓ thuộc tính `name`, và form không khai báo `method` nên mặc định là GET.
 * Một cú submit thuần — trước lúc module này tải và chạy xong — sẽ điều hướng tới
 * /login?email=…&password=… , tức là đẩy mật khẩu vào thanh địa chỉ, vào lịch sử trình
 * duyệt và vào header Referer của mọi request sau đó.
 */
bindSubmit(form, submit, async () => {
  show(msg, '');
  submit.disabled = true;
  setIcon(submit, 'busy', isRegister ? 'Đang tạo…' : 'Đang đăng nhập…');

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
    setIcon(submit, isRegister ? 'signup' : 'login', isRegister ? 'Đăng ký' : 'Đăng nhập');
  }
});
