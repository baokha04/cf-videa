# cf-videa

Kho ý tưởng short video có quản lý tài khoản, chạy trên Cloudflare Pages + D1 + Vectorize.

Mỗi người dùng có kho ý tưởng riêng (tiêu đề, hook, dàn ý kịch bản, ý tưởng gốc, prompt
công thức, negative prompt, danh mục video hook, nền tảng, niche, tag, trạng thái), tìm
được **theo ý nghĩa** chứ không chỉ theo từ khoá, và được gợi ý lại những ý tưởng cũ hợp
gu mà mình đã quên. Mỗi ý tưởng gốc còn đẻ ra được một **danh mục ý tưởng biến thể** kế
thừa sẵn nguyên liệu của bản gốc.

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

Nghĩa là sau khi bấm "Đồng bộ index", vẫn phải chờ thêm khoảng một phút nữa thì ý tưởng
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
  for p in user_id status platform visibility kind; do
    npx wrangler vectorize create-metadata-index $ix --property-name=$p --type=string
  done
done
```

Việc tạo metadata index là **bất đồng bộ** — lệnh trên chỉ trả về "enqueued". Đo thật:
mất tới **~90 giây** để cả 5 property hiện ra. Phải poll cho đến khi đủ 5, **rồi mới**
tạo ý tưởng đầu tiên:

```bash
until [ "$(npx wrangler vectorize list-metadata-index videa-ideas \
           | grep -cE 'user_id|status|platform|visibility|kind')" -ge 5 ]; do
  echo "chờ metadata index..."; sleep 15
done
```

**Nếu index của bạn đã có dữ liệu từ trước migration 0005:** `kind` là property mới, nên
phải tạo metadata index cho nó **trước** lần đồng bộ kế tiếp. Vector ghi trước khi index
đó tồn tại sẽ không nằm trong nó, và `/api/search?kind=…` sẽ lọc hụt mà không báo lỗi.
Migration 0005 cố ý để mọi hàng đã index thành "bẩn metadata" nên chỉ cần bấm
**"Đồng bộ index"** một lần sau khi metadata index sẵn sàng — loại bẩn này dùng lại
vector đã lưu nên **không tốn một lời gọi Workers AI nào**.

Hai cái bẫy nữa của CLI, cả hai đều hỏng âm thầm:

- `wrangler vectorize info` báo `vectorCount` **có độ trễ** — nó phản ánh trạng thái tại
  `processedUpToDatetime`, không phải hiện tại. Đừng dùng nó để khẳng định index rỗng hay
  đầy ngay sau khi ghi.
- `wrangler vectorize delete-vectors --ids=a,b` **không phải** là xoá hai vector: cả chuỗi
  bị hiểu là MỘT id và lệnh lỗi `id too long; max is 64 bytes`. Phải lặp lại cờ:
  `--ids=a --ids=b`. Lỗi in ra stderr nên rất dễ trôi qua trong script.

`visibility` được index dù v1 chưa dùng — lý do ở mục 2 phía trên.

### Migration và secret

Chạy **tất cả** file trong `migrations/` theo đúng thứ tự tên, không phải mỗi
`0001_init.sql` — mỗi migration về sau đều thêm cột hoặc bảng mà code hiện tại cần:

```bash
for db in videa-db videa-db-preview; do
  for f in migrations/*.sql; do
    npx wrangler d1 execute "$db" --remote --file="$f"
  done
done

npx wrangler pages project create cf-videa --production-branch=main
npx wrangler pages secret put ADMIN_TOKEN               # production
npx wrangler pages secret put ADMIN_TOKEN --env preview
```

---

## Phát triển

```bash
npm run db:local                  # chạy hết migrations/*.sql lên D1 local
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

### Kho ý tưởng: nguyên liệu, danh mục hook và danh mục biến thể

Một ý tưởng không chỉ là tiêu đề với dàn ý. Ba trường nguyên liệu tách riêng thay vì gộp
chung vào `script_outline`:

| Trường | Là gì | Vì sao tách riêng |
|---|---|---|
| `source_idea` | Ý tưởng gốc, giữ **nguyên văn** như lúc nghĩ ra hoặc chép về | Dàn ý bị viết lại liên tục; bản gốc phải còn nguyên để đối chiếu và để đẻ biến thể |
| `prompt_recipe` | Prompt **công thức**, viết một lần rồi dán lại | Nó thuộc về cách *sản xuất*, không phải nội dung — và tái dùng nguyên văn cho nhiều ý tưởng |
| `negative_prompt` | Thứ **không** được xuất hiện | Cùng lý do trên, và nó là dấu trừ nên càng không được lẫn vào nội dung |

**Danh mục video hook** (`idea_hooks`) là nhiều cách mở đầu cho cùng một ý tưởng. Cột
`ideas.hook` cũ vẫn là hook *đang dùng* — thứ hiện trên thẻ; bảng mới giữ những cách mở
đầu khác đã nghĩ ra, để thử qua thử lại mà không mất bản cũ. Thứ tự do người dùng sắp và
được giữ nguyên (cột `position`), **không** sắp lại theo bảng chữ cái như tag: hook đầu
danh sách thường là hook đang ưng nhất.

Mỗi hook có **id riêng** và có endpoint riêng để thêm, sửa, xoá, đổi thứ tự. Ban đầu cả
danh mục là một ô nhiều dòng gửi kèm khi bấm "Lưu"; cách đó không có khái niệm "một
hook" — sửa một dòng là ghi đè cả danh mục, và hai tab mở cùng lúc thì tab lưu sau xoá
sạch việc của tab kia. Mảng `hooks` trong body của `POST`/`PATCH /api/ideas` vẫn còn để
gieo sẵn cả danh mục trong một lần gọi, nhưng **giao diện không dùng nó nữa**: có hai
đường ghi cho cùng một thứ thì đường nào lưu sau sẽ nuốt đường kia.

> ⚠️ **Bất biến dễ vỡ nhất của tính năng này.** Hook nằm trong văn bản đem đi nhúng
> nhưng ở bảng khác, nên thêm/sửa/xoá/đổi thứ tự một hook làm nội dung ý tưởng đổi mà
> **không một cột nào của bảng `ideas` nhúc nhích**. Vì vậy mọi route trong
> `src/routes/hooks.ts` đều phải gọi `rehashIdea()` (`src/vec/sync.ts`) sau khi ghi.
> Quên một chỗ thì `content_hash` giữ nguyên, hàng vẫn hiện là "đã index", và vector
> trên Vectorize mốc lại vĩnh viễn mà không có dấu hiệu gì. `rehashIdea()` dùng chung
> `buildEmbedText()` với lúc đối soát nên hash hai đường không thể lệch nhau — có test
> khoá cả hai điều này.

Đổi thứ tự ghi lại **toàn bộ** `position` chứ không hoán đổi hai hàng. Dài dòng hơn,
nhưng nó chuẩn hoá luôn các `position` trùng hoặc thủng lỗ do lịch sử để lại — mà hoán
đổi hai hàng thì không sửa được, thậm chí kẹt vĩnh viễn khi hai hàng cạnh nhau có cùng
`position`.

**Danh mục ý tưởng biến thể** nằm **cùng bảng** `ideas`, phân biệt bằng `kind`
(`origin` | `variant`) và `parent_id`. Không tách bảng riêng vì một biến thể vẫn phải tìm
được, thích được, index được và đổi trạng thái được y hệt một ý tưởng thường — tách bảng
là nhân đôi toàn bộ những thứ đó.

Cây đúng **một tầng**: cha của một biến thể luôn là ý tưởng gốc. Cây một tầng thì không
thể có chu trình, và danh mục biến thể luôn đọc được bằng đúng một truy vấn. Ràng buộc
này nằm **trong chính câu lệnh** `INSERT`/`UPDATE` (`PARENT_SQL` ở `src/db/ideas.ts`):
`parent_id` chỉ nhận giá trị khi hàng cha có thật, thuộc đúng user đang thao tác, bản
thân là `origin`, không phải chính hàng đang ghi, và hàng đang ghi chưa có biến thể nào
của riêng nó. `kind` được suy ra từ *chính truy vấn con đó*, nên cặp `(kind, parent_id)`
không bao giờ mâu thuẫn — không có biến thể mồ côi, kể cả khi hàng cha vừa bị xoá xong.
Route vẫn kiểm trước, nhưng chỉ để có thông báo lỗi tử tế; bỏ nó đi thì dữ liệu vẫn đúng.

`POST /api/ideas/:id/variants` chép sẵn ý tưởng gốc, công thức prompt, negative prompt,
niche, nền tảng và tag từ bản gốc sang — đó chính là điều làm nó là "biến thể" chứ không
phải một ý tưởng mới tinh. Cố ý **không** chép danh mục hook: hook là thứ người ta muốn
thử khác đi ở mỗi biến thể.

Danh mục biến thể quản lý được ngay tại chỗ: mỗi thẻ có **Sửa**, **Xoá** và **Đồng bộ**.
"Sửa" mở thẳng trang của biến thể chứ không sửa tại chỗ — một ý tưởng có cả chục trường,
nên một ô sửa nhanh vài trường là lời hứa nửa vời. "Xoá" dùng chung
`DELETE /api/ideas/:id` với nút xoá ở trang ý tưởng, nên nó cũng dọn vector trên
Vectorize y hệt; không có đường xoá thứ hai nào bỏ sót việc đó.

Xoá ý tưởng gốc là cascade xoá cả danh mục biến thể của nó. **Vectorize không biết gì về
cascade**, nên route xoá gom id các biến thể lại *trước* lệnh `DELETE`; không làm vậy thì
vector của chúng ở lại vĩnh viễn và chiếm chỗ trong `topK` của mọi truy vấn về sau.

### Index vector là thao tác THỦ CÔNG, và đó là chủ ý

Tạo và sửa ý tưởng **chỉ ghi D1**. Không nhúng, không gọi Workers AI, không đụng
Vectorize. Việc index dồn lại cho tới khi người dùng bấm **"Đồng bộ index"** ở trang
kho ý tưởng.

Lý do: một lần nhúng tốn một lời gọi Workers AI và vài trăm mili giây cho mỗi lần
lưu, trong khi người ta thường sửa đi sửa lại vài lần trước khi ưng — mỗi lần như vậy
đều đốt một lời gọi cho bản nháp sẽ bị ghi đè ngay sau đó. Gom lại một lần rẻ hơn hẳn
và làm thao tác lưu nhanh hơn nhiều.

**Hai loại "chưa đồng bộ", và loại thứ hai không tốn lời gọi AI nào:**

| Thay đổi | Cột lệch | Việc đồng bộ phải làm |
|---|---|---|
| Sửa tiêu đề, hook, kịch bản, **ý tưởng gốc**, **danh mục hook**, niche, tag, nền tảng | `embedded_hash` ≠ `content_hash` | nhúng lại rồi upsert |
| Chỉ đổi **trạng thái** hoặc **gốc ↔ biến thể** | `indexed_meta_hash` ≠ chữ ký hiện tại | lấy lại vector cũ, ghi đè metadata |

Loại thứ hai là cái bẫy: `status` (và từ 0005 là cả `kind`) nằm trong metadata của
vector nhưng KHÔNG nằm trong văn bản đem đi nhúng, nên đổi trạng thái không làm
`content_hash` đổi. Nếu chỉ dựa vào `content_hash` để biết hàng nào cần đồng bộ thì
metadata trên Vectorize sẽ mốc lại vĩnh viễn và `/api/search?status=…` lọc sai mà không
có dấu hiệu gì. Cột `indexed_meta_hash` (migrations/0004, mở rộng ở 0005) tồn tại chỉ
để bịt chỗ đó.

Chữ ký metadata được viết ở **ba nơi phải khớp nhau từng ký tự** — `META_SIG_SQL` trong
`src/db/ideas.ts`, `metaSignature()` trong `src/vec/index.ts`, và mệnh đề `WHERE` của
`idx_ideas_dirty` ở `migrations/0005`. Lệch một ký tự thì hàng hoặc bẩn vĩnh viễn, hoặc
không bao giờ được đồng bộ lại; lệch riêng ở index thì SQLite bỏ qua index và quét
toàn bảng.

**Hai trường cố ý KHÔNG đem đi nhúng:** `prompt_recipe` là công thức tái dùng, dán y hệt
nhau cho cả chục ý tưởng — nhúng vào thì "ý tưởng tương tự" biến thành "cùng dùng một
công thức". `negative_prompt` liệt kê thứ phải TRÁNH — nhúng vào là đọc dấu trừ thành
dấu cộng. Cả hai vẫn tìm lại được bằng tìm từ khoá trên D1, nên chúng không biến mất
khỏi tìm kiếm, chỉ không làm nhiễu không gian vector.

Thanh đồng bộ trên trang kho ý tưởng **luôn hiển thị**, kể cả khi đã sạch, và lấy số
đếm từ `GET /api/sync` chứ không đếm trên danh sách đang hiện — danh sách bị phân
trang và lọc, đếm trên đó sẽ bỏ sót ý tưởng nằm ngoài trang hiện tại.

**Mỗi ý tưởng còn có nút đồng bộ riêng** (`POST /api/ideas/:id/reindex`), trên từng thẻ
ở trang kho và trong trang chi tiết. Không dùng lại `reconcile(limit = 1)` cho việc này:
`reconcile` lấy hàng bẩn theo thứ tự `updated_at`, nên nó sẽ đồng bộ *một ý tưởng nào
đó* chứ không phải ý tưởng vừa được bấm — một nút gắn trên thẻ này mà đi làm việc cho
thẻ khác là thứ không giải thích được. Nút riêng cũng chọn đúng đường rẻ: hàng chỉ đổi
metadata dùng lại vector đã lưu và không tốn lời gọi AI nào; hàng đã sạch thì trả
`outcome: "clean"` và không làm gì cả.

### Bảo trì định kỳ — không có cron, và đó là chủ ý

Pages Functions không có cron trigger. Dự án **cố ý không** dựng Worker riêng chỉ để có
lịch: việc dọn dẹp bám theo lưu lượng thay vì theo đồng hồ.

| Việc | Chạy khi nào |
|---|---|
| Xoá phiên đã hết hạn | ~5% số lần đăng nhập, ngoài luồng phản hồi |
| Xoá bộ đếm rate limit của cửa sổ đã qua | như trên |
| Rút hàng đợi vector mồ côi (`vector_gc`) | như trên |
| Index ý tưởng chưa được embed | **người dùng bấm nút "Đồng bộ lại index"** |

Việc thứ tư cố ý để thủ công: nó là thứ người dùng nhìn thấy kết quả và biết khi nào
cần, còn ba việc kia thì không ai quan tâm miễn là chúng có xảy ra.

`GET /api/health` trả `maintenance_last_run_at` và `maintenance_last_source`
(`auto` hoặc `manual`) — không có lịch thì đó là cách duy nhất biết việc dọn còn diễn
ra hay đã ngừng. Cố ý **không** có cờ "quá hạn": việc dọn bám theo lưu lượng nên mọi
ngưỡng thời gian đều tùy tiện. Con số đáng theo dõi là `dirty_ideas` và `gc_pending` —
chúng nói thẳng còn tồn đọng bao nhiêu.

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
migrations/      Schema D1
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
| GET | `/api/health` | — | Kiểm tra D1 + binding; trả `dirty_ideas`, `gc_pending`, `maintenance_last_run_at` |
| POST | `/api/auth/register` | — | `{email, password, display_name?}` |
| POST | `/api/auth/login` | — | `{email, password}` |
| POST | `/api/auth/logout` | ✓ | |
| GET | `/api/auth/me` | ✓ | |
| POST | `/api/auth/change-password` | ✓ | Thu hồi mọi phiên khác |
| GET | `/api/auth/sessions` | ✓ | |
| DELETE | `/api/auth/sessions/:id` | ✓ | |
| POST | `/api/auth/revoke-all` | ✓ | Giữ lại phiên hiện tại |
| GET | `/api/ideas` | ✓ | Lọc (`status`, `platform`, `tag`, `kind`, `parent`) + tìm từ khoá, phân trang keyset |
| POST | `/api/ideas` | ✓ | **Chỉ ghi D1**, không nhúng, không đụng Vectorize |
| GET · PATCH · DELETE | `/api/ideas/:id` | ✓ | 404 khi không phải của bạn |
| POST · DELETE | `/api/ideas/:id/like` | ✓ | Idempotent |
| GET | `/api/ideas/:id/similar` | ✓ | Dùng lại vector đã lưu |
| GET | `/api/ideas/:id/variants` | ✓ | Danh mục ý tưởng biến thể của một ý tưởng gốc |
| POST | `/api/ideas/:id/variants` | ✓ | Tạo biến thể, kế thừa nguyên liệu của bản gốc |
| POST | `/api/ideas/:id/reindex` | ✓ | Nút đồng bộ của RIÊNG ý tưởng này |
| GET | `/api/ideas/:id/hooks` | ✓ | Danh mục video hook, kèm id và thứ tự từng mục |
| POST | `/api/ideas/:id/hooks` | ✓ | `{text}` — thêm vào cuối danh mục, tối đa 30 |
| PATCH | `/api/ideas/:id/hooks/:hookId` | ✓ | `{text}` — sửa đúng một mục |
| DELETE | `/api/ideas/:id/hooks/:hookId` | ✓ | Xoá một mục |
| POST | `/api/ideas/:id/hooks/:hookId/move` | ✓ | `{dir: up\|down}` — `moved:false` khi đã ở đầu/cuối |

Bốn endpoint hook sau cùng đều làm ý tưởng cha "bẩn" trở lại (xem cảnh báo ở mục kho ý
tưởng), nên chúng trả kèm `indexed: false` để giao diện cập nhật nhãn nút đồng bộ.
| GET | `/api/search` | ✓ | Ngữ nghĩa, lọc thêm được `kind`; lùi về từ khoá khi AI/Vectorize hỏng |
| GET | `/api/recommendations` | ✓ | `basis: likes \| cold_start` |
| GET | `/api/tags` | ✓ | |
| GET | `/api/sync` | ✓ | Đếm ý tưởng của chính mình chưa được index |
| POST | `/api/reindex` | ✓ | Đồng bộ cho chính mình, theo lô 50 |
| POST | `/api/admin/reindex` | `ADMIN_TOKEN` | `{scope: dirty\|all\|user}` — cũng là công cụ đổi model |
| POST | `/api/admin/maintenance` | `ADMIN_TOKEN` | Quét toàn bộ một lần: dọn phiên, rate limit, vector mồ côi, đối soát index |

## Giao diện

**HTML tĩnh + ES module thuần, không có bước build** — xem phần Frontend ở trên.

**Trang kho ý tưởng** có thêm bộ lọc **Danh mục** (tất cả / kho ý tưởng gốc / ý tưởng
biến thể), và **mỗi thẻ có nút đồng bộ index của riêng nó**. Nút trên thẻ dùng uỷ quyền
sự kiện ở cấp danh sách chứ không gắn thẳng vào từng nút: danh sách được render lại bằng
`innerHTML` sau mỗi lần lọc, tải thêm hay đồng bộ, nên handler gắn trực tiếp sẽ biến mất
cùng DOM cũ.

**Trang ý tưởng** có ô cho ba trường nguyên liệu, cộng hai mục quản lý nằm **ngoài**
form: danh mục video hook và danh mục ý tưởng biến thể. Cả hai chỉ hiện sau khi ý tưởng
đã được lưu — chưa có id thì chưa có gì để gắn hook hay biến thể vào.

**Danh mục video hook** là danh sách từng dòng: số thứ tự, ô sửa nội dung, và ba nút
`↑ ↓ Xoá`. Sửa xong bấm ra ngoài là lưu, dùng sự kiện `change` (chỉ bắn khi giá trị thực
sự đổi) thay vì thêm nút "Lưu" cho từng dòng — mỗi dòng đã có ba nút, thêm nút thứ tư thì
trên màn hình 402px không còn chỗ cho chính nội dung hook. Nút `↑` của dòng đầu và `↓`
của dòng cuối bị khoá sẵn. Trên màn hẹp, số thứ tự ở lại **cùng hàng** với ô nhập của nó
và chỉ đám nút xuống dòng: cho ô nhập xuống dòng riêng làm con số trôi xuống giữa hai
hook và trông như đang đánh số cho hook bên dưới.

Ý tưởng gốc có mục **Ý tưởng biến thể**, mỗi thẻ kèm **Sửa · Xoá · Đồng bộ** và một nút
tạo biến thể mới; biến thể thì thay vào đó hiện một dòng trỏ ngược về bản gốc và **không**
có mục biến thể của riêng nó — cây đúng một tầng, hiện một mục không bao giờ có gì chỉ
gây hiểu nhầm.

Cả hai danh mục dùng uỷ quyền sự kiện ở cấp danh sách, vì chúng được vẽ lại bằng
`innerHTML` sau mỗi thao tác nên handler gắn thẳng vào nút sẽ biến mất cùng DOM cũ. Sau
mỗi lần sửa hook, trang đọc lại **riêng** trạng thái index chứ không gọi lại `fill()`:
`fill()` vẽ lại cả danh mục hook, nên chữ đang gõ dở ở một dòng khác sẽ biến mất.

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
| Preview (nhánh này) | https://claude-account-management-sh.cf-videa.pages.dev — D1 `videa-db-preview`, index `videa-ideas-preview` |
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
