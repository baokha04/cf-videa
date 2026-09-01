# cf-videa

Kho ý tưởng short video có quản lý tài khoản, chạy trên Cloudflare Pages + D1 + Vectorize.

Mỗi người dùng có kho ý tưởng riêng (tiêu đề, hook, dàn ý kịch bản, nền tảng, niche, tag,
trạng thái), tìm được **theo ý nghĩa** chứ không chỉ theo từ khoá, và được gợi ý lại những
ý tưởng cũ hợp gu mà mình đã quên.

**Không có LLM sinh nội dung ở đâu trong dự án này.** Lời gọi AI duy nhất là tạo *embedding*
để index và truy vấn chính dữ liệu bạn đã nhập.

---

## Hai điều phải quyết trước khi chạy thật

### 1. Cần gói Workers Paid

Băm mật khẩu dùng PBKDF2-HMAC-SHA256 210.000 vòng (khuyến nghị OWASP). Số đo thực tế
(`node scripts/bench-pbkdf2.mjs`):

| Số vòng | CPU mỗi lần băm |
|---:|---:|
| 50.000 | ~9 ms |
| 100.000 | ~18 ms |
| **210.000** | **~37 ms** ← mức đang dùng |
| 600.000 | ~106 ms |

Workers/Pages tính **CPU time**. Mức này nằm gọn trong hạn mức 30 giây của gói Paid, nhưng
vượt xa hạn mức 10 ms của gói Free — trên Free thì ngay cả 50.000 vòng cũng đã sát trần và
đăng nhập sẽ bị ngắt giữa chừng.

Không có cách nào làm một hàm băm mật khẩu đúng chuẩn mà rẻ; đó chính là mục đích của nó.
Nếu buộc phải chạy Free, hạ `PBKDF2_ITERATIONS` trong `src/auth/password.ts` và ghi rõ đánh
đổi — nhưng **đừng** thay bằng SHA-256 trần. Số vòng được nhúng vào từng chuỗi hash nên nâng
lại sau này không cần migration: đăng nhập thành công với hash cũ sẽ tự băm lại.

### 2. "Gợi ý" hiện chỉ khơi lại ý tưởng của chính bạn

Mọi ý tưởng đều riêng tư với tác giả, nên gợi ý cá nhân hoá chỉ có thể lôi lại ý tưởng
**của chính bạn** mà bạn chưa thích — nó là "khơi lại ý tưởng cũ đã quên", không phải
"khám phá ý tưởng mới từ người khác". Giao diện nói đúng như vậy.

Muốn có kho chung thật sự: đổi `visibility` của ý tưởng thành `'public'` và mở rộng filter
trong `src/routes/recommend.ts` thành
`{ $or: [{ user_id: { $eq: uid } }, { visibility: { $eq: 'public' } }] }`.
Cột và metadata index cho việc đó đã được tạo sẵn từ ngày đầu — thêm sau sẽ tốn một lần
reindex toàn bộ.

---

## Khởi tạo hạ tầng

```bash
npm install
npx wrangler login

# D1 — chép database_id trả về vào wrangler.jsonc (cả env.preview lẫn env.production)
npx wrangler d1 create videa-db
npx wrangler d1 create videa-db-preview

# Vectorize
npx wrangler vectorize create videa-ideas         --dimensions=1024 --metric=cosine
npx wrangler vectorize create videa-ideas-preview --dimensions=1024 --metric=cosine
```

### ⚠️ Metadata index phải tạo TRƯỚC lần upsert đầu tiên

Vector được ghi *trước khi* một metadata index tồn tại sẽ **không** nằm trong index đó, và
cách sửa duy nhất là upsert lại toàn bộ. Chạy trọn khối này trước khi tạo ý tưởng nào:

```bash
for ix in videa-ideas videa-ideas-preview; do
  for p in user_id status platform visibility; do
    npx wrangler vectorize create-metadata-index $ix --property-name=$p --type=string
  done
done
npx wrangler vectorize list-metadata-index videa-ideas   # xác nhận đủ 4 trước khi đi tiếp
```

`visibility` được index dù v1 chưa dùng — lý do ở mục 2 phía trên.

### Migration và secret

```bash
npx wrangler d1 execute videa-db         --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute videa-db-preview --remote --file=./migrations/0001_init.sql

npx wrangler pages project create cf-videa --production-branch=main
npx wrangler pages secret put ADMIN_TOKEN               # production
npx wrangler pages secret put ADMIN_TOKEN --env preview
```

---

## Phát triển

```bash
npx wrangler d1 execute videa-db --local --file=./migrations/0001_init.sql
cp .dev.vars.example .dev.vars
npx wrangler pages dev            # http://localhost:8788
```

Có hai chế độ dev, chọn bằng `.dev.vars`:

**(a) Offline** — `EMBEDDINGS_MODE=stub` (mặc định trong `.dev.vars.example`).
D1 chạy local, không gọi mạng, không tốn hạn mức Workers AI. Tìm kiếm ngữ nghĩa tự lùi về
tìm từ khoá và ý tưởng mới hiện nhãn "chưa index" — đó là hành vi đúng, không phải lỗi.
Đủ để làm auth, CRUD và toàn bộ frontend.

**(b) Có Vectorize + AI thật** — thêm `"remote": true` vào binding `vectorize` và `ai` ở cấp
cao nhất của `wrangler.jsonc`, đặt `EMBEDDINGS_MODE=live`. Index phải tồn tại sẵn.
**Binding AI luôn gọi ra dịch vụ thật và tính hạn mức thật, kể cả khi đang `pages dev`.**

Vectorize và Workers AI **không có giả lập local** — không có cách nào chạy chúng trong
workerd trên máy bạn.

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest trong workerd thật
npm run smoke       # 37 kiểm tra HTTP end-to-end
npx wrangler types  # sinh lại src/env.d.ts sau MỖI lần đổi binding
```

## Deploy

```bash
npx wrangler pages deploy
BASE=https://cf-videa.pages.dev npm run smoke      # kiểm tra lại trên bản đã deploy
npx wrangler pages deployment tail                 # log thật, xem CPU time thật
```

Việc định kỳ (dọn phiên hết hạn, dọn rate limit, rút vector mồ côi, đối soát index) cần
Worker riêng, vì **Pages Functions không có cron trigger**:

```bash
cd cron-worker
# Sửa PAGES_ORIGIN trong wrangler.jsonc thành domain thật của bạn
npx wrangler secret put ADMIN_TOKEN     # PHẢI trùng secret của dự án Pages
npx wrangler deploy
```

---

## Kiến trúc

```
public/          Frontend tĩnh — HTML + ES module thuần, KHÔNG có bước build
functions/       Entrypoint Pages Functions, đúng 3 dòng
src/             Toàn bộ logic. Không import gì từ Pages.
  router.ts      Một router Hono duy nhất — đây là chỗ nối cho tính di động
  worker.ts      Entrypoint Worker, chưa dùng, giữ sẵn để chuyển nền sau này
migrations/      Schema D1
cron-worker/     Worker riêng, chỉ làm mỗi việc đánh thức /api/admin/cron
```

**Vì sao tách `src/` khỏi `functions/`:** chuyển từ Pages sang Worker + static assets sau
này chỉ là xoá `functions/`, đổi `pages_build_output_dir` thành `main: "src/worker.ts"` +
khối `assets`. Không sửa một dòng logic nào.

### Quyết định đáng chú ý

**Không bật `nodejs_compat`.** `crypto.subtle` (PBKDF2, SHA-256), `crypto.getRandomValues`,
`crypto.randomUUID`, `TextEncoder`, `atob`/`btoa` đều là Web API toàn cục trong workerd.
Chỉ bật flag này nếu về sau có dependency đòi `node:*`.

**Pages không kế thừa binding xuống env.** Toàn bộ khối binding được lặp lại đầy đủ trong cả
`env.preview` lẫn `env.production`. Binding có ở cấp cao nhất nhưng thiếu trong
`env.production` sẽ là `undefined` trên production — đây là lỗi Pages kinh điển, và
`GET /api/health` kiểm tra đúng điều đó.

**Vectorize lọc theo metadata `user_id`, không dùng namespace-per-user.** Mỗi index chỉ chứa
được 1.000 namespace, nên namespace-per-user biến 1.000 người dùng thành trần kiến trúc.
Metadata filter không giới hạn số giá trị và kết hợp được nhiều điều kiện trong một truy vấn.

**Kết quả từ Vectorize luôn được nạp lại từ D1 có lọc `user_id`.** Đây mới là bảo đảm cách ly
thật sự: kể cả nếu metadata filter bị bỏ sót vì một lỗi về sau, hoặc còn sót vector của tài
khoản đã xoá, câu lệnh hydrate vẫn lọc theo `user_id` và âm thầm bỏ qua. Vectorize chỉ là
gợi ý về thứ hạng; D1 mới là nơi quyết định ai sở hữu cái gì.

**Đồng bộ bằng hash nội dung, không bằng số phiên bản.**
`content_hash = sha256(embedText + '|' + MODEL_ID)` so với `embedded_hash`; khác nhau nghĩa
là "bẩn". Vì `MODEL_ID` nằm trong hash, **đổi model là mọi hàng tự động thành bẩn** — công cụ
đối soát có sẵn trở thành công cụ chuyển đổi model, không phải viết thêm gì.

**Không cần Queues.** Cột `embedded_hash` chính LÀ hàng đợi thử lại, và đếm được bằng một câu
SQL (`/api/health` trả về `dirty_ideas`). Index chạy đồng bộ ngay trong request — người dùng
vừa lưu thì mong tìm thấy ngay, còn lỗi trong `waitUntil` thì vô hình và không ai thử lại.
Lỗi embedding **không bao giờ** làm hỏng thao tác lưu: bản ghi vẫn còn, chỉ ở trạng thái bẩn.

**Rate limit bằng D1, không dùng Durable Objects.** Một dự án Pages không có DO của riêng nó
— muốn có thì phải deploy thêm một Worker chỉ để chứa class, đánh mất chính cái đơn giản mà
Pages mang lại. Dùng bộ đếm cửa sổ cố định, nguyên tử trong một câu lệnh
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (D1 không có transaction tương tác, nên
đọc-rồi-ghi hai bước sẽ đua nhau). Có domain riêng thì nên bổ sung WAF Rate Limiting Rule.

### Bảo mật

- **Phiên có trạng thái trong D1**, không phải JWT — thu hồi được ngay. D1 chỉ lưu
  `sha256(token)`: một bản dump database không cho phép mạo danh phiên nào.
- **Cookie `__Host-`**: trình duyệt từ chối nếu thiếu `Secure`, thiếu `Path=/`, hoặc có
  `Domain` → chặn cố định cookie từ subdomain. Hoạt động cả trên `http://localhost` vì
  localhost là secure context, nên **không bỏ `Secure` khi dev**.
- **Hai mốc hết hạn**: nhàn rỗi 14 ngày (gia hạn trượt) và trần cứng 90 ngày (không bao giờ
  gia hạn).
- **CSRF**: kiểm tra `Origin`/`Sec-Fetch-Site` trên mọi request thay đổi dữ liệu, cộng với
  bắt buộc `Content-Type: application/json`. Không dùng token vì không cần. Quy tắc đi kèm,
  **không được vi phạm**: không endpoint `GET` nào được thay đổi dữ liệu — `SameSite=Lax`
  VẪN gửi cookie theo điều hướng GET ở cấp cao nhất.
- **Không dò được tài khoản**: email lạ, sai mật khẩu và tài khoản bị khoá đều trả cùng một
  thông điệp, và nhánh "không tìm thấy" vẫn chạy một lần băm giả để thời gian phản hồi không
  tiết lộ gì.
- **Cách ly đa người dùng là cấu trúc, không phải quy ước**: mọi hàm trong `src/db/ideas.ts`
  nhận `userId` làm tham số đầu tiên và ràng buộc `user_id` ngay trong câu lệnh. Không khớp
  thì trả **404**, không phải 403 — 403 sẽ xác nhận rằng bản ghi đó có tồn tại.
- **CSP nghiêm ngặt** (`script-src 'self'`, không `unsafe-inline`) trong `public/_headers`,
  khả thi vì frontend không có script CDN và không có handler nội tuyến. Không được dùng
  thuộc tính `style=` nội tuyến ở bất kỳ đâu.

## API

Tất cả dưới `/api`. Cột "Auth" = cần cookie phiên hợp lệ.

| Method | Path | Auth | Ghi chú |
|---|---|:--:|---|
| GET | `/api/health` | — | Kiểm tra D1 + sự hiện diện của binding; trả `dirty_ideas` |
| POST | `/api/auth/register` | — | `{email, password, display_name?}` |
| POST | `/api/auth/login` | — | `{email, password}` |
| POST | `/api/auth/logout` | ✓ | |
| GET | `/api/auth/me` | ✓ | |
| POST | `/api/auth/change-password` | ✓ | Thu hồi mọi phiên khác |
| GET | `/api/auth/sessions` | ✓ | |
| DELETE | `/api/auth/sessions/:id` | ✓ | |
| POST | `/api/auth/revoke-all` | ✓ | Giữ lại phiên hiện tại |
| GET | `/api/ideas` | ✓ | Lọc + tìm từ khoá, phân trang keyset |
| POST | `/api/ideas` | ✓ | Trả `{idea, indexed}` |
| GET · PATCH · DELETE | `/api/ideas/:id` | ✓ | 404 khi không phải của bạn |
| POST · DELETE | `/api/ideas/:id/like` | ✓ | Idempotent |
| GET | `/api/ideas/:id/similar` | ✓ | Dùng lại vector đã lưu |
| GET | `/api/search` | ✓ | Ngữ nghĩa; lùi về từ khoá khi AI/Vectorize hỏng |
| GET | `/api/recommendations` | ✓ | `basis: likes \| cold_start` |
| GET | `/api/tags` | ✓ | |
| POST | `/api/reindex` | ✓ | Đối soát cho chính mình, theo lô |
| POST | `/api/admin/reindex` | `ADMIN_TOKEN` | `{scope: dirty\|all\|user}` — cũng là công cụ đổi model |
| POST | `/api/admin/cron` | `ADMIN_TOKEN` | Điểm vào cho cron-worker |

## Kiểm thử

Ưu tiên đúng chỗ thay vì phủ đều:

- **`npm test`** (vitest chạy trong workerd thật với D1 thật) tập trung vào nơi một lỗi sẽ
  *im lặng và nguy hiểm*: băm/kiểm tra mật khẩu, vòng đời phiên, **ma trận cách ly đa người
  dùng**, và phần kế toán đồng bộ Vectorize (dùng Vectorize giả trong bộ nhớ).
- **`npm run smoke`** kiểm tra toàn bộ luồng HTTP bằng curl, chạy được cả với `pages dev`
  lẫn với bản đã deploy.
- Cố ý **không** test chất lượng embedding hay khẳng định điểm tương đồng cụ thể — đó là
  thuộc tính của một model được host, có thể đổi bất cứ lúc nào. Chỉ khẳng định về *thứ hạng*
  và về *cách ly*.
