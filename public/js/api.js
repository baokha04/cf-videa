// Lớp bọc fetch duy nhất của toàn bộ frontend.
// Không có framework, không có bước build: trình duyệt chạy thẳng ES module.

const JSON_CT = 'application/json';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, redirectOn401 = true } = {}) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { Accept: JSON_CT },
  };
  if (body !== undefined) {
    // Bắt buộc có header này: phía server từ chối mọi request thay đổi dữ liệu
    // không phải JSON, đó là một phần của lớp phòng CSRF.
    opts.headers['Content-Type'] = JSON_CT;
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);

  if (res.status === 401 && redirectOn401) {
    const back = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?next=${back}`;
    // Dừng luồng gọi hiện tại lại trong lúc trình duyệt chuyển trang.
    throw new ApiError(401, 'unauthenticated', 'Cần đăng nhập.');
  }

  if (res.status === 204) return null;

  let data = null;
  let parseFailed = false;
  try {
    data = await res.json();
  } catch {
    data = null;
    parseFailed = true;
  }

  if (!res.ok) {
    const e = data && data.error ? data.error : {};
    throw new ApiError(res.status, e.code || 'unknown', e.message || 'Có lỗi xảy ra.');
  }

  // Phản hồi 2xx mà không đọc được thân JSON thì NÉM, đừng trả null.
  //
  // Chỉ 204 mới hợp lệ khi không có thân, và nó đã được xử lý ở trên. Trả null cho một
  // 200 hỏng thân nghĩa là mọi nơi gọi — vốn đều làm `data.<gì đó>` ngay sau — sẽ ném
  // TypeError sâu bên trong, không có thông điệp nào cho người dùng và chẳng chỉ về
  // đúng nguyên nhân. Ném ở đây thì lỗi mang đúng tên của nó.
  //
  // Gặp thật lúc kiểm thử: điều hướng sang trang khác cắt ngang lúc đang đọc thân phản
  // hồi, res.json() bị huỷ, và mountNav ném "Cannot read properties of null". Trường
  // hợp đó vô hại vì trang đang bị dỡ, nhưng một phản hồi 200 bị cắt cụt thật cũng đi
  // đúng đường này.
  if (parseFailed) {
    throw new ApiError(res.status, 'bad_response', 'Máy chủ trả về phản hồi không đọc được.');
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });
