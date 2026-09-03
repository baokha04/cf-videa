-- Hai thay đổi trên bảng ideas, cùng phục vụ hai yêu cầu còn thiếu của kho ý tưởng gốc.
--
-- (1) NEGATIVE PROMPT
--
-- Cột này TỪNG tồn tại rồi bị xoá: hai nhánh hiện thực cùng một yêu cầu theo hai cách,
-- lần gộp chốt giữ thiết kế hiện tại, và scripts/repair/drop-legacy-variant-design.sql
-- dọn nốt phần của bản kia — trong đó có negative_prompt. Nay thêm lại theo đúng thiết
-- kế đang dùng: một ô trên ý tưởng gốc, và một biến {{negative_prompt}} trong mẫu prompt.
--
-- CỐ Ý KHÔNG có `UPDATE ideas SET embedded_hash = NULL` ở cuối file này, khác hẳn
-- migration 0005. Negative prompt KHÔNG được đưa vào văn bản đem đi nhúng (xem
-- src/content.ts): nhúng một danh sách "không được xuất hiện" thì embedding đọc dấu trừ
-- thành dấu cộng, và ý tưởng sẽ khớp với đúng thứ nó muốn tránh. Không vào văn bản nhúng
-- nghĩa là content_hash không đổi, nghĩa là không hàng nào bẩn thêm vì migration này.
ALTER TABLE ideas ADD COLUMN negative_prompt TEXT NOT NULL DEFAULT '';

-- (2) LINEAGE CỦA Ý TƯỞNG KẾT HỢP
--
-- Chức năng kết hợp (ý tưởng gốc + biến thể + hook) nay LƯU kết quả thành một ý tưởng
-- gốc mới, chứ không chỉ sinh chuỗi prompt rồi thôi. Ba cột này ghi lại nó đến từ đâu.
--
-- ON DELETE SET NULL chứ KHÔNG phải CASCADE: xoá ý tưởng nguồn không được kéo theo ý
-- tưởng đã kết hợp. Sau khi lưu, nó là một ý tưởng độc lập, sửa được, index được, và
-- có đời sống riêng — lineage chỉ là ghi chú xuất xứ, không phải quan hệ sở hữu.
--
-- SQLite chỉ cho ADD COLUMN kèm REFERENCES khi giá trị mặc định là NULL. Cả ba cột đều
-- vậy, nên không cần dựng lại bảng.
ALTER TABLE ideas ADD COLUMN source_idea_id    TEXT REFERENCES ideas(id)         ON DELETE SET NULL;
ALTER TABLE ideas ADD COLUMN source_variant_id TEXT REFERENCES idea_variants(id) ON DELETE SET NULL;
ALTER TABLE ideas ADD COLUMN source_hook_id    TEXT REFERENCES hooks(id)         ON DELETE SET NULL;

-- Chỉ index cột nguồn ý tưởng: câu hỏi thực tế là "ý tưởng này đã đẻ ra những gì".
-- Không ai truy ngược từ một biến thể hay một hook, nên hai index kia sẽ chỉ tốn chỗ ghi.
CREATE INDEX idx_ideas_source ON ideas(source_idea_id) WHERE source_idea_id IS NOT NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0006_negative_prompt_and_lineage', unixepoch() * 1000);
