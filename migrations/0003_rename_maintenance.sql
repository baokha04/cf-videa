-- Bỏ cron worker: việc dọn dẹp định kỳ nay chạy theo kiểu cơ hội trong chính app,
-- còn việc index ý tưởng thì người dùng bấm nút đồng bộ khi cần.
--
-- Bảng cron_runs không còn liên quan gì tới cron nữa. Đổi tên cho đúng thứ nó ghi:
-- lần bảo trì gần nhất, bất kể do đâu kích hoạt.
ALTER TABLE cron_runs RENAME TO maintenance_runs;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0003_rename_maintenance', unixepoch() * 1000);
