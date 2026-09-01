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
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const e = data && data.error ? data.error : {};
    throw new ApiError(res.status, e.code || 'unknown', e.message || 'Có lỗi xảy ra.');
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });
