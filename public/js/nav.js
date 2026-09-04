import { get } from './api.js';
import { esc, show } from './ui.js';
import { mountThemeToggle } from './theme.js';

/**
 * Thanh điều hướng dùng chung. Gọi ở mọi trang cần đăng nhập; trả về đối tượng
 * user để trang dùng tiếp mà không phải gọi /api/auth/me lần nữa.
 */
export async function mountNav(current) {
  const data = await get('/api/auth/me');
  const user = data.user;

  const links = [
    ['/app', 'Ý tưởng gốc'],
    ['/variants', 'Biến thể'],
    ['/hooks', 'Hook'],
    ['/search', 'Tìm kiếm'],
    ['/recommend', 'Gợi ý'],
    ['/account', 'Tài khoản'],
  ];

  const header = document.createElement('header');
  header.className = 'site';
  header.innerHTML = `
    <a class="brand" href="/app">cf-videa</a>
    <nav>${links
      .map(
        ([href, label]) =>
          `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${esc(label)}</a>`,
      )
      .join('')}</nav>
    <span class="who">${esc(user.display_name || user.email)}</span>`;
  // Nút giao diện gắn sau khi dựng innerHTML, nếu không nó bị ghi đè mất.
  mountThemeToggle(header);
  document.body.prepend(header);
  return user;
}

/**
 * mountNav bọc lại sao cho hỏng cũng KHÔNG giết cả trang.
 *
 * Mọi trang đều mở đầu bằng `await mountNav(...)` ở cấp cao nhất của module. Một lần
 * ném ở đó là dừng luôn việc chạy module: phần khai báo, phần gắn trình xử lý form và
 * phần nạp dữ liệu bên dưới KHÔNG BAO GIỜ chạy, và không có lấy một thông báo nào.
 * Người dùng chỉ thấy phần HTML tĩnh và tưởng trang "nạp thiếu" — đúng triệu chứng đã
 * gặp ở /idea, nơi form còn sống mà trình xử lý submit thì chưa có.
 *
 * Trả về user, hoặc null khi không dựng được thanh điều hướng. Trang nào cần user thì
 * phải xử lý null; phần còn lại của trang vẫn chạy bình thường.
 */
export async function mountNavSafe(current) {
  try {
    return await mountNav(current);
  } catch (err) {
    // 401 thì api.js đã đá sang /login rồi — trình duyệt đang chuyển trang, báo lỗi ở
    // đây chỉ nháy lên một câu vô nghĩa ngay trước khi trang biến mất.
    if (err?.status === 401) return null;
    // `#msg` là chỗ thông báo của phần lớn trang, nhưng /hooks và /account không có ô
    // nào tên như vậy — lùi về ô .msg đầu tiên để lỗi không rơi vào hư không.
    const slot = document.querySelector('#msg') ?? document.querySelector('.msg');
    show(slot, `Không tải được thanh điều hướng: ${err.message}`, 'note');
    return null;
  }
}
