-- Nhịp tim của cron.
--
-- Vì sao cần: một cron chết âm thầm thì không có dấu hiệu gì. Phiên hết hạn cứ chất
-- đống, ý tưởng chưa index cứ nằm đó, và không ai biết cho tới khi có người tình cờ
-- nhận ra. Log không phải lúc nào cũng lấy được (policy egress chặn wrangler tail,
-- token thiếu quyền đọc observability), nên trạng thái phải nằm ở nơi ứng dụng tự
-- đọc được: chính D1.
--
-- Chỉ một hàng duy nhất, ghi đè mỗi lần chạy. /api/health đọc nó ra.
CREATE TABLE cron_runs (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  ran_at       INTEGER NOT NULL,
  sessions_gc  INTEGER NOT NULL DEFAULT 0,
  rate_gc      INTEGER NOT NULL DEFAULT 0,
  vector_gc    INTEGER NOT NULL DEFAULT 0,
  reindexed    INTEGER NOT NULL DEFAULT 0,
  source       TEXT    NOT NULL DEFAULT 'cron'   -- 'cron' | 'manual'
);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0002_cron_heartbeat', unixepoch() * 1000);
