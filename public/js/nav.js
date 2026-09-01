import { get } from './api.js';
import { esc } from './ui.js';

/**
 * Thanh điều hướng dùng chung. Gọi ở mọi trang cần đăng nhập; trả về đối tượng
 * user để trang dùng tiếp mà không phải gọi /api/auth/me lần nữa.
 */
export async function mountNav(current) {
  const data = await get('/api/auth/me');
  const user = data.user;

  const links = [
    ['/app', 'Kho ý tưởng'],
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
  document.body.prepend(header);
  return user;
}
