import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Test chạy bên trong workerd thật với binding Miniflare thật, nên PBKDF2 và D1
 * ở đây chính là thứ chạy trên production, không phải bản mô phỏng bằng Node.
 *
 * Không trỏ vào wrangler.jsonc: đó là cấu hình Pages (pages_build_output_dir),
 * còn pool này chạy dạng Worker. Khai báo binding trực tiếp cho gọn và tách bạch.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-01',
        d1Databases: { DB: 'test-db' },
        bindings: {
          APP_ENV: 'test',
          COOKIE_NAME: '__Host-videa_sid',
          EMBEDDINGS_MODE: 'stub',
          ADMIN_TOKEN: 'test-admin-token',
        },
      },
      isolatedStorage: true,
      singleWorker: true,
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
