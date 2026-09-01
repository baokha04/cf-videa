/**
 * Entrypoint Worker — CHƯA DÙNG hôm nay, giữ sẵn để việc chuyển từ Pages sang
 * Worker + static assets sau này là một thay đổi cấu hình, không phải viết lại.
 *
 * Cách chuyển: xoá functions/, rồi trong wrangler.jsonc thay
 *   "pages_build_output_dir": "./public"
 * bằng
 *   "main": "src/worker.ts",
 *   "assets": { "directory": "./public", "binding": "ASSETS" }
 */
import app from './router';

export default app;
