import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { checkOrigin } from './http/guard';
import { errorResponse } from './http/response';
import { parseCookies, serializeCookie } from './http/cookies';
import { cookieMaxAge, renewSession, resolveSession } from './auth/session';
import * as auth from './routes/auth';
import * as ideas from './routes/ideas';
import * as search from './routes/search';
import * as recommend from './routes/recommend';
import * as admin from './routes/admin';
import * as hooks from './routes/hooks';
import * as variants from './routes/variants';

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
        // Phát lại cookie đúng kiểu của phiên: có Max-Age nếu người dùng chọn ghi
        // nhớ, còn không thì là cookie phiên.
        c.header(
          'Set-Cookie',
          serializeCookie(c.env.COOKIE_NAME, token, {
            maxAge: cookieMaxAge(resolved.session.remember),
          }),
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
// Index đúng một mục. POST vì nó gọi Workers AI và ghi lên Vectorize.
app.post('/ideas/:id/index', ideas.indexIdea);
// Kết hợp gốc + biến thể + hook thành một ý tưởng gốc MỚI. POST vì nó ghi dữ liệu —
// khác hẳn GET /prompt bên dưới, vốn chỉ ghép ra chuỗi rồi thôi.
app.post('/ideas/combine', ideas.combineIdea);

// Biến thể của một ý tưởng gốc.
app.get('/ideas/:id/variants', variants.listVariants);
app.post('/ideas/:id/variants', variants.createVariant);
app.patch('/variants/:id', variants.updateVariant);
app.delete('/variants/:id', variants.deleteVariant);
app.post('/variants/:id/index', variants.indexVariant);

// Thư viện hook, có nhóm danh mục.
app.get('/hook-categories', hooks.listCategories);
app.post('/hook-categories', hooks.createCategory);
app.patch('/hook-categories/:id', hooks.updateCategory);
app.delete('/hook-categories/:id', hooks.deleteCategory);
app.get('/hooks', hooks.listHooks);
app.post('/hooks', hooks.createHook);
app.patch('/hooks/:id', hooks.updateHook);
app.delete('/hooks/:id', hooks.deleteHook);
app.post('/hooks/:id/index', hooks.indexHook);

// Ghép prompt: GET vì đây là thao tác đọc thuần tuý, không đổi gì.
app.get('/prompt', variants.generatePrompt);
app.get('/prompt-template', admin.getPromptTemplate);
app.put('/prompt-template', admin.savePromptTemplate);
app.delete('/prompt-template', admin.resetPromptTemplate);

app.get('/search', search.search);
app.get('/recommendations', recommend.recommendations);
app.get('/tags', ideas.listTagsRoute);
app.get('/sync', admin.syncStatus);
app.post('/reindex', admin.reindexMine);

app.post('/admin/reindex', admin.reindexAdmin);
app.post('/admin/maintenance', admin.maintenance);

export default app;
