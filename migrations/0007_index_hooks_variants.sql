-- Hook và biến thể trở thành thực thể index được, mỗi cái một vector riêng.
--
-- TRƯỚC migration này: chỉ `ideas` có vector. Hook bị cố ý loại hẳn khỏi việc nhúng, còn
-- biến thể chỉ góp chữ vào văn bản nhúng của ý tưởng CHA — nên không tìm được riêng, và
-- không có gì để "index thủ công từng cái" cả.
--
-- SAU migration này: ba loại vector nằm chung một index Vectorize, phân biệt bằng metadata
-- `type` ('idea' | 'variant' | 'hook'). Xem src/vec/index.ts.
--
-- ⚠️ VẬN HÀNH: metadata index cho `type` phải được tạo TRƯỚC lần upsert đầu tiên, nếu
-- không vector ghi ra sẽ không nằm trong index đó và cách sửa duy nhất là upsert lại toàn
-- bộ. Xem README, mục "Khởi tạo hạ tầng".

-- ---------------------------------------------------------------------------
-- Hook
-- ---------------------------------------------------------------------------
-- Đúng bộ cột của `ideas` (migrations/0001 + 0004), cùng ý nghĩa từng cột.
-- content_hash mặc định '' để mọi hook sẵn có đều "bẩn" ngay và hiện ra ở nút index —
-- không có hàng nào âm thầm coi như đã đồng bộ trong khi chưa từng có vector.
ALTER TABLE hooks ADD COLUMN content_hash      TEXT    NOT NULL DEFAULT '';
ALTER TABLE hooks ADD COLUMN embedded_hash     TEXT;
ALTER TABLE hooks ADD COLUMN indexed_meta_hash TEXT;
ALTER TABLE hooks ADD COLUMN embedding_model   TEXT;
ALTER TABLE hooks ADD COLUMN embedded_at       INTEGER;
ALTER TABLE hooks ADD COLUMN embed_attempts    INTEGER NOT NULL DEFAULT 0;

-- Chữ ký metadata của hook. Danh mục nằm trong metadata của vector nhưng KHÔNG nằm trong
-- văn bản đem đi nhúng, nên chuyển hook sang danh mục khác không làm content_hash đổi —
-- đúng cái bẫy mà migrations/0004 đã phải vá cho `status` của ý tưởng. Cột này bịt nó.
--
-- Phải khớp CHÍNH XÁC hằng HOOK_DIRTY_SQL trong src/db/hooks.ts: lệch một ký tự là SQLite
-- âm thầm không dùng index này và quét toàn bảng, không báo lỗi gì.
CREATE INDEX idx_hooks_dirty ON hooks(user_id, updated_at)
  WHERE embedded_hash IS NULL
     OR embedded_hash <> content_hash
     OR indexed_meta_hash IS NULL
     OR indexed_meta_hash <> 'hook' || '|' || COALESCE(category_id, '');

-- ---------------------------------------------------------------------------
-- Biến thể
-- ---------------------------------------------------------------------------
ALTER TABLE idea_variants ADD COLUMN content_hash      TEXT    NOT NULL DEFAULT '';
ALTER TABLE idea_variants ADD COLUMN embedded_hash     TEXT;
ALTER TABLE idea_variants ADD COLUMN indexed_meta_hash TEXT;
ALTER TABLE idea_variants ADD COLUMN embedding_model   TEXT;
ALTER TABLE idea_variants ADD COLUMN embedded_at       INTEGER;
ALTER TABLE idea_variants ADD COLUMN embed_attempts    INTEGER NOT NULL DEFAULT 0;

-- idea_id không đổi được, nên chữ ký này trên thực tế không bao giờ lệch. Vẫn giữ cột cho
-- đồng nhất với hai bảng kia: ngày nào đó thêm một trường vào metadata của biến thể mà
-- quên cột này thì lại dính đúng lỗi im lặng của 0004.
--
-- Phải khớp CHÍNH XÁC hằng VARIANT_DIRTY_SQL trong src/db/variants.ts.
CREATE INDEX idx_variants_dirty ON idea_variants(user_id, updated_at)
  WHERE embedded_hash IS NULL
     OR embedded_hash <> content_hash
     OR indexed_meta_hash IS NULL
     OR indexed_meta_hash <> 'variant' || '|' || idea_id;

-- ---------------------------------------------------------------------------
-- Ý tưởng phải được index lại một lượt
-- ---------------------------------------------------------------------------
-- Từ nay `queryIdeas` lọc `type = 'idea'`, mà vector ý tưởng ghi trước migration này không
-- mang metadata `type` — chúng sẽ bị filter loại ra và tìm kiếm ngữ nghĩa trả về rỗng mà
-- không báo lỗi gì. Đặt cả hai cột về NULL là cách nói "bẩn" theo đúng định nghĩa ở
-- src/db/ideas.ts, để nút đồng bộ ghi lại metadata đầy đủ cho từng hàng.
UPDATE ideas SET embedded_hash = NULL, indexed_meta_hash = NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0007_index_hooks_variants', unixepoch() * 1000);
