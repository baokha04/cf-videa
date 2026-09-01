# cf-videa

Kho ý tưởng short video có quản lý tài khoản, chạy trên Cloudflare Pages + D1 + Vectorize.

Mỗi người dùng có kho ý tưởng riêng (tiêu đề, hook, dàn ý kịch bản, nền tảng, niche, tag,
trạng thái), tìm được **theo ý nghĩa** chứ không chỉ theo từ khoá, và được gợi ý lại những
ý tưởng cũ hợp gu mà mình đã quên.

**Không có LLM sinh nội dung ở đâu trong dự án này.** Lời gọi AI duy nhất là tạo *embedding*
để index và truy vấn chính dữ liệu bạn đã nhập.

---

## Ba ràng buộc thật của nền tảng, đo trên deployment thật

### 1. Trần cứng 100.000 vòng của workerd, và hệ quả lên băm mật khẩu

workerd **chặn cứng số vòng PBKDF2 ở 100.000**. Vượt qua sẽ ném thẳng lỗi:

```
NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported
```

Đây **không** phải giới hạn theo gói cước — nâng lên Workers Paid cũng không gỡ được.
Nên không thể tăng độ khó bằng cách tăng số vòng; cách duy nhất còn lại là chọn hàm băm
đắt hơn cho mỗi vòng. Số đo thực tế (`node scripts/bench-pbkdf2.mjs`), mỗi lần băm:

| Hàm băm | 50.000 | 100.000 | 210.000 | 600.000 |
|---|---:|---:|---:|---:|
| SHA-256 | 10 ms | 20 ms | 43 ms ✗ | 112 ms ✗ |
| **SHA-512** | 31 ms | **66 ms** ← đang dùng | 130 ms ✗ | 368 ms ✗ |

✗ = workerd từ chối chạy.

Vì vậy cấu hình là **PBKDF2-HMAC-SHA512, 100.000 vòng** — đúng trần nền tảng, với hàm băm
đắt nhất dùng được. Công bỏ ra tương đương khoảng 340.000 vòng SHA-256.

**Nói thẳng về mức bảo vệ:** OWASP khuyến nghị 600.000 vòng cho PBKDF2-HMAC-SHA256 hoặc
210.000 vòng cho PBKDF2-HMAC-SHA512. Trần của workerd khiến cấu hình này chỉ đạt khoảng
một nửa mức khuyến nghị. Đó là mức tốt nhất PBKDF2 đạt được trên nền tảng này. Muốn vượt
qua phải đổi sang Argon2id biên dịch ra WASM — đắt hơn nhiều về công sức và kích thước
bundle, chỉ nên làm nếu mô hình đe doạ thực sự đòi hỏi. Bù lại đã có hai lớp khác: mật
khẩu tối thiểu 10 ký tự và rate limit đăng nhập.

Cả hàm băm lẫn số vòng đều nằm trong từng chuỗi hash (`pbkdf2$sha512$100000$...`), nên
đổi tham số sau này không cần migration: hàng cũ vẫn đăng nhập được và lần đăng nhập
thành công đó tự băm lại theo mức mới.

**Về CPU:** ~66 ms mỗi lần đăng nhập. Nằm gọn trong hạn mức 30 giây của gói Workers Paid,
nhưng vượt hạn mức 10 ms của gói Free — mà ngay cả SHA-256 ở 100.000 vòng (~20 ms) cũng
đã vượt. Không có cách nào làm hàm băm mật khẩu đúng chuẩn mà rẻ; đó chính là mục đích.

### 2. Vectorize mất khoảng một phút để index, không phải vài giây

Upsert lên Vectorize là bất đồng bộ. Số đo thật trên deployment production:

```
+26s  →  0/5 vector truy vấn được
+46s  →  0/5
+68s  →  5/5
```

Nghĩa là ý tưởng vừa tạo **không** tìm được bằng tìm kiếm ngữ nghĩa trong khoảng một phút
đầu. Danh sách và tìm từ khoá (đọc thẳng D1) thì thấy ngay. Giao diện nói đúng con số này
thay vì để người dùng tưởng tìm kiếm bị hỏng.

### 3. "Gợi ý" hiện chỉ khơi lại ý tưởng của chính bạn

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
```

Việc tạo metadata index là **bất đồng bộ** — lệnh trên chỉ trả về "enqueued". Đo thật:
mất tới **~90 giây** để cả 4 property hiện ra. Phải poll cho đến khi đủ 4, **rồi mới**
tạo ý tưởng đầu tiên:

```bash
until [ "$(npx wrangler vectorize list-metadata-index videa-ideas \
           | grep -cE 'user_id|status|platform|visibility')" -ge 4 ]; do
  echo "chờ metadata index..."; sleep 15
done
```

Hai cái bẫy nữa của CLI, cả hai đều hỏng âm thầm:

- `wrangler vectorize info` báo `vectorCount` **có độ trễ** — nó phản ánh trạng thái tại
  `processedUpToDatetime`, không phải hiện tại. Đừng dùng nó để khẳng định index rỗng hay
  đầy ngay sau khi ghi.
- `wrangler vectorize delete-vectors --ids=a,b` **không phải** là xoá hai vector: cả chuỗi
  bị hiểu là MỘT id và lệnh lỗi `id too long; max is 64 bytes`. Phải lặp lại cờ:
  `--ids=a --ids=b`. Lỗi in ra stderr nên rất dễ trôi qua trong script.

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
npx wrangler pages deploy                     # nhánh hiện tại → preview
npx wrangler pages deploy --branch=main       # → production (cf-videa.pages.dev)

BASE=https://cf-videa.pages.dev npm run smoke                        # kiểm tra lại bản đã deploy
npx wrangler pages deployment tail <deployment-id> --project-name cf-videa
```

**Chẩn đoán lỗi 500 khi không dùng được `wrangler tail`.** Ở môi trường có policy egress
chặn `tail.developers.workers.dev` (CI, sandbox), log không lấy được và một lỗi 500 câm là
thứ không thể chẩn đoán. Vì vậy khi `APP_ENV` **khác** `production`, thân phản hồi lỗi có
thêm trường `error.debug` chứa tên lỗi, thông điệp và 6 dòng đầu của stack. Trên production
thì tuyệt đối không — chỉ ghi log. Chính cơ chế này đã tìm ra trần 100.000 vòng ở mục 1.

Việc định kỳ (dọn phiên hết hạn, dọn rate limit, rút vector mồ côi, đối soát index) cần
Worker riêng, vì **Pages Functions không có cron trigger**:

```bash
cd cron-worker
npx wrangler deploy
```

Worker này **không** gọi HTTP sang app Pages — nó import thẳng các hàm trong `../src` và
chạy trên binding D1/Vectorize của chính nó. Nên không cần secret dùng chung, không cần
`PAGES_ORIGIN`, và không có chặng mạng nào để hỏng. Đó chính là lợi ích cụ thể của việc
`src/` không import gì từ Pages: cùng một bản code chạy được ở cả hai nơi.

Bản đầu tiên có gọi HTTP sang `/api/admin/cron`, và nó im lặng không làm gì suốt nhiều
chu kỳ: lịch cron có đăng ký, endpoint gọi tay chạy đúng, nhưng đường qua worker thì
không — và không chẩn đoán được vì log không lấy được ở môi trường có policy egress.
Bỏ hẳn chặng đó đi thì vấn đề biến mất cùng với nguyên nhân.

**Theo dõi cron còn sống hay không.** Cả cron worker lẫn endpoint chạy tay đều ghi một
nhịp tim vào bảng `cron_runs` (đúng một hàng, ghi đè mỗi lần). `GET /api/health` trả ra:

```json
{ "cron_last_run_at": 1788280000000, "cron_last_source": "cron", "cron_stale": false }
```

`cron_stale` thành `true` khi quá 45 phút không có nhịp nào (lịch là 15 phút), và là
chuỗi `"chưa từng chạy"` khi bảng còn rỗng. Có nó thì một cron chết là một trường JSON
đọc được; không có nó thì phiên hết hạn chất đống và ý tưởng chưa index nằm im, không
dấu hiệu gì — đúng tình huống đã xảy ra khi dựng hệ thống này, và log thì không lấy
được vì `wrangler tail` bị policy egress chặn.

Endpoint `POST /api/admin/cron` vẫn giữ để chạy tay khi cần:

```bash
curl -X POST https://cf-videa.pages.dev/api/admin/cron \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: none' -d '{}'
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
| GET | `/api/health` | — | Kiểm tra D1 + binding; trả `dirty_ideas`, `gc_pending`, `cron_last_run_at`, `cron_stale` |
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

## Trạng thái đang chạy

| Thứ | Ở đâu |
|---|---|
| Production | https://cf-videa.pages.dev — `env: production`, D1 `videa-db`, index `videa-ideas` |
| Preview (nhánh này) | https://claude-account-management-sh.cf-videa.pages.dev — D1 `videa-db-preview`, index `videa-ideas-preview` |
| Cron | Worker `cf-videa-cron`, lịch `*/15 * * * *`, không route công khai, dùng chung D1 + Vectorize với production. **Chưa quan sát được nó bắn — xem bên dưới.** |

### ⚠️ Cron chưa được kiểm chứng là có bắn

Qua **sáu** mốc 15 phút liên tiếp không có nhịp tim nào được ghi. Những giả thuyết sau
đã bị loại trừ bằng thực nghiệm, không phải bằng suy đoán:

| Đã kiểm chứng | Kết quả |
|---|---|
| Lịch có được đăng ký không | Có — API Cloudflare trả về `*/15 * * * *`, tạo lúc 14:23 |
| Script deploy có export `scheduled` không | Có — đọc mã nguồn đã deploy qua API |
| Binding D1/Vectorize/AI có đúng không | Có — API xác nhận đủ ba |
| Công việc bên trong có chạy được không | Có — gọi tay `/api/admin/cron` quét sạch đúng |
| Có phải do chặng HTTP sang app Pages không | Không — bỏ hẳn chặng đó, vẫn không bắn |
| Có phải do `ctx.waitUntil` trong `scheduled()` không | Không — đổi sang `await` thẳng, vẫn không bắn |
| Có phải do worker không có route nào không | Không — bật `workers_dev`, mốc kế tiếp vẫn trượt |

Không chẩn đoán thêm được từ môi trường dựng dự án này: `wrangler tail` bị policy egress
chặn (`tail.developers.workers.dev`), truy vấn Workers Observability và GraphQL analytics
đều trả rỗng vì API token thiếu quyền đọc, và `*.workers.dev` cũng bị chặn nên không gọi
tay worker được. Nguyên nhân nằm ngoài code và ngoài cấu hình trong repo này.

**Cách bạn kiểm tra trên máy mình:**

```bash
curl -s https://cf-videa.pages.dev/api/health | jq '{cron_last_run_at, cron_stale}'
cd cron-worker && npx wrangler tail          # log thật, chạy được trên máy bạn
```

Nếu `cron_stale` vẫn là `"chưa từng chạy"` sau một giờ, xem tab Cron Triggers của worker
`cf-videa-cron` trên dashboard Cloudflare — nó hiển thị lịch sử từng lần chạy.

**Trong lúc đó ứng dụng vẫn tự bảo trì được.** Không có việc định kỳ nào chỉ dựa vào
cron: dọn phiên hết hạn, dọn bộ đếm rate limit và rút hàng đợi vector mồ côi đều chạy
thêm theo kiểu cơ hội trên khoảng 5% số lần đăng nhập (ngoài luồng phản hồi), còn đối
soát index có nút "Đồng bộ lại index" trong giao diện. Cron chỉ làm việc đó đều đặn hơn.

Cả hai D1 và cả hai Vectorize index đã được dọn sạch dữ liệu kiểm thử; index có đủ 4
metadata index và chưa có vector nào, nên tài khoản đầu tiên bạn tạo sẽ được index đúng.

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
