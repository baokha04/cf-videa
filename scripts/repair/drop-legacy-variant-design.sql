-- Dọn phần schema do một bản cài đặt song song để lại.
--
-- ĐÂY KHÔNG PHẢI MIGRATION, và cố ý nằm ngoài migrations/. Nó chỉ đúng với đúng hai
-- database đã lỡ chạy CẢ HAI bản 0005; trên một database dựng mới từ migrations/
-- thì những cột nó xoá chưa từng tồn tại và nó sẽ lỗi. Vì thế `npm run db:remote`
-- (chạy toàn bộ migrations/*.sql) phải không đụng tới nó — chạy tay, một lần:
--
--   wrangler d1 execute videa-db --remote --file=./scripts/repair/drop-legacy-variant-design.sql
--
-- BỐI CẢNH. Cùng một yêu cầu ("nhóm danh mục video hook và danh mục ý tưởng biến
-- thể") được hiện thực hai lần trên hai nhánh khác nhau, và CẢ HAI migration 0005
-- đều đã chạy trên database thật:
--
--   0005_variants_hooks_prompts  (nhánh kia) — biến thể nằm cùng bảng ideas qua cột
--       kind/parent_id, hook gắn theo từng ý tưởng ở bảng idea_hooks, prompt ghép từ
--       cột prompt_recipe của chính ý tưởng đó.
--   0005_hooks_variants_prompts  (nhánh này) — biến thể ở bảng idea_variants riêng,
--       hook là thư viện dùng chung có danh mục, prompt ghép từ mẫu của người dùng.
--
-- Đã chốt giữ thiết kế của nhánh này, nên những gì bản kia thêm vào trở thành rác:
-- cột không ai đọc và bảng không ai ghi. Để lại thì mọi người đọc schema sau này đều
-- phải tự đoán cái nào còn sống.
--
-- AN TOÀN: đã kiểm tra trước khi viết — cả production lẫn preview đều có 0 hàng ở
-- users, ideas, idea_hooks, và 0 ý tưởng nào có kind='variant'. Không mất dữ liệu.

-- Bảng hook gắn theo từng ý tưởng. Thiết kế đang dùng để hook trong thư viện chung
-- (bảng `hooks` + `hook_categories`), chọn lúc sinh prompt chứ không gắn vào ý tưởng.
DROP TABLE IF EXISTS idea_hooks;

-- SQLite từ chối DROP COLUMN khi còn index tham chiếu tới cột đó, nên bỏ index trước.
DROP INDEX IF EXISTS idx_ideas_user_kind;
DROP INDEX IF EXISTS idx_ideas_parent;

-- idx_ideas_dirty bị nhánh kia định nghĩa lại, thêm `|| kind` vào chữ ký metadata.
-- Phải dựng lại cho khớp CHÍNH XÁC hằng DIRTY_SQL trong src/db/ideas.ts: lệch một ký
-- tự là SQLite âm thầm không dùng index và quét toàn bảng, không báo lỗi gì.
DROP INDEX IF EXISTS idx_ideas_dirty;

-- Biến thể nay ở bảng idea_variants riêng, nên hai cột phân loại cha/con này thừa.
ALTER TABLE ideas DROP COLUMN kind;
ALTER TABLE ideas DROP COLUMN parent_id;

-- Prompt nay ghép từ mẫu dùng chung của người dùng (bảng prompt_templates), không
-- phải từ công thức riêng của từng ý tưởng.
ALTER TABLE ideas DROP COLUMN prompt_recipe;
ALTER TABLE ideas DROP COLUMN negative_prompt;
ALTER TABLE ideas DROP COLUMN source_idea;

CREATE INDEX idx_ideas_dirty ON ideas(user_id, updated_at)
  WHERE embedded_hash IS NULL
     OR embedded_hash <> content_hash
     OR indexed_meta_hash IS NULL
     OR indexed_meta_hash <> status || '|' || platform || '|' || visibility;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('repair_drop_legacy_variant_design', unixepoch() * 1000);
