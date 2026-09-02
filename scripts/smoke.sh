#!/usr/bin/env bash
#
# Smoke test end-to-end. Chạy được cả với `wrangler pages dev` lẫn với bản đã deploy:
#   bash scripts/smoke.sh
#   BASE=https://cf-videa.pages.dev bash scripts/smoke.sh
#
# Vì sao không dùng cookie jar của curl: cookie phiên có tiền tố __Host- nên bắt
# buộc mang cờ Secure, và curl từ chối gửi cookie Secure qua http:// (trình duyệt
# thì có ngoại lệ cho localhost, curl thì không). Nên script tự bắt token từ header
# Set-Cookie rồi gửi lại bằng -H "Cookie: ...". Cách này không phụ thuộc vào hành vi
# cookie của client, và vì thế cũng chạy đúng như nhau ở local lẫn production.

set -uo pipefail

BASE="${BASE:-http://localhost:8788}"
COOKIE_NAME="${COOKIE_NAME:-__Host-videa_sid}"
PASS=0
FAIL=0

c_ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
c_bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# expect <mô tả> <mong đợi> <thực tế>
expect() {
  if [ "$2" = "$3" ]; then c_ok "$1"; else c_bad "$1 (mong $2, nhận $3)"; fi
}

# Gửi request, trả về "<body>\n<http_code>". Token phiên truyền qua biến $TOKEN.
req() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local args=(-sS -m 30 -X "$method" "$BASE$path"
              -H 'Content-Type: application/json'
              -H "Origin: $BASE"
              -H 'Sec-Fetch-Site: same-origin'
              -w '\n%{http_code}')
  [ -n "$token" ] && args+=(-H "Cookie: $COOKIE_NAME=$token")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}

code() { printf '%s' "$1" | tail -n1; }
body() { printf '%s' "$1" | sed '$d'; }

# Bắt token từ header Set-Cookie của một lần đăng ký/đăng nhập.
login_token() {
  local payload="$1"
  curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" \
    -H 'Sec-Fetch-Site: same-origin' -d "$payload" \
    | tr -d '\r' | awk -F'[=;]' -v n="$COOKIE_NAME" '/^[Ss]et-[Cc]ookie:/ && $0 ~ n {print $2; exit}'
}

register_token() {
  local payload="$1"
  curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/api/auth/register" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" \
    -H 'Sec-Fetch-Site: same-origin' -d "$payload" \
    | tr -d '\r' | awk -F'[=;]' -v n="$COOKIE_NAME" '/^[Ss]et-[Cc]ookie:/ && $0 ~ n {print $2; exit}'
}

jqr() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const p=process.argv[1].split(".");let v=o;for(const k of p)v=v?.[k];console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):v)}catch(e){console.log("")}})' "$2"; }

SUFFIX="$RANDOM$RANDOM"
EMAIL_A="smoke-a-$SUFFIX@example.com"
EMAIL_B="smoke-b-$SUFFIX@example.com"
PW="matkhau-rat-dai-$SUFFIX"

head_ "1. Health"
R=$(req GET /api/health)
expect "GET /api/health trả 200" 200 "$(code "$R")"
echo "     $(body "$R")"

head_ "2. Đăng ký và phiên đăng nhập"
TOKEN_A=$(register_token "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\",\"display_name\":\"An\"}")
if [ -n "$TOKEN_A" ]; then c_ok "đăng ký trả về cookie phiên"; else c_bad "đăng ký KHÔNG trả cookie phiên"; fi

R=$(req GET /api/auth/me "" "$TOKEN_A")
expect "GET /api/auth/me với cookie hợp lệ trả 200" 200 "$(code "$R")"
expect "me trả đúng email" "$EMAIL_A" "$(jqr "$(body "$R")" user.email)"

R=$(req GET /api/auth/me)
expect "GET /api/auth/me không cookie trả 401" 401 "$(code "$R")"

head_ "3. Chống dò tài khoản và CSRF"
R=$(req POST /api/auth/login "{\"email\":\"khong-ton-tai-$SUFFIX@example.com\",\"password\":\"$PW\"}")
MSG_UNKNOWN=$(jqr "$(body "$R")" error.message)
R=$(req POST /api/auth/login "{\"email\":\"$EMAIL_A\",\"password\":\"sai-mat-khau-hoan-toan\"}")
MSG_WRONGPW=$(jqr "$(body "$R")" error.message)
expect "email lạ và sai mật khẩu cho THÔNG ĐIỆP GIỐNG HỆT" "$MSG_UNKNOWN" "$MSG_WRONGPW"

R=$(curl -sS -m 30 -X POST "$BASE/api/ideas" -H 'Content-Type: application/json' \
      -H "Cookie: $COOKIE_NAME=$TOKEN_A" -d '{"title":"x"}' -w '\n%{http_code}')
expect "POST không có Origin bị chặn (CSRF)" 403 "$(code "$R")"

R=$(curl -sS -m 30 -X POST "$BASE/api/ideas" -H 'Content-Type: application/json' \
      -H "Origin: https://ke-tan-cong.example" -H 'Sec-Fetch-Site: cross-site' \
      -H "Cookie: $COOKIE_NAME=$TOKEN_A" -d '{"title":"x"}' -w '\n%{http_code}')
expect "POST từ origin lạ bị chặn (CSRF)" 403 "$(code "$R")"

R=$(curl -sS -m 30 -X POST "$BASE/api/ideas" -H 'Content-Type: text/plain' \
      -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' \
      -H "Cookie: $COOKIE_NAME=$TOKEN_A" -d '{"title":"x"}' -w '\n%{http_code}')
expect "POST sai Content-Type bị từ chối" 400 "$(code "$R")"

head_ "4. CRUD ý tưởng"
IDEA='{"title":"5 mẹo quay video bằng điện thoại","hook":"Bạn đang cầm máy sai cách!","script_outline":"1. Khoá nét 2. Ánh sáng cửa sổ 3. Quay ngang","platform":"tiktok","niche":"làm phim","tags":["quay phim","mẹo"]}'
R=$(req POST /api/ideas "$IDEA" "$TOKEN_A")
expect "POST /api/ideas trả 201" 201 "$(code "$R")"
IDEA_ID=$(jqr "$(body "$R")" idea.id)
if [ -n "$IDEA_ID" ]; then c_ok "tạo được ý tưởng ($IDEA_ID)"; else c_bad "không lấy được id ý tưởng"; fi
# Tạo ý tưởng CHỈ ghi D1 — không nhúng, không đụng Vectorize. indexed phải là false.
expect "tạo ý tưởng KHÔNG tự index (chỉ ghi D1)" "false" "$(jqr "$(body "$R")" indexed)"

R=$(req GET /api/sync "" "$TOKEN_A")
expect "GET /api/sync trả 200" 200 "$(code "$R")"
expect "ý tưởng vừa tạo được đếm là chưa index" 1 "$(jqr "$(body "$R")" dirty)"

R=$(req GET "/api/ideas/$IDEA_ID" "" "$TOKEN_A")
expect "GET ý tưởng của chính mình trả 200" 200 "$(code "$R")"
expect "tag được lưu đúng" '["mẹo","quay phim"]' "$(jqr "$(body "$R")" idea.tags)"

R=$(req PATCH "/api/ideas/$IDEA_ID" '{"status":"scripted"}' "$TOKEN_A")
expect "PATCH đổi trạng thái trả 200" 200 "$(code "$R")"
expect "trạng thái đã đổi" "scripted" "$(jqr "$(body "$R")" idea.status)"
expect "PATCH không xoá mất tiêu đề cũ" "5 mẹo quay video bằng điện thoại" "$(jqr "$(body "$R")" idea.title)"

R=$(req GET "/api/ideas?limit=10" "" "$TOKEN_A")
expect "GET danh sách trả 200" 200 "$(code "$R")"

R=$(req GET "/api/ideas?q=quay%20video" "" "$TOKEN_A")
expect "tìm từ khoá (D1 LIKE) trả 200" 200 "$(code "$R")"

R=$(req POST "/api/ideas/$IDEA_ID/like" "" "$TOKEN_A")
expect "like trả 204" 204 "$(code "$R")"
R=$(req POST "/api/ideas/$IDEA_ID/like" "" "$TOKEN_A")
expect "like lần hai vẫn 204 (idempotent)" 204 "$(code "$R")"

R=$(req GET /api/tags "" "$TOKEN_A")
expect "GET /api/tags trả 200" 200 "$(code "$R")"

head_ "4b. Ý tưởng gốc, công thức prompt, danh mục hook và biến thể"
ORIGIN='{"title":"Series review quán cà phê","hook":"Quán này không dành cho bạn",
 "source_idea":"Ghi lại lúc 2 giờ sáng: đi review quán theo kiểu phim tài liệu",
 "prompt_recipe":"máy quay lia chậm, ánh sáng cửa sổ, tông ấm",
 "negative_prompt":"không chữ to, không nhạc trend",
 "platform":"reels","niche":"ẩm thực","tags":["cà phê"],
 "hooks":["Quán này không dành cho bạn","3 giây đầu quyết định tất cả"]}'
R=$(req POST /api/ideas "$ORIGIN" "$TOKEN_A")
expect "tạo ý tưởng gốc kèm ba trường mới trả 201" 201 "$(code "$R")"
ORIGIN_ID=$(jqr "$(body "$R")" idea.id)
expect "ý tưởng gốc được lưu nguyên văn" \
  "Ghi lại lúc 2 giờ sáng: đi review quán theo kiểu phim tài liệu" \
  "$(jqr "$(body "$R")" idea.source_idea)"
expect "prompt công thức được lưu" "máy quay lia chậm, ánh sáng cửa sổ, tông ấm" \
  "$(jqr "$(body "$R")" idea.prompt_recipe)"
expect "negative prompt được lưu" "không chữ to, không nhạc trend" \
  "$(jqr "$(body "$R")" idea.negative_prompt)"
expect "danh mục hook giữ nguyên thứ tự" \
  '["Quán này không dành cho bạn","3 giây đầu quyết định tất cả"]' \
  "$(jqr "$(body "$R")" idea.hooks)"
expect "ý tưởng mới mặc định là ý tưởng gốc" "origin" "$(jqr "$(body "$R")" idea.kind)"

R=$(req POST "/api/ideas/$ORIGIN_ID/variants" '{"title":"Biến thể quay ban đêm"}' "$TOKEN_A")
expect "tạo biến thể từ ý tưởng gốc trả 201" 201 "$(code "$R")"
VARIANT_ID=$(jqr "$(body "$R")" idea.id)
expect "biến thể có kind = variant" "variant" "$(jqr "$(body "$R")" idea.kind)"
expect "biến thể trỏ về đúng ý tưởng gốc" "$ORIGIN_ID" "$(jqr "$(body "$R")" idea.parent_id)"
expect "biến thể kế thừa prompt công thức của bản gốc" \
  "máy quay lia chậm, ánh sáng cửa sổ, tông ấm" "$(jqr "$(body "$R")" idea.prompt_recipe)"

R=$(req GET "/api/ideas/$ORIGIN_ID/variants" "" "$TOKEN_A")
expect "GET danh mục biến thể trả 200" 200 "$(code "$R")"
COUNT_V=$(printf '%s' "$(body "$R")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).items.length)}catch(e){console.log("?")}})')
expect "danh mục biến thể có đúng một mục" 1 "$COUNT_V"

# Cây đúng MỘT tầng: biến thể không đẻ tiếp biến thể.
R=$(req POST "/api/ideas/$VARIANT_ID/variants" '{}' "$TOKEN_A")
expect "tạo biến thể TỪ một biến thể bị từ chối" 400 "$(code "$R")"

R=$(req GET "/api/ideas?kind=variant&limit=50" "" "$TOKEN_A")
COUNT_KV=$(printf '%s' "$(body "$R")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).items.length)}catch(e){console.log("?")}})')
expect "lọc kind=variant chỉ ra biến thể" 1 "$COUNT_KV"

# Nút đồng bộ của riêng một ý tưởng.
R=$(req POST "/api/ideas/$ORIGIN_ID/reindex" '{}' "$TOKEN_A")
expect "POST /api/ideas/:id/reindex trả 200" 200 "$(code "$R")"
echo "     outcome=$(jqr "$(body "$R")" outcome)"

head_ "4c. Quản lý danh mục video hook (thêm / sửa / xoá / đổi thứ tự)"
R=$(req GET "/api/ideas/$ORIGIN_ID/hooks" "" "$TOKEN_A")
expect "GET danh mục hook trả 200" 200 "$(code "$R")"

R=$(req POST "/api/ideas/$ORIGIN_ID/hooks" '{"text":"Hook thêm sau"}' "$TOKEN_A")
expect "thêm hook trả 201" 201 "$(code "$R")"
HOOK_ID=$(jqr "$(body "$R")" hook.id)
if [ -n "$HOOK_ID" ]; then c_ok "lấy được id của hook vừa thêm"; else c_bad "không lấy được id hook"; fi

# Hook nằm trong văn bản đem đi nhúng, nên thêm hook PHẢI làm ý tưởng bẩn trở lại.
R=$(req GET /api/sync "" "$TOKEN_A")
DIRTY_SAU_THEM=$(jqr "$(body "$R")" dirty)
if [ "$DIRTY_SAU_THEM" -ge 1 ]; then
  c_ok "thêm hook làm ý tưởng cần đồng bộ lại (dirty=$DIRTY_SAU_THEM)"
else c_bad "thêm hook KHÔNG làm ý tưởng bẩn — vector sẽ mốc lại trong im lặng"; fi

R=$(req PATCH "/api/ideas/$ORIGIN_ID/hooks/$HOOK_ID" '{"text":"Hook đã sửa"}' "$TOKEN_A")
expect "sửa hook trả 200" 200 "$(code "$R")"
R=$(req GET "/api/ideas/$ORIGIN_ID" "" "$TOKEN_A")
expect "nội dung hook đã đổi trong danh mục của ý tưởng" \
  '["Quán này không dành cho bạn","3 giây đầu quyết định tất cả","Hook đã sửa"]' \
  "$(jqr "$(body "$R")" idea.hooks)"

R=$(req POST "/api/ideas/$ORIGIN_ID/hooks/$HOOK_ID/move" '{"dir":"up"}' "$TOKEN_A")
expect "đổi thứ tự hook trả 200" 200 "$(code "$R")"
expect "hook đã nhích lên một bậc" "true" "$(jqr "$(body "$R")" moved)"
R=$(req GET "/api/ideas/$ORIGIN_ID" "" "$TOKEN_A")
expect "thứ tự mới được giữ đúng" \
  '["Quán này không dành cho bạn","Hook đã sửa","3 giây đầu quyết định tất cả"]' \
  "$(jqr "$(body "$R")" idea.hooks)"

R=$(req POST "/api/ideas/$ORIGIN_ID/hooks/$HOOK_ID/move" '{"dir":"up"}' "$TOKEN_A")
R=$(req POST "/api/ideas/$ORIGIN_ID/hooks/$HOOK_ID/move" '{"dir":"up"}' "$TOKEN_A")
expect "đã ở đầu danh mục thì báo moved=false, không phải lỗi" "false" "$(jqr "$(body "$R")" moved)"

R=$(req POST "/api/ideas/$ORIGIN_ID/hooks" '{"text":"   "}' "$TOKEN_A")
expect "hook rỗng bị từ chối" 400 "$(code "$R")"

R=$(req DELETE "/api/ideas/$ORIGIN_ID/hooks/$HOOK_ID" "" "$TOKEN_A")
expect "xoá hook trả 204" 204 "$(code "$R")"
R=$(req GET "/api/ideas/$ORIGIN_ID" "" "$TOKEN_A")
expect "hook đã biến khỏi danh mục" \
  '["Quán này không dành cho bạn","3 giây đầu quyết định tất cả"]' \
  "$(jqr "$(body "$R")" idea.hooks)"
R=$(req DELETE "/api/ideas/$ORIGIN_ID/hooks/$HOOK_ID" "" "$TOKEN_A")
expect "xoá lại hook đã xoá trả 404" 404 "$(code "$R")"

head_ "4d. Quản lý danh mục ý tưởng biến thể (xoá tại chỗ)"
R=$(req POST "/api/ideas/$ORIGIN_ID/variants" '{"title":"Biến thể sẽ bị xoá"}' "$TOKEN_A")
TMP_VARIANT=$(jqr "$(body "$R")" idea.id)
R=$(req GET "/api/ideas/$ORIGIN_ID/variants" "" "$TOKEN_A")
COUNT_V2=$(printf '%s' "$(body "$R")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).items.length)}catch(e){console.log("?")}})')
expect "danh mục biến thể giờ có hai mục" 2 "$COUNT_V2"

R=$(req DELETE "/api/ideas/$TMP_VARIANT" "" "$TOKEN_A")
expect "xoá biến thể ngay từ danh mục trả 204" 204 "$(code "$R")"
R=$(req GET "/api/ideas/$ORIGIN_ID/variants" "" "$TOKEN_A")
COUNT_V3=$(printf '%s' "$(body "$R")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).items.length)}catch(e){console.log("?")}})')
expect "danh mục biến thể còn lại một mục" 1 "$COUNT_V3"
R=$(req GET "/api/ideas/$TMP_VARIANT" "" "$TOKEN_A")
expect "biến thể đã xoá thì không đọc lại được" 404 "$(code "$R")"

R=$(req PATCH "/api/ideas/$VARIANT_ID" '{"title":"Biến thể đã đổi tên"}' "$TOKEN_A")
expect "sửa biến thể qua PATCH trả 200" 200 "$(code "$R")"
expect "tên biến thể đã đổi" "Biến thể đã đổi tên" "$(jqr "$(body "$R")" idea.title)"
expect "sửa xong vẫn là biến thể của đúng ý tưởng gốc" "$ORIGIN_ID" "$(jqr "$(body "$R")" idea.parent_id)"

head_ "5. Cách ly giữa các tài khoản"
TOKEN_B=$(register_token "{\"email\":\"$EMAIL_B\",\"password\":\"$PW\"}")
if [ -n "$TOKEN_B" ]; then c_ok "đăng ký được tài khoản thứ hai"; else c_bad "không đăng ký được tài khoản thứ hai"; fi

for M in GET PATCH DELETE; do
  BODY=""
  [ "$M" = "PATCH" ] && BODY='{"title":"chiem doat"}'
  R=$(req "$M" "/api/ideas/$IDEA_ID" "$BODY" "$TOKEN_B")
  expect "$M ý tưởng của người khác trả 404 (không phải 403)" 404 "$(code "$R")"
done
R=$(req POST "/api/ideas/$IDEA_ID/like" "" "$TOKEN_B")
expect "like ý tưởng của người khác trả 404" 404 "$(code "$R")"

R=$(req POST "/api/ideas/$ORIGIN_ID/reindex" '{}' "$TOKEN_B")
expect "đồng bộ ý tưởng của người khác trả 404" 404 "$(code "$R")"
R=$(req GET "/api/ideas/$ORIGIN_ID/variants" "" "$TOKEN_B")
expect "xem danh mục biến thể của người khác trả 404" 404 "$(code "$R")"
R=$(req POST "/api/ideas/$ORIGIN_ID/variants" '{}' "$TOKEN_B")
expect "tạo biến thể trên ý tưởng của người khác trả 404" 404 "$(code "$R")"
R=$(req GET "/api/ideas/$ORIGIN_ID/hooks" "" "$TOKEN_B")
expect "xem danh mục hook của người khác trả 404" 404 "$(code "$R")"
R=$(req POST "/api/ideas/$ORIGIN_ID/hooks" '{"text":"chiếm chỗ"}' "$TOKEN_B")
expect "thêm hook vào ý tưởng của người khác trả 404" 404 "$(code "$R")"

R=$(req GET "/api/ideas?limit=50" "" "$TOKEN_B")
COUNT_B=$(printf '%s' "$(body "$R")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).items.length)}catch(e){console.log("?")}})')
expect "danh sách của tài khoản B rỗng" 0 "$COUNT_B"

head_ "6. Tìm kiếm ngữ nghĩa và gợi ý"
R=$(req GET "/api/search?q=c%C3%A1ch%20c%E1%BA%A7m%20m%C3%A1y%20cho%20%C4%91%E1%BA%B9p" "" "$TOKEN_A")
expect "GET /api/search trả 200" 200 "$(code "$R")"
echo "     mode=$(jqr "$(body "$R")" mode) (fallback nghĩa là Vectorize/AI chưa sẵn sàng, đã lùi về tìm từ khoá)"

R=$(req GET /api/recommendations "" "$TOKEN_A")
expect "GET /api/recommendations trả 200" 200 "$(code "$R")"
echo "     basis=$(jqr "$(body "$R")" basis)"

R=$(req POST /api/reindex "" "$TOKEN_A")
expect "POST /api/reindex trả 200" 200 "$(code "$R")"
echo "     $(body "$R")"

head_ "6b. Ghi nhớ đăng nhập"
# Cookie có Max-Age = sống qua lần đóng trình duyệt. Không có = cookie phiên.
CK_REMEMBER=$(curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\",\"remember\":true}" \
  | tr -d '\r' | grep -i '^set-cookie' | head -1)
CK_SESSION=$(curl -sS -m 30 -D - -o /dev/null -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\",\"remember\":false}" \
  | tr -d '\r' | grep -i '^set-cookie' | head -1)
if printf '%s' "$CK_REMEMBER" | grep -qi 'max-age'; then
  c_ok "remember=true → cookie có Max-Age (sống qua lần đóng trình duyệt)"
else c_bad "remember=true nhưng cookie KHÔNG có Max-Age"; fi
if printf '%s' "$CK_SESSION" | grep -qi 'max-age'; then
  c_bad "remember=false nhưng cookie VẪN có Max-Age"
else c_ok "remember=false → cookie phiên (đóng trình duyệt là mất)"; fi

head_ "7. Đổi mật khẩu thu hồi phiên khác"
TOKEN_A2=$(login_token "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\"}")
if [ -n "$TOKEN_A2" ]; then c_ok "đăng nhập lần hai tạo phiên thứ hai"; else c_bad "không đăng nhập lại được"; fi

NEWPW="matkhau-moi-rat-dai-$SUFFIX"
R=$(req POST /api/auth/change-password \
      "{\"current_password\":\"$PW\",\"new_password\":\"$NEWPW\"}" "$TOKEN_A2")
expect "đổi mật khẩu trả 200" 200 "$(code "$R")"

R=$(req GET /api/auth/me "" "$TOKEN_A")
expect "phiên CŨ bị thu hồi sau khi đổi mật khẩu" 401 "$(code "$R")"
R=$(req GET /api/auth/me "" "$TOKEN_A2")
expect "phiên hiện tại vẫn dùng được" 200 "$(code "$R")"

R=$(req POST /api/auth/login "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\"}")
expect "mật khẩu cũ không đăng nhập được nữa" 400 "$(code "$R")"

head_ "8. Đăng xuất"
R=$(req POST /api/auth/logout "" "$TOKEN_A2")
expect "đăng xuất trả 204" 204 "$(code "$R")"
R=$(req GET /api/auth/me "" "$TOKEN_A2")
expect "phiên đã thu hồi trả 401" 401 "$(code "$R")"

head_ "Kết quả"
printf '  %d đạt, %d hỏng\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
