// Vite nạp file .sql dưới dạng chuỗi khi thêm hậu tố ?raw.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
