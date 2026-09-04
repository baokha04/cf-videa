# cf-videa

Kho ý tưởng short video có quản lý tài khoản, chạy trên Cloudflare Pages + D1 + Vectorize.

Ba kho riêng cho mỗi người dùng — **ý tưởng gốc**, **ý tưởng biến thể**, **video hook** —
mỗi mục có vector riêng và được index bằng nút bấm của chính nó. Tìm được **theo ý nghĩa**
chứ không chỉ theo từ khoá, được cảnh báo khi vừa nghĩ ra một ý tưởng đã có sẵn, và ghép
được gốc + biến thể + hook thành một ý tưởng gốc mới.

**Không có LLM sinh nội dung ở đâu trong dự án này.** Lời gọi AI duy nhất là tạo *embedding*
để index và truy vấn chính dữ liệu bạn đã nhập.

---

## Ba ràng buộc thật của nền tảng, đo trên deployment thật

### 1. Băm mật khẩu bị siết từ hai phía, và kết quả yếu hơn khuyến nghị

**(a) workerd chặn cứng số vòng PBKDF2 ở 100.000.** Vượt qua ném thẳng
`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`.
Không phải giới hạn theo gói — nâng gói cũng không gỡ được.

**(b) Gói Workers Free giới hạn ~10ms CPU mỗi request**, và PBKDF2 là CPU thuần.
Vượt qua thì Cloudflare ngắt bằng `Error 1102: Worker exceeded resource limits`.

Cái bẫy của (b): **nó không hỏng ngay từ request đầu.** Bản dùng SHA-512 100.000 vòng
(66ms) chạy trót lọt 18–21 lần đăng nhập liên tiếp rồi mới bung 1102. Kiểm thử lẻ tẻ
hoàn toàn không phát hiện được — chỉ tải liên tục mới lộ ra. Số đo:

| Hàm băm | 20.000 | 30.000 | 50.000 | 100.000 |
|---|---:|---:|---:|---:|
| SHA-256 | 4 ms | **7 ms** ← đang dùng | 12 ms ✗ | 18 ms ✗ |
| SHA-512 | 12 ms ✗ | 18 ms ✗ | 30 ms ✗ | 66 ms ✗ |

✗ = vượt ngân sách CPU của gói Free.

Cấu hình hiện tại: **PBKDF2-HMAC-SHA256, 30.000 vòng**.

**Nói thẳng về mức bảo vệ:** OWASP khuyến nghị 600.000 vòng cho PBKDF2-HMAC-SHA256.
Cấu hình này thấp hơn khoảng **20 lần**. Đây là lựa chọn có ý thức để ở lại gói Free,
không phải sơ suất. Mật khẩu vẫn có salt ngẫu nhiên riêng và vẫn được kéo dài, nhưng
nếu database bị lộ thì mật khẩu yếu sẽ bị dò ra nhanh hơn nhiều so với một hệ thống
đúng chuẩn. Hai lớp bù đắp — mật khẩu tối thiểu 10 ký tự và rate limit đăng nhập —
chỉ chặn dò trực tuyến, không giúp được gì khi kẻ tấn công đã có bản dump.

**Muốn mạnh hơn:** nâng lên Workers Paid ($5/tháng, hạn mức CPU 30 giây) rồi đổi hai
hằng số đầu file `src/auth/password.ts` thành `WORKERD_MAX_ITERATIONS` và `'SHA-512'`
— mức tốt nhất PBKDF2 đạt được trên nền tảng này. **Không cần migration:** cả hàm băm
lẫn số vòng nằm trong từng chuỗi hash, và lần đăng nhập thành công kế tiếp của mỗi
người dùng sẽ tự băm lại theo tham số mới.

### 2. Vectorize mất khoảng một phút để index, không phải vài giây

Upsert lên Vectorize là bất đồng bộ. Số đo thật trên deployment production:

```
+26s  →  0/5 vector truy vấn được
+46s  →  0/5
+68s  →  5/5
```

Nghĩa là sau khi bấm "Index", vẫn phải chờ thêm khoảng một phút nữa thì ý tưởng
mới tìm được bằng tìm kiếm ngữ nghĩa. Danh sách và tìm từ khoá (đọc thẳng D1) thì thấy
ngay. Giao diện nói đúng con số này thay vì để người dùng tưởng tìm kiếm bị hỏng.

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

## Mô hình dữ liệu

```
ý tưởng gốc  ──┬── nhiều BIẾN THỂ (tên, góc nhìn, dàn ý riêng)
               │
thư viện HOOK ─┘   (dùng chung, có nhóm danh mục)

        │
        └── KẾT HỢP (gốc + biến thể + hook) ──> một Ý TƯỞNG GỐC MỚI
                                                (có lineage trỏ về ba nguồn)
```

**Hook không thuộc về ý tưởng nào.** Nó nằm trong một thư viện dùng chung, chia theo
danh mục do bạn tự đặt (Câu hỏi, Con số, Phản đề…). Cột `hook` trên bảng `ideas` đã
bị bỏ (migration 0005).

**Biến thể không gắn cứng hook.** Hook được chọn tại thời điểm sinh prompt, nên n biến
thể × m hook cho ra n×m prompt khả dĩ mà không phải nhân bản dữ liệu. Đó là lý do
`idea_variants` không có cột `hook_id`.

**Prompt = mẫu + (ý tưởng gốc + hook + biến thể).** Không có AI ở bước này: đây là
phép thay chuỗi thuần tuý trên mẫu bạn sở hữu, nên cùng đầu vào luôn ra cùng kết quả
và đọc mẫu là biết trước prompt sẽ ra sao. Biến dùng được:

`{{idea_title}}` `{{variant_title}}` `{{variant_angle}}` `{{hook}}` `{{hook_category}}`
`{{script}}` `{{niche}}` `{{platform}}` `{{status}}` `{{tags}}` `{{negative_prompt}}`

Hai quy tắc đáng nhớ:

- **`{{script}}` lấy dàn ý riêng của biến thể; để trống thì kế thừa dàn ý của ý tưởng
  gốc.** Nhờ vậy biến thể vừa gọn khi chỉ cần đổi góc nhìn, vừa đầy đủ khi cần kịch
  bản khác hẳn.
- **Biến gõ sai được GIỮ NGUYÊN trong prompt, không xoá âm thầm.** Bị xoá thì bạn chỉ
  thấy prompt thiếu một mảng và không hiểu vì sao; để nguyên `{{tieu_de}}` là tự nó
  chỉ ra lỗi. `GET /api/prompt-template` cũng trả danh sách biến lạ để giao diện cảnh báo.

Mẫu mặc định để **nội dung tiếng Việt, nhãn cấu trúc tiếng Anh** (Concept, Hook,
Angle, Script outline…): các công cụ video AI dựa vào những nhãn đó để hiểu bố cục
prompt và nhận diện tiếng Anh tốt hơn hẳn, trong khi nội dung sáng tạo để nguyên
tiếng Việt vẫn tốt hơn dịch máy. Sửa mẫu ở trang **Tài khoản**.

**Cả ba kho đều có vector riêng, chung một index Vectorize.** Phân biệt bằng metadata
`type` (`idea` | `variant` | `hook`); id vector của hook và biến thể mang tiền tố
`hook:` / `variant:` cho dễ đọc khi soi index. Tìm kiếm ý tưởng lọc `type = 'idea'` —
**điều kiện bắt buộc, không phải tối ưu hoá**: thiếu nó thì vector hook và biến thể
chiếm suất trong topK rồi bị tầng hydrate lặng lẽ loại đi, và kết quả ít đi mà không có
dấu hiệu gì (`src/vec/index.ts`).

**Văn bản nhúng của hook và biến thể là hàm THUẦN của chính hàng đó.** Cụ thể là hai
quyết định đáng nhớ, cả hai đều để tránh làm bẩn dây chuyền:

- **Tên danh mục không nằm trong văn bản nhúng của hook.** Nếu có thì đổi tên một danh
  mục sẽ làm bẩn mọi hook bên trong, và một thao tác sắp xếp lại biến thành hàng loạt
  lời gọi Workers AI. Danh mục đi vào *metadata* của vector, nơi cột `indexed_meta_hash`
  theo dõi được mà không tốn lần nhúng nào.
- **Biến thể KHÔNG kế thừa dàn ý gốc trong văn bản nhúng**, dù lúc sinh prompt thì có
  (quy tắc `{{script}}`). Hai việc khác nhau: prompt cần kịch bản đầy đủ để đem đi dựng
  video, còn vector cần thứ *phân biệt* biến thể này với các biến thể khác. Nhét dàn ý
  gốc vào cả n biến thể thì n vector xúm lại quanh một điểm và việc tìm theo góc triển
  khai hỏng hẳn.

**Ba kho, ba trang, mỗi kho quản lý độc lập.** `/app` cho ý tưởng gốc, `/variants` cho biến
thể, `/hooks` cho hook — mỗi trang **thêm, sửa, xoá và index** được ngay tại chỗ, không phải
nhảy sang trang khác. Biến thể vẫn *thuộc về* một ý tưởng gốc, nên lúc tạo phải chọn ý tưởng
cha; trang ý tưởng cũng vẫn thêm sửa biến thể được như trước, hai đường dẫn tới cùng một API.

**Ô chọn ý tưởng cha dùng `GET /api/ideas/titles`, không phải `GET /api/ideas`.** Cái sau
phân trang tối đa 50 nên một ô chọn dựng từ nó sẽ âm thầm thiếu ý tưởng, và người dùng không
hiểu vì sao ý tưởng của mình biến mất khỏi danh sách. Endpoint riêng chỉ trả id + tiêu đề,
có trần 500 và **cờ `truncated`** để giao diện nói thẳng khi chạm trần thay vì lặng lẽ cắt.

**Sửa biến thể không đổi được ý tưởng cha.** API không hỗ trợ chuyển biến thể sang ý tưởng
khác (`idea_id` nằm trong chữ ký metadata của vector), nên lúc sửa, ô chọn bị khoá lại thay
vì để người dùng đổi hụt rồi tưởng đã đổi được.

`GET /api/variants` JOIN sang `ideas` để trả kèm `idea_title` ngay trong một truy vấn —
giao diện luôn cần nó, lấy riêng sẽ thành N+1. Điều kiện JOIN ràng buộc **cả** `user_id` của
`ideas`, không chỉ của `idea_variants`: thừa về lý thuyết vì hai cột luôn bằng nhau, nhưng
nếu một ngày nào đó chúng lệch thì đây là chỗ chặn chứ không phải chỗ rò rỉ.

Lọc theo ý tưởng gốc trên `/variants` là một **liên kết** (`?idea=…`) chứ không phải nút:
trạng thái lọc nhờ vậy chia sẻ được, tải lại được, và nút Back chạy đúng. Cố ý **không** làm
ô chọn đổ sẵn danh sách ý tưởng — API phân trang tối đa 50 nên một ô như vậy sẽ âm thầm cụt
khi người dùng có nhiều ý tưởng hơn thế.

**Biến thể vẫn tham gia vào tìm kiếm ý tưởng.** Tiêu đề và góc nhìn của nó nằm trong văn
bản nhúng của ý tưởng CHA, và tìm từ khoá trên D1 cũng quét sang bảng biến thể — người ta
thường nhớ góc triển khai chứ không nhớ tiêu đề gốc. Hệ quả: **thêm hoặc sửa biến thể làm
CẢ HAI bẩn trở lại** — chính biến thể đó, và ý tưởng gốc của nó (`src/content.ts`).

**Negative prompt không bao giờ được nhúng.** Nó nằm trên ý tưởng gốc, đi vào prompt qua
biến `{{negative_prompt}}`, và cố ý đứng ngoài `ideaEmbedText`: nhúng một danh sách "không
được xuất hiện" thì embedding đọc dấu trừ thành dấu cộng, và ý tưởng sẽ khớp với đúng thứ
nó muốn tránh. Hệ quả tốt: sửa negative prompt không làm hàng nào bẩn.

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
  for p in user_id type status platform visibility; do
    npx wrangler vectorize create-metadata-index $ix --property-name=$p --type=string
  done
done
```

`type` phân biệt ba loại vector (`idea` | `variant` | `hook`) dùng chung một index.
**Thêm nó vào một index đã có dữ liệu thì mọi vector cũ không mang `type` sẽ bị filter
loại ra** — tìm kiếm trả rỗng, im lặng, không lỗi. Cách sửa duy nhất là upsert lại toàn
bộ, và đã có sẵn đường cho việc đó:

```bash
curl -X POST https://cf-videa.pages.dev/api/admin/reindex \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: none' -d '{"scope":"all"}'
```

Việc tạo metadata index là **bất đồng bộ** — lệnh trên chỉ trả về "enqueued". Đo thật:
mất tới **~90 giây** để các property hiện ra. Phải poll cho đến khi đủ 5, **rồi mới**
tạo ý tưởng đầu tiên:

```bash
until [ "$(npx wrangler vectorize list-metadata-index videa-ideas \
           | grep -cE 'user_id|type|status|platform|visibility')" -ge 5 ]; do
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
npm run db:remote                 # chạy lần lượt migrations/*.sql lên videa-db
npm run db:remote:preview         # tương tự, lên videa-db-preview

npx wrangler pages project create cf-videa --production-branch=main
npx wrangler pages secret put ADMIN_TOKEN               # production
npx wrangler pages secret put ADMIN_TOKEN --env preview
```

`scripts/repair/` không nằm trong chuỗi trên và `npm run db:remote` không chạm tới. Đó là
script vá một lần cho database đã tồn tại; database dựng mới từ `migrations/` không cần và
sẽ lỗi nếu chạy. Mỗi file tự nói rõ nó vá gì trong phần đầu.

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

### Index vector là thao tác THỦ CÔNG, và đó là chủ ý

Tạo và sửa ý tưởng, biến thể hay hook đều **chỉ ghi D1**. Không nhúng, không gọi Workers
AI, không đụng Vectorize. Việc index dồn lại cho tới khi người dùng bấm nút.

**Chỉ có MỘT nút trong giao diện:**

| Nút | Ở đâu | Làm gì |
|---|---|---|
| **Index** | trên từng thẻ ý tưởng / biến thể / hook | index ĐÚNG mục đó, và **kiểm tra trùng** (chỉ với ý tưởng) |

Thanh "Đồng bộ index" hàng loạt trên trang kho ý tưởng đã bị bỏ: mỗi mục đã có nút Index
riêng, nên thanh đó chỉ làm lại đúng việc ấy mà không kiểm tra trùng và không nói được
mục nào vừa xong. Đối soát hàng loạt vẫn còn, nhưng chỉ là đường bảo trì cho admin
(`POST /api/admin/reindex`).

Nút Index từng mục **không** dùng lại `reconcile(limit=1)`, và đó là điểm dễ sai nhất
của tính năng này: worklist của `reconcile` sắp theo `updated_at`, nên nó sẽ index một
hàng bẩn *nào đó* chứ không phải hàng người dùng vừa bấm — người dùng thấy nút chạy xong
mà thẻ của mình vẫn "chưa index". `indexOne()` trong `src/vec/sync.ts` là đường riêng cho
việc này, và `test/sync.test.ts` có một hồi quy khoá chặt đúng hành vi đó.

Lý do: một lần nhúng tốn một lời gọi Workers AI và vài trăm mili giây cho mỗi lần
lưu, trong khi người ta thường sửa đi sửa lại vài lần trước khi ưng — mỗi lần như vậy
đều đốt một lời gọi cho bản nháp sẽ bị ghi đè ngay sau đó. Gom lại một lần rẻ hơn hẳn
và làm thao tác lưu nhanh hơn nhiều.

**Hai loại "chưa đồng bộ", và loại thứ hai không tốn lời gọi AI nào:**

| Thay đổi | Cột lệch | Việc đồng bộ phải làm |
|---|---|---|
| Sửa tiêu đề, kịch bản, niche, tag, nền tảng, **hoặc biến thể** | `embedded_hash` ≠ `content_hash` | nhúng lại rồi upsert |
| Chỉ đổi **trạng thái** ý tưởng, hoặc **danh mục** của hook | `indexed_meta_hash` ≠ chữ ký hiện tại | lấy lại vector cũ, ghi đè metadata |

Cả ba bảng đều có đúng bộ cột này, và **hằng `*_DIRTY_SQL` trong TS phải khớp CHÍNH XÁC
mệnh đề `WHERE` của partial index tương ứng trong SQL** — lệch một ký tự là SQLite âm
thầm bỏ qua index và quét toàn bảng, không báo gì.

Loại thứ hai là cái bẫy: `status` nằm trong metadata của vector nhưng KHÔNG nằm trong
văn bản đem đi nhúng, nên đổi trạng thái không làm `content_hash` đổi. Nếu chỉ dựa vào
`content_hash` để biết hàng nào cần đồng bộ thì metadata trên Vectorize sẽ mốc lại
vĩnh viễn và `/api/search?status=…` lọc sai mà không có dấu hiệu gì. Cột
`indexed_meta_hash` (migrations/0004) tồn tại chỉ để bịt chỗ đó.

Trạng thái "chưa index" hiện thẳng trên từng thẻ (chip `pending` cạnh nút Index), nên
người dùng thấy đúng mục nào còn thiếu thay vì một con số tổng. `GET /api/sync` vẫn còn
để soi tổng số hàng bẩn theo từng loại — smoke test và chẩn đoán tay dùng nó.

### Kiểm tra ý tưởng trùng — cảnh báo, không chặn

Bấm **Index** trên một ý tưởng thì ngay trước khi upsert, vector vừa nhúng được đem đi
truy vấn lại kho ý tưởng *của chính bạn*; cái nào vượt `DUP_THRESHOLD` (0.90, khai báo ở
`src/vec/sync.ts`) sẽ về trong trường `duplicates` kèm tiêu đề và điểm giống.

**Trước khi upsert, không phải sau.** Làm sau thì luôn ra rỗng: Vectorize mất khoảng một
phút mới truy vấn được vector vừa ghi (mục 2 ở đầu README), nên ý tưởng vừa index sẽ chưa
kịp thấy ai mà cũng chưa ai thấy nó.

**Cảnh báo chứ không chặn.** Hàng đã nằm trong D1 rồi; chặn ở bước index chỉ để lại một ý
tưởng vĩnh viễn không tìm được. Giữ hay bỏ là quyết định của người dùng, nên giao diện đưa
danh sách kèm liên kết đi tới từng ý tưởng.

**Giới hạn phải biết:** hai ý tưởng index cách nhau dưới một phút sẽ **không** phát hiện
được nhau, vì cái trước chưa truy vấn được. Giao diện nói thẳng điều này trong khối cảnh
báo thay vì để người dùng tưởng tính năng hỏng. Vì cùng lý do đó, kiểm tra trùng chỉ chạy
ở nút Index của từng mục — đối soát hàng loạt xử lý tới 50 hàng một lượt, phần lớn
chưa kịp nhìn thấy nhau, và 50 cảnh báo cùng lúc cũng không ai đọc.

Lỗi ở bước kiểm tra trùng KHÔNG làm hỏng việc index: nó là tiện ích, còn đưa được vector
lên Vectorize mới là việc người dùng vừa bấm nút để làm.

### Kết hợp: gốc + biến thể + hook → một ý tưởng gốc MỚI

`POST /api/ideas/combine` nhận `{idea_id, variant_id, hook_id?}` và **ghi một hàng `ideas`
mới**, khác hẳn `GET /api/prompt` vốn chỉ ghép ra chuỗi rồi thôi. Ba cột
`source_idea_id` / `source_variant_id` / `source_hook_id` (migration 0006) ghi lại xuất xứ.

**Có hai lối vào cùng một endpoint.** Khối kết hợp nằm ở cả trang một ý tưởng
(`/idea`, ý tưởng gốc là trang đang mở) lẫn trang gợi ý (`/recommend`, chọn ý tưởng từ
toàn kho qua `/api/ideas/titles`). Trang gợi ý là nơi bạn vừa nhìn thấy một ý tưởng cũ
đáng làm lại, nên ghép được ngay tại đó; tạo xong thì **ở lại trang** kèm liên kết tới ý
tưởng mới, để ghép tiếp từ cùng danh sách mà không mất chỗ đang đọc.

Cả hai nơi đều nạp lại ô biến thể khi đổi ý tưởng: biến thể thuộc về một ý tưởng, và
`src/combine.ts` từ chối cặp không khớp bằng `variant_mismatch` — chặn ở giao diện thì
người dùng không bao giờ phải gặp lỗi 400 đó. Ý tưởng chưa có biến thể nào thì hai nút bị
vô hiệu hoá **kèm lý do**, không để nút chết câm.

**POST chứ không GET** vì nó ghi dữ liệu — `SameSite=Lax` vẫn gửi cookie theo điều hướng
GET ở cấp cao nhất, nên quy tắc "không endpoint GET nào được thay đổi dữ liệu"
(`src/http/guard.ts`) là bắt buộc, không phải sở thích.

Vài quyết định đáng nhớ:

- **Dàn ý của ý tưởng mới là văn bản thuần**, không phải chuỗi prompt đã ghép. Nhãn cấu
  trúc của mẫu ("## Style notes", "Vertical 9:16"…) là chỉ dẫn cho công cụ dựng video;
  nhét vào đây thì mọi ý tưởng kết hợp mang chung một khối chữ và vector của chúng xúm
  lại quanh một điểm. Hook đi vào dàn ý vì bảng `ideas` không còn cột hook từ 0005 — và
  như vậy hook cũng thành một phần văn bản nhúng, đúng như mong đợi.
- **`ON DELETE SET NULL` chứ không CASCADE** trên ba cột lineage: xoá ý tưởng nguồn không
  được kéo theo ý tưởng đã kết hợp. Sau khi lưu nó là một ý tưởng độc lập; lineage chỉ là
  ghi chú xuất xứ, không phải quan hệ sở hữu.
- **Trạng thái luôn quay về `idea`**, kể cả khi ý tưởng nguồn đã quay xong và đăng rồi.
- **Biến thể phải thuộc đúng ý tưởng gốc được chọn** — quy tắc kế thừa dàn ý (`{{script}}`)
  chỉ có nghĩa khi hai thứ đó là một cặp. Muốn cho phép trộn chéo thì bỏ đúng một phép
  kiểm tra trong `src/combine.ts`.

### Bảo trì định kỳ — không có cron, và đó là chủ ý

Pages Functions không có cron trigger. Dự án **cố ý không** dựng Worker riêng chỉ để có
lịch: việc dọn dẹp bám theo lưu lượng thay vì theo đồng hồ.

| Việc | Chạy khi nào |
|---|---|
| Xoá phiên đã hết hạn | ~5% số lần đăng nhập, ngoài luồng phản hồi |
| Xoá bộ đếm rate limit của cửa sổ đã qua | như trên |
| Rút hàng đợi vector mồ côi (`vector_gc`) | như trên |
| Index ý tưởng chưa được embed | **người dùng bấm nút "Index" của từng mục** |

Việc thứ tư cố ý để thủ công: nó là thứ người dùng nhìn thấy kết quả và biết khi nào
cần, còn ba việc kia thì không ai quan tâm miễn là chúng có xảy ra.

`GET /api/health` trả `maintenance_last_run_at` và `maintenance_last_source`
(`auto` hoặc `manual`) — không có lịch thì đó là cách duy nhất biết việc dọn còn diễn
ra hay đã ngừng. Cố ý **không** có cờ "quá hạn": việc dọn bám theo lưu lượng nên mọi
ngưỡng thời gian đều tùy tiện. Con số đáng theo dõi là `dirty_ideas`, `dirty_variants`,
`dirty_hooks` và `gc_pending` — chúng nói thẳng còn tồn đọng bao nhiêu. Cả bốn dùng chung
đúng những hằng `*_DIRTY_SQL` mà `/api/sync` dùng, nên hai endpoint không thể lệch nhau.

Muốn quét toàn bộ ngay thay vì chờ lưu lượng:

```bash
curl -X POST https://cf-videa.pages.dev/api/admin/maintenance \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: none' -d '{}'
```

## Kiến trúc

```
public/          Frontend tĩnh — HTML + ES module thuần, KHÔNG có bước build
functions/       Entrypoint Pages Functions, đúng 3 dòng
src/             Toàn bộ logic. Không import gì từ Pages.
  router.ts      Một router Hono duy nhất — đây là chỗ nối cho tính di động
  worker.ts      Entrypoint Worker, chưa dùng, giữ sẵn để chuyển nền sau này
  combine.ts     Kết hợp gốc + biến thể + hook thành ý tưởng gốc mới. Tách khỏi
                 routes/ vì đây là nghiệp vụ chứ không phải chuyện HTTP — và vì
                 tách ra thì kiểm thử được thẳng, không phải dựng phiên giả.
migrations/      Schema D1 — chạy tuần tự, dựng được database mới từ số 0
scripts/repair/  Script vá một lần cho database đã có, KHÔNG nằm trong chuỗi migration
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

**Không cần Queues, cũng không cần cron.** Cột `embedded_hash` chính LÀ hàng đợi thử lại, và đếm được bằng một câu
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
- **Ghi nhớ đăng nhập** đổi cả hai đầu, không chỉ giao diện: có tích thì phiên 30 ngày và
  cookie mang `Max-Age` nên sống qua lần đóng trình duyệt; không tích thì phiên 12 giờ và
  cookie **không** có `Max-Age`, tức là cookie phiên và trình duyệt tự xoá khi đóng. Cờ
  này lưu trên hàng phiên vì lúc gia hạn trượt phải biết phát lại cookie kiểu nào.
  Mặc định khi không nói gì là **không** ghi nhớ (fail-safe); riêng lúc đăng ký thì mặc
  định có, vì người vừa tự tạo tài khoản gần như luôn ở máy riêng.
- **Trần cứng 90 ngày** tính từ lúc tạo phiên, không bao giờ gia hạn, áp cho cả hai kiểu.
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
| GET | `/api/health` | — | Kiểm tra D1 + binding; trả `dirty_ideas`, `dirty_variants`, `dirty_hooks`, `gc_pending`, `maintenance_last_run_at` |
| POST | `/api/auth/register` | — | `{email, password, display_name?}` |
| POST | `/api/auth/login` | — | `{email, password}` |
| POST | `/api/auth/logout` | ✓ | |
| GET | `/api/auth/me` | ✓ | |
| POST | `/api/auth/change-password` | ✓ | Thu hồi mọi phiên khác |
| GET | `/api/auth/sessions` | ✓ | |
| DELETE | `/api/auth/sessions/:id` | ✓ | |
| POST | `/api/auth/revoke-all` | ✓ | Giữ lại phiên hiện tại |
| GET | `/api/ideas` | ✓ | Lọc + tìm từ khoá, phân trang keyset |
| POST | `/api/ideas` | ✓ | **Chỉ ghi D1**, không nhúng, không đụng Vectorize |
| POST | `/api/ideas/:id/index` | ✓ | Index đúng ý tưởng đó; trả `duplicates` nếu thấy ý tưởng gần trùng |
| POST | `/api/ideas/combine` | ✓ | `{idea_id, variant_id, hook_id?, title?}` → **ý tưởng gốc MỚI** có lineage |
| GET · POST | `/api/hook-categories` | ✓ | Danh mục hook; trùng tên trả 400 |
| PATCH · DELETE | `/api/hook-categories/:id` | ✓ | Xoá danh mục KHÔNG xoá hook bên trong |
| GET · POST | `/api/hooks` | ✓ | `?category=<id>` hoặc `?category=none`; `text` tối đa 2000 ký tự |
| PATCH · DELETE | `/api/hooks/:id` | ✓ | |
| POST | `/api/hooks/:id/index` | ✓ | Index đúng hook đó |
| GET | `/api/ideas/titles` | ✓ | id + tiêu đề mọi ý tưởng cho ô chọn; trần 500 kèm cờ `truncated` |
| GET | `/api/variants` | ✓ | **Kho biến thể** — toàn bộ biến thể, kèm `idea_title`; `?idea=` `?q=` `?cursor=` |
| GET · POST | `/api/ideas/:id/variants` | ✓ | Biến thể của MỘT ý tưởng gốc |
| PATCH · DELETE | `/api/variants/:id` | ✓ | |
| POST | `/api/variants/:id/index` | ✓ | Index đúng biến thể đó |
| GET | `/api/prompt` | ✓ | `?variant_id=&hook_id=` — hook để trống vẫn ghép được |
| GET · PUT · DELETE | `/api/prompt-template` | ✓ | Đọc / lưu / đưa về mặc định |
| GET · PATCH · DELETE | `/api/ideas/:id` | ✓ | 404 khi không phải của bạn |
| POST · DELETE | `/api/ideas/:id/like` | ✓ | Idempotent |
| GET | `/api/ideas/:id/similar` | ✓ | Dùng lại vector đã lưu |
| GET | `/api/search` | ✓ | Ngữ nghĩa; lùi về từ khoá khi AI/Vectorize hỏng |
| GET | `/api/recommendations` | ✓ | `basis: likes \| cold_start` |
| GET | `/api/tags` | ✓ | |
| GET | `/api/sync` | ✓ | Chỉ đọc: `dirty` (tổng) + `by_type` cho ý tưởng / biến thể / hook |
| POST | `/api/admin/reindex` | `ADMIN_TOKEN` | `{scope: dirty\|all\|user}` — cũng là công cụ đổi model |
| POST | `/api/admin/maintenance` | `ADMIN_TOKEN` | Quét toàn bộ một lần: dọn phiên, rate limit, vector mồ côi, đối soát index |

## Giao diện

**HTML tĩnh + ES module thuần, không có bước build** — xem phần Frontend ở trên.

**Nút "Index" trong `ideaCard` có trình xử lý dùng chung ở `ui.js` (`bindIndexButtons`).**
Bắt buộc phải vậy: `ideaCard` render ra ở BỐN trang — `/app`, `/search`, `/recommend` và
mục "Ý tưởng tương tự" của `/idea` — và đã từng có giai đoạn chỉ `/app` viết trình xử lý,
nên ba trang kia hiện một cái nút bấm vào không có gì xảy ra. Nút vẫn có nghĩa ở cả ba:
`/search` lùi về tìm từ khoá và `/recommend` lùi về `cold_start` đều đọc thẳng D1 nên trả
về được ý tưởng chưa index.

Sau khi index xong, hàm này **cập nhật đúng thẻ vừa bấm tại chỗ** chứ không tải lại danh
sách — trên `/search` một lần tải lại là một lần nhúng câu truy vấn, tốn lời gọi Workers AI
và ăn vào rate limit; trên `/recommend` thì danh sách nhảy làm mất chỗ đang đọc.

Thanh điều hướng có đúng ba kho — **Ý tưởng gốc**, **Biến thể**, **Hook** — rồi mới tới Tìm
kiếm, Gợi ý và Tài khoản.

**Chuyển sáng/tối.** Nút trên thanh điều hướng (và trên trang đăng nhập/đăng ký) chạy
vòng: theo hệ thống → sáng → tối. Giữ lại lựa chọn "theo hệ thống" chứ không chỉ hai
trạng thái, vì đó là hành vi mặc định trước đây.

Lựa chọn lưu ở `localStorage` và được áp bởi `public/js/theme-init.js` — một script
**cổ điển, nạp đồng bộ trong `<head>`**, không phải module và không `defer`. Lý do: nó
phải chạy xong trước khung hình đầu tiên, nếu không người chọn nền tối sẽ thấy một
nháy trắng mỗi lần mở trang. Không nhét inline được vì CSP đặt `script-src 'self'`
không có `unsafe-inline`, nên một file riêng là cách giữ CSP nghiêm ngặt mà vẫn kịp.

CSS khai báo bảng màu sáng đầy đủ trên `:root`, rồi ghi đè hai lần: dưới
`@media (prefers-color-scheme: dark)` có chốt `:root:not([data-theme="light"])`, và
dưới `:root[data-theme="dark"]`. Không màu nào chỉ tồn tại bên trong media query —
nếu thế thì ép sáng trên máy đang để chế độ tối sẽ ra biến rỗng.

**iPhone 16 Pro (402×874, DPR 3).** Đã kiểm chứng bằng Chromium ở đúng khung đó:

- `viewport-fit=cover` + `env(safe-area-inset-*)` để nội dung không chui xuống dưới
  Dynamic Island hay bị thanh home che.
- **Ô nhập cố định 16px.** Dưới ngưỡng này iOS Safari **tự phóng to trang** khi chạm
  vào ô nhập và người dùng phải tự thu lại. Đây là lý do duy nhất cỡ chữ đó bị ghim.
- Mọi nút, liên kết điều hướng và ô đánh dấu cao tối thiểu 44px.
- `100dvh` thay cho `100vh`: trên iOS Safari `100vh` tính cả phần bị thanh địa chỉ che
  nên đáy trang bị cắt.
- Bảng phiên đăng nhập xếp lại thành danh sách dọc dưới 560px — bảng ba cột trên màn
  402px chỉ còn cách cuộn ngang hoặc bóp chữ, cả hai đều tệ hơn.
- Thanh điều hướng dính trên đỉnh, cuộn ngang được, và giấu email khi màn hẹp.

## Trạng thái đang chạy

| Thứ | Ở đâu |
|---|---|
| Production | https://cf-videa.pages.dev — `env: production`, D1 `videa-db`, index `videa-ideas` |
| Preview (nhánh này) | https://claude-friendly-goodall-xtch.cf-videa.pages.dev — D1 `videa-db-preview`, index `videa-ideas-preview` |
**Metadata index `type`: đã tạo xong trên cả hai index** (2026-09-03), đã poll xác nhận đủ
5 property. Đây là điều kiện tiên quyết vì `queryIdeas` lọc `type = 'idea'`: vector nào
không mang `type` sẽ bị loại khỏi kết quả — im lặng, không lỗi.

| Index | vectorCount lúc thêm `type` | Hệ quả |
|---|---:|---|
| `videa-ideas` (production) | 0 | Không có gì để mất |
| `videa-ideas-preview` | 5 | 5 vector cũ không mang `type` → vô hình cho tới khi index lại |

Năm vector cũ ở preview **tự lành**: migration `0007` đặt `embedded_hash` của mọi ý tưởng
về NULL, nên lần đồng bộ kế tiếp sẽ upsert đè lên đúng những id đó, lần này có `type`. Id
vector của ý tưởng là id trần không tiền tố nên chúng khớp nhau — đó là một lý do nữa để
ý tưởng KHÔNG đổi sang id có tiền tố.

Đã xoá metadata index thừa tên `kind` khỏi `videa-ideas-preview` (2026-09-03) — di sản của
nhánh thiết kế bị loại, vốn dùng `kind` thay cho `type`. Hai index nay giống hệt nhau, đúng
5 property. Lệnh xoá cũng bất đồng bộ như lệnh tạo, phải poll mới biết đã xong:
`wrangler vectorize delete-metadata-index <index> --propertyName=<tên>`.

**Migration `0006` và `0007`: đã chạy trên cả hai database** (2026-09-03), đã xác minh bằng
`schema_migrations` và `pragma_table_info`. Trạng thái ngay sau đó:

| Database | Nội dung | Bẩn sau `0007` |
|---|---|---|
| `videa-db` (production) | 1 user, 0 ý tưởng | 0 / 0 / 0 |
| `videa-db-preview` | 6 user, 5 ý tưởng, 2 biến thể, 2 hook | 5 ý tưởng, 2 biến thể, 2 hook |

Số bẩn ở preview là đúng như thiết kế: `0007` đặt `embedded_hash` của mọi ý tưởng về NULL,
còn hai bảng mới sinh ra với `content_hash = ''`. Một lượt `POST /api/admin/reindex` sau khi
deploy sẽ rút cạn cả chín mục (hoặc bấm Index trên từng mục).

⚠️ **`npm run db:remote` chạy LẠI toàn bộ `migrations/*.sql`, không chỉ file mới.** Trên một
database đã tồn tại, `0001`–`0005` sẽ lỗi ("table already exists", "duplicate column") rồi
vòng lặp vẫn đi tiếp — không mất dữ liệu, nhưng một bức tường lỗi khiến rất khó thấy hai file
mới có áp được hay không. Với database đã có sẵn thì áp thẳng từng file:

```bash
npx wrangler d1 execute videa-db --remote --file=./migrations/0006_negative_prompt_and_lineage.sql
npx wrangler d1 execute videa-db --remote --file=./migrations/0007_index_hooks_variants.sql
```

Kiểm tra trước bằng `SELECT version FROM schema_migrations ORDER BY applied_at;` để biết
database đang thiếu đúng những file nào. (Lưu ý khi tự viết truy vấn kiểm tra: LIKE của SQLite
chỉ hiểu `%` và `_`, không có lớp ký tự `[]` — `LIKE '000[67]%'` khớp rỗng chứ không báo lỗi.)

**Đã deploy lên preview và kiểm chứng với Vectorize + Workers AI thật** (2026-09-03):
`npm run smoke` chạy với `BASE=` bản deploy cho **84 đạt / 0 hỏng**, và lần này nhánh
"Vectorize dùng được" được chọn — tức là index từng mục cho ý tưởng, biến thể và hook đều
thật sự lên tới Vectorize, và `/api/sync` về 0 sau đó.

Phép kiểm quan trọng nhất là tìm kiếm ngữ nghĩa trả về **có kết quả**: nếu vector không mang
metadata `type` thì filter `type = 'idea'` sẽ khớp rỗng, và `/api/search` vẫn báo
`mode: "vector"` nhưng không có mục nào — hỏng hoàn toàn im lặng, không lỗi, không log. Đo
thật: vector truy vấn được sau **~15 giây**, nhanh hơn con số ~68 giây ghi ở mục 2 (một lần
đo, không phải mức bảo đảm — cứ tiếp tục nói với người dùng là "khoảng một phút").

`wrangler pages deploy` không kèm `--branch` sẽ theo nhánh git hiện tại, nên từ một nhánh
không phải `main` nó ra **preview**, dùng `env.preview` (`videa-db-preview` +
`videa-ideas-preview`). Muốn lên production thì merge vào `main` rồi deploy từ đó.

## Kiểm thử

Ưu tiên đúng chỗ thay vì phủ đều:

- **`npm test`** (vitest chạy trong workerd thật với D1 thật) tập trung vào nơi một lỗi sẽ
  *im lặng và nguy hiểm*: băm/kiểm tra mật khẩu, vòng đời phiên, **ma trận cách ly đa người
  dùng**, và phần kế toán đồng bộ Vectorize (dùng Vectorize giả trong bộ nhớ).
- **`npm run smoke`** kiểm tra toàn bộ luồng HTTP bằng curl, chạy được cả với `pages dev`
  lẫn với bản đã deploy. Vectorize **không chạy được ở local** (`wrangler pages dev` báo
  "Binding VEC needs to be run remotely"), nên phần index tự dò: chạy với bản đã deploy thì
  khẳng định index thật sự xong, chạy local thì khẳng định *hợp đồng khi hỏng* — endpoint
  vẫn trả 200, nói thẳng `indexed:false`, và hàng **ở lại** trạng thái bẩn. Báo đã xong
  trong khi chưa xong mới là thứ không chấp nhận được.
- **Hồi quy đáng giá nhất** nằm ở `test/sync.test.ts`: dựng ba ý tưởng bẩn, bấm index đúng
  một cái, rồi khẳng định hai cái kia VẪN bẩn. Đó là cái bẫy `reconcile(limit=1)` mô tả ở
  mục "Index vector là thao tác THỦ CÔNG".
- `test/dup.test.ts` khẳng định về *hành vi* của việc kiểm tra trùng — trùng thì báo, khác
  thì không, và **không bao giờ báo qua tài khoản khác** (một cảnh báo trùng làm lộ tiêu
  đề) — chứ không khẳng định một điểm số cụ thể.
- Cố ý **không** test chất lượng embedding hay khẳng định điểm tương đồng cụ thể — đó là
  thuộc tính của một model được host, có thể đổi bất cứ lúc nào. Chỉ khẳng định về *thứ hạng*
  và về *cách ly*.
