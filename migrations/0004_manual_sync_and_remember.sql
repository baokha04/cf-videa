-- Hai thay đổi độc lập, gộp vào một migration.
--
-- (1) ĐỒNG BỘ VECTOR HOÀN TOÀN THỦ CÔNG
--
-- Tạo/sửa ý tưởng nay CHỈ ghi D1, không gọi Workers AI và không đụng Vectorize.
-- Việc index do người dùng bấm nút "Đồng bộ index" khi họ muốn.
--
-- Vấn đề nảy sinh: `status` nằm trong metadata của vector nhưng KHÔNG nằm trong văn
-- bản đem đi nhúng, nên đổi mỗi trạng thái không làm content_hash đổi. Nếu chỉ dựa
-- vào content_hash để biết hàng nào "bẩn" thì một ý tưởng đổi trạng thái sẽ không
-- bao giờ được đồng bộ lại, và metadata trên Vectorize mốc lại vĩnh viễn —
-- /api/search?status=… lọc sai mà không có dấu hiệu gì.
--
-- indexed_meta_hash lưu chữ ký metadata tại lần upsert gần nhất. Chữ ký hiện tại
-- tính thẳng trong SQL (status || '|' || platform || '|' || visibility), nên không
-- cần cột thứ hai để lưu nó. Hàng "bẩn" giờ có hai loại, và loại thứ hai KHÔNG cần
-- gọi AI: chỉ ghi đè metadata bằng vector đã lưu.
ALTER TABLE ideas ADD COLUMN indexed_meta_hash TEXT;

-- Hàng đã index trước migration này có metadata đúng với lúc upsert, nên đánh dấu
-- luôn để chúng không bị coi là bẩn oan.
UPDATE ideas
   SET indexed_meta_hash = status || '|' || platform || '|' || visibility
 WHERE embedded_hash IS NOT NULL AND embedded_hash = content_hash;

DROP INDEX IF EXISTS idx_ideas_dirty;
CREATE INDEX idx_ideas_dirty ON ideas(user_id, updated_at)
  WHERE embedded_hash IS NULL
     OR embedded_hash <> content_hash
     OR indexed_meta_hash IS NULL
     OR indexed_meta_hash <> status || '|' || platform || '|' || visibility;

-- (2) GHI NHỚ ĐĂNG NHẬP
--
-- remember = 1: phiên dài, cookie có Max-Age nên sống qua lần đóng trình duyệt.
-- remember = 0: phiên ngắn, cookie KHÔNG có Max-Age nên trình duyệt xoá khi đóng.
-- Cần lưu vào hàng phiên vì lúc gia hạn trượt phải biết phát lại cookie kiểu nào.
-- Mặc định 1 để các phiên đang mở giữ nguyên hành vi cũ.
ALTER TABLE sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 1;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0004_manual_sync_and_remember', unixepoch() * 1000);
