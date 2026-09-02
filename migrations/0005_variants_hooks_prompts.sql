-- Kho ý tưởng mở rộng: ý tưởng gốc, công thức prompt tái dùng, negative prompt,
-- danh mục video hook và danh mục ý tưởng biến thể.
--
-- Bốn thay đổi độc lập, gộp vào một migration vì chúng cùng mô tả một khái niệm:
-- một ý tưởng gốc là một "kho" nhỏ gồm nguyên liệu (ý tưởng thô + công thức
-- prompt), một danh mục hook, và một danh mục biến thể mọc ra từ nó.

-- ---------------------------------------------------------------------------
-- (1) BA TRƯỜNG NGUYÊN LIỆU
-- ---------------------------------------------------------------------------
--
-- source_idea     — ý tưởng gốc, giữ NGUYÊN VĂN như lúc nghĩ ra hoặc lúc chép về.
--                   Cột riêng chứ không nhét vào script_outline: dàn ý bị viết lại
--                   liên tục, còn bản gốc phải còn nguyên để đối chiếu và để đẻ ra
--                   biến thể mới sau này.
-- prompt_recipe   — prompt công thức, viết một lần rồi dán lại cho mọi biến thể.
-- negative_prompt — thứ KHÔNG được xuất hiện.
--
-- DEFAULT '' chứ không NULL: mọi cột văn bản của bảng này đều đã là NOT NULL
-- DEFAULT '', nên tầng ứng dụng không bao giờ phải phân biệt "rỗng" với "chưa có".
ALTER TABLE ideas ADD COLUMN source_idea     TEXT NOT NULL DEFAULT '';
ALTER TABLE ideas ADD COLUMN prompt_recipe   TEXT NOT NULL DEFAULT '';
ALTER TABLE ideas ADD COLUMN negative_prompt TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- (2) Ý TƯỞNG GỐC vs. Ý TƯỞNG BIẾN THỂ
-- ---------------------------------------------------------------------------
--
-- Biến thể nằm CÙNG bảng với ý tưởng gốc, không tách bảng riêng. Lý do: một biến
-- thể vẫn phải tìm được, thích được, index được và đổi trạng thái được y hệt một ý
-- tưởng thường — tách bảng thì phải nhân đôi toàn bộ những thứ đó.
--
-- CHỈ MỘT TẦNG: cha của một biến thể luôn là ý tưởng gốc (ràng buộc ở tầng ứng
-- dụng, src/db/ideas.ts). Cây một tầng thì không thể có chu trình, và "danh mục
-- biến thể" luôn đọc được bằng đúng một truy vấn.
--
-- ON DELETE CASCADE: xoá ý tưởng gốc là xoá cả danh mục biến thể của nó. Route xoá
-- phải lấy danh sách id con TRƯỚC khi xoá để còn dọn vector của chúng trên
-- Vectorize — xem src/routes/ideas.ts.
ALTER TABLE ideas ADD COLUMN kind TEXT NOT NULL DEFAULT 'origin'
                            CHECK (kind IN ('origin', 'variant'));
ALTER TABLE ideas ADD COLUMN parent_id TEXT REFERENCES ideas(id) ON DELETE CASCADE;

CREATE INDEX idx_ideas_parent    ON ideas(parent_id, created_at DESC) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_ideas_user_kind ON ideas(user_id, kind, updated_at DESC);

-- ---------------------------------------------------------------------------
-- (3) DANH MỤC VIDEO HOOK
-- ---------------------------------------------------------------------------
--
-- Cột ideas.hook cũ vẫn giữ nguyên: đó là hook ĐANG DÙNG, thứ hiện trên thẻ ý
-- tưởng. Bảng này là danh mục các hook đã nghĩ ra cho cùng một ý tưởng gốc, để thử
-- vài cách mở đầu khác nhau mà không mất bản cũ.
--
-- user_id lặp lại ở đây dù suy ra được từ ideas: nó cho phép mọi truy vấn ràng buộc
-- quyền sở hữu NGAY TRONG câu lệnh, đúng quy tắc chung của dự án, và cho phép phép
-- join `i.user_id = h.user_id` chặn rò rỉ chéo tài khoản bằng cấu trúc.
CREATE TABLE idea_hooks (
  id         TEXT    PRIMARY KEY,
  idea_id    TEXT    NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_idea_hooks_idea ON idea_hooks(idea_id, position);
CREATE INDEX idx_idea_hooks_user ON idea_hooks(user_id);

-- ---------------------------------------------------------------------------
-- (4) kind ĐI VÀO CHỮ KÝ METADATA
-- ---------------------------------------------------------------------------
--
-- kind nằm trong metadata của vector (để lọc gốc/biến thể khi tìm ngữ nghĩa) nhưng
-- KHÔNG nằm trong văn bản đem đi nhúng — đúng cái bẫy mà migrations/0004 đã mô tả
-- với status. Nên nó phải vào chữ ký metadata, nếu không việc đổi một ý tưởng
-- thường thành biến thể sẽ không bao giờ tới được Vectorize.
--
-- Cố ý KHÔNG backfill indexed_meta_hash: vector đang nằm trên Vectorize thật sự
-- KHÔNG có thuộc tính kind trong metadata. Để mọi hàng đã index thành "bẩn
-- metadata" là đúng — lần đồng bộ kế tiếp sẽ ghi kind lên, và loại bẩn này KHÔNG
-- tốn một lời gọi Workers AI nào (dùng lại vector đã lưu).
--
-- VIỆC VẬN HÀNH KÈM THEO: phải tạo metadata index cho `kind` trên Vectorize TRƯỚC
-- lần upsert kế tiếp, nếu không các vector ghi sau sẽ không nằm trong index đó.
-- Xem README, phần "Khởi tạo hạ tầng".
DROP INDEX IF EXISTS idx_ideas_dirty;
CREATE INDEX idx_ideas_dirty ON ideas(user_id, updated_at)
  WHERE embedded_hash IS NULL
     OR embedded_hash <> content_hash
     OR indexed_meta_hash IS NULL
     OR indexed_meta_hash <> status || '|' || platform || '|' || visibility || '|' || kind;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0005_variants_hooks_prompts', unixepoch() * 1000);
