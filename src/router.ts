import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { checkOrigin } from './http/guard';
import { errorResponse } from './http/response';
import { parseCookies, serializeCookie } from './http/cookies';
import { COOKIE_MAX_AGE_SEC, renewSession, resolveSession } from './auth/session';
import * as auth from './routes/auth';
import * as ideas from './routes/ideas';
import * as search from './routes/search';
import * as recommend from './routes/recommend';
import * as admin from './routes/admin';

/**
 * Toàn bộ API nằm ở một router duy nhất, và `src/` không import gì từ Pages.
 * Đây là chỗ nối cho tính di động: chuyển sang Worker + static assets về sau chỉ
 * cần một entrypoint `export default app` và đổi wrangler.jsonc — không sửa một
 * dòng logic nào.
 */
const app = new Hono<{ Bindings: Env; Variables: Variables }>().basePath('/api');

// Lỗi luôn ra JSON. Chi tiết chỉ đính kèm ở dev/preview, không bao giờ ở production.
app.onError((err, c) => errorResponse(err, c.env.APP_ENV));
app.notFound(() =>
  new Response(
    JSON.stringify({ error: { code: 'not_found', message: 'Không tìm thấy endpoint.' } }),
    { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  ),
);

/**
 * Middleware KHÔNG tự trả 401 — các route công khai (đăng nhập, đăng ký, health)
 * đi qua đúng middleware này và cần được cho qua. Mỗi route tự gọi requireUser().
 */
app.use('*', async (c, next) => {
  checkOrigin(c);

  const cookies = parseCookies(c.req.header('Cookie') ?? null);
  const token = cookies[c.env.COOKIE_NAME];
  if (token) {
    const resolved = await resolveSession(c.env, token);
    if (resolved) {
      c.set('user', resolved.user);
      c.set('session', resolved.session);
      if (resolved.shouldRenew) {
        // Gia hạn trượt: ghi ngoài luồng phản hồi, cookie thì gửi lại ngay.
        c.executionCtx.waitUntil(
          renewSession(c.env, resolved.session).then(() => undefined),
        );
        c.header(
          'Set-Cookie',
          serializeCookie(c.env.COOKIE_NAME, token, { maxAge: COOKIE_MAX_AGE_SEC }),
        );
      }
    }
  }

  await next();
  c.header('Cache-Control', 'no-store');
});

app.get('/health', admin.health);

app.post('/auth/register', auth.register);
app.post('/auth/login', auth.login);
app.post('/auth/logout', auth.logout);
app.get('/auth/me', auth.me);
app.post('/auth/change-password', auth.changePassword);
app.get('/auth/sessions', auth.listSessions);
app.delete('/auth/sessions/:id', auth.revokeOne);
app.post('/auth/revoke-all', auth.revokeAll);

app.get('/ideas', ideas.listIdeas);
app.post('/ideas', ideas.createIdea);
app.get('/ideas/:id', ideas.getIdea);
app.patch('/ideas/:id', ideas.updateIdea);
app.delete('/ideas/:id', ideas.deleteIdea);
app.post('/ideas/:id/like', ideas.likeIdea);
app.delete('/ideas/:id/like', ideas.unlikeIdea);
app.get('/ideas/:id/similar', search.similar);

app.get('/search', search.search);
app.get('/recommendations', recommend.recommendations);
app.get('/tags', ideas.listTagsRoute);
app.post('/reindex', admin.reindexMine);

app.post('/admin/reindex', admin.reindexAdmin);
app.post('/admin/maintenance', admin.maintenance);

export default app;
