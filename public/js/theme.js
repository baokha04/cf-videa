// Nút chuyển giao diện. Chu kỳ: theo hệ thống → sáng → tối → theo hệ thống.
//
// Giữ lại lựa chọn "theo hệ thống" chứ không chỉ có hai trạng thái sáng/tối: đó là
// hành vi mặc định trước đây, và bỏ nó đi thì người dùng đã đặt máy tự đổi theo giờ
// sẽ mất tính năng đó.
//
// Khoá localStorage phải trùng với public/js/theme-init.js.
const KEY = 'videa-theme';
const ORDER = ['auto', 'light', 'dark'];

const LABEL = {
  auto: { icon: '◐', text: 'Theo hệ thống' },
  light: { icon: '☀', text: 'Giao diện sáng' },
  dark: { icon: '☾', text: 'Giao diện tối' },
};

function read() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function write(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Không lưu được thì lựa chọn chỉ sống trong tab này. Vẫn hơn là không làm gì.
  }
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/** Gắn nút chuyển giao diện vào một phần tử. Trả về chính nút đó. */
export function mountThemeToggle(container) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';

  const render = () => {
    const t = read();
    const { icon, text } = LABEL[t];
    btn.innerHTML = `<span aria-hidden="true">${icon}</span>`;
    // Nút chỉ có biểu tượng nên phải có nhãn cho trình đọc màn hình.
    btn.setAttribute('aria-label', `${text}. Bấm để đổi.`);
    btn.title = text;
  };

  btn.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
    write(next);
    render();
  });

  render();
  container.append(btn);
  return btn;
}
