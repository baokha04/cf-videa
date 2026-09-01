/**
 * Entrypoint Pages Functions — cố ý mỏng.
 * Toàn bộ logic nằm ở src/router.ts để chuyển sang Worker sau này không phải
 * sửa gì ngoài file này.
 */
import { handle } from 'hono/cloudflare-pages';
import app from '../../src/router';

export const onRequest = handle(app);
