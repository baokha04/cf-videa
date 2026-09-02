/* Script CỔ ĐIỂN, nạp ĐỒNG BỘ trong <head> — cố ý không phải module, không defer.
 *
 * Nó phải chạy xong TRƯỚC khi trình duyệt vẽ khung hình đầu tiên, nếu không người
 * dùng đã chọn nền tối sẽ thấy một nháy trắng mỗi lần mở trang. Module và defer đều
 * chạy sau khi dựng xong DOM, tức là quá muộn.
 *
 * Vì sao không nhét thẳng vào <head> dưới dạng inline: CSP trong public/_headers đặt
 * script-src 'self' và KHÔNG có 'unsafe-inline'. Một file riêng là cách giữ nguyên
 * CSP nghiêm ngặt mà vẫn chạy kịp.
 */
(function () {
  var KEY = 'videa-theme';
  var theme;
  try {
    theme = localStorage.getItem(KEY);
  } catch (e) {
    // Chế độ riêng tư hoặc trình duyệt chặn lưu trữ: bỏ qua, dùng theo hệ thống.
    theme = null;
  }
  // Chỉ 'light' và 'dark' mới đặt thuộc tính. Không có thuộc tính = theo hệ thống,
  // và CSS xử lý trường hợp đó bằng prefers-color-scheme.
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }
})();
