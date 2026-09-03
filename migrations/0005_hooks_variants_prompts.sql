-- Tách kho ý tưởng thành ba khối rời nhau, thay cho vài ô văn bản trên một bảng.
--
--   ý tưởng gốc  ──┬── nhiều BIẾN THỂ (góc nhìn khác, dàn ý riêng)
--                  │
--   thư viện HOOK ─┘   (không gắn cứng vào biến thể)
--
-- Biến thể KHÔNG giữ hook. Hook được chọn lúc sinh prompt, nên n biến thể × m hook
-- cho ra n×m prompt khả dĩ mà không phải nhân bản dữ liệu. Đó là lý do không có cột
-- hook_id trong idea_variants, và cũng là lý do bỏ cột hook khỏi ideas.

-- ---------------------------------------------------------------------------
-- Thư viện hook, có nhóm danh mục
-- ---------------------------------------------------------------------------
CREATE TABLE hook_categories (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX idx_hook_categories_user ON hook_categories(user_id, sort_order, name);

CREATE TABLE hooks (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Xoá danh mục KHÔNG xoá hook: hook là thứ mất công nghĩ ra, còn danh mục chỉ là
  -- cách sắp xếp. Hook rơi về nhóm "chưa phân loại".
  category_id TEXT    REFERENCES hook_categories(id) ON DELETE SET NULL,
  text        TEXT    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_hooks_user     ON hooks(user_id, updated_at DESC);
CREATE INDEX idx_hooks_category ON hooks(category_id);

-- ---------------------------------------------------------------------------
-- Biến thể của một ý tưởng gốc
-- ---------------------------------------------------------------------------
CREATE TABLE idea_variants (
  id             TEXT    PRIMARY KEY,
  idea_id        TEXT    NOT NULL REFERENCES ideas(id)  ON DELETE CASCADE,
  -- user_id lặp lại dù suy ra được từ idea_id: mọi truy vấn đều ràng buộc user_id
  -- ngay trong câu lệnh, và bắt buộc JOIN sang ideas chỉ để lấy nó là chỗ rất dễ
  -- có ngày ai đó quên.
  user_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT    NOT NULL,
  angle          TEXT    NOT NULL DEFAULT '',
  -- Để trống thì prompt dùng dàn ý của ý tưởng gốc. Có thì ghi đè.
  script_outline TEXT    NOT NULL DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_variants_idea ON idea_variants(idea_id, sort_order, created_at);
CREATE INDEX idx_variants_user ON idea_variants(user_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Mẫu prompt — một mẫu cho mỗi người dùng
-- ---------------------------------------------------------------------------
CREATE TABLE prompt_templates (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Bỏ cột hook khỏi ideas
-- ---------------------------------------------------------------------------
-- Hook nay là một thực thể riêng có danh mục, không còn là một ô văn bản của ý tưởng.
-- Không có index nào tham chiếu cột này nên DROP COLUMN chạy thẳng được.
ALTER TABLE ideas DROP COLUMN hook;

-- Văn bản đem đi nhúng đổi (bỏ hook, thêm biến thể) nên MỌI hàng phải được index lại.
-- Đặt cả hai cột về NULL là cách nói "bẩn" theo đúng định nghĩa ở src/db/ideas.ts.
UPDATE ideas SET embedded_hash = NULL, indexed_meta_hash = NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0005_hooks_variants_prompts', unixepoch() * 1000);
