-- cf-videa — schema khởi tạo
--
-- KHÔNG dùng `PRAGMA foreign_keys = ON`: D1 đã bật ràng buộc khoá ngoại sẵn.
-- Nếu một migration về sau cần tạm phá thứ tự tham chiếu thì dùng
-- `PRAGMA defer_foreign_keys = true` bên trong chính migration đó.
--
-- Mọi mốc thời gian là Unix milliseconds (Date.now()), TRỪ rate_limits.window_start
-- vốn tính bằng giây vì cửa sổ được làm tròn theo giây.

-- ---------------------------------------------------------------------------
-- Tài khoản
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  TEXT    PRIMARY KEY,
  email               TEXT    NOT NULL UNIQUE,   -- luôn lưu chữ thường, đã trim
  password_hash       TEXT    NOT NULL,          -- pbkdf2$sha256$<iters>$<salt>$<hash>
  display_name        TEXT,
  status              TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'disabled')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);

-- id = hex(sha256(token)). Token gốc KHÔNG bao giờ chạm tới database.
CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,   -- hạn nhàn rỗi, gia hạn trượt
  absolute_exp INTEGER NOT NULL,   -- trần cứng, không bao giờ gia hạn
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Kho ý tưởng
-- ---------------------------------------------------------------------------
CREATE TABLE ideas (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  hook            TEXT    NOT NULL DEFAULT '',
  script_outline  TEXT    NOT NULL DEFAULT '',
  platform        TEXT    NOT NULL DEFAULT 'tiktok'
                          CHECK (platform IN ('tiktok', 'reels', 'shorts', 'other')),
  niche           TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'idea'
                          CHECK (status IN ('idea', 'scripted', 'filmed', 'published', 'archived')),
  visibility      TEXT    NOT NULL DEFAULT 'private'
                          CHECK (visibility IN ('private', 'public')),
  lang            TEXT    NOT NULL DEFAULT 'vi',

  -- Đồng bộ với Vectorize bằng HASH nội dung, không phải số phiên bản:
  -- content_hash = sha256(embedText + '|' + MODEL_ID), nên đổi model là mọi hàng
  -- tự động trở thành "bẩn" mà không cần migration hay xử lý đặc biệt nào.
  content_hash    TEXT    NOT NULL,
  embedded_hash   TEXT,              -- NULL = chưa từng embed
  embedding_model TEXT,
  embedded_at     INTEGER,
  embed_attempts  INTEGER NOT NULL DEFAULT 0,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_ideas_user_updated  ON ideas(user_id, updated_at DESC);
CREATE INDEX idx_ideas_user_status   ON ideas(user_id, status, updated_at DESC);
CREATE INDEX idx_ideas_user_platform ON ideas(user_id, platform, updated_at DESC);

-- Index bộ phận = danh sách việc cần đối soát. Nó luôn nhỏ vì chỉ chứa những hàng
-- có vector đang thiếu hoặc đã cũ.
CREATE INDEX idx_ideas_dirty ON ideas(updated_at)
  WHERE embedded_hash IS NULL OR embedded_hash <> content_hash;

-- Từ vựng tag riêng theo từng user: không có rò rỉ tag giữa các tài khoản.
CREATE TABLE tags (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX idx_tags_user ON tags(user_id, name);

CREATE TABLE idea_tags (
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (idea_id, tag_id)
);
CREATE INDEX idx_idea_tags_tag ON idea_tags(tag_id);

CREATE TABLE idea_likes (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id    TEXT    NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, idea_id)
);
CREATE INDEX idx_idea_likes_user ON idea_likes(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Hạ tầng phụ trợ
-- ---------------------------------------------------------------------------

-- "Vector sở thích": trung bình cộng embedding của các ý tưởng user đã thích.
-- vector là Float32Array(1024) => đúng 4096 byte.
CREATE TABLE user_profile_vectors (
  user_id      TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vector       BLOB    NOT NULL,
  model        TEXT    NOT NULL,
  source_count INTEGER NOT NULL,
  source_hash  TEXT    NOT NULL,   -- sha256 của danh sách id đã thích (đã sắp xếp)
  computed_at  INTEGER NOT NULL
);

-- Rate limit cửa sổ cố định. window_start tính bằng GIÂY.
CREATE TABLE rate_limits (
  bucket       TEXT    PRIMARY KEY,   -- 'login:ip:1.2.3.4' | 'login:email:a@b.c' | ...
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start);

-- Vector mà hàng D1 đã bị xoá nhưng lệnh xoá trên Vectorize thất bại.
-- Được rút dần bởi /api/admin/cron. Vector mồ côi không rò rỉ dữ liệu được vì
-- tầng hydrate luôn lọc lại theo user_id, nó chỉ chiếm chỗ trong topK.
CREATE TABLE vector_gc (
  vector_id TEXT    PRIMARY KEY,
  user_id   TEXT    NOT NULL,
  queued_at INTEGER NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE schema_migrations (
  version    TEXT    PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
INSERT INTO schema_migrations (version, applied_at) VALUES ('0001_init', unixepoch() * 1000);
