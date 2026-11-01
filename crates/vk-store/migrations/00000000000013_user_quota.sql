-- 个人存储配额（M2.43）
--
-- `quota_bytes` 为 NULL 表示不限制（默认）。占用按「未删除（不在回收站）文件
-- 的当前版本大小」统计，回收站与历史版本不计入（删除即释放配额，语义对用户更直观；
-- 历史版本由后台 janitor 按 VIENTO_VERSION_KEEP 裁剪）。
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS quota_bytes bigint;

-- 配额统计按创建者聚合（`WHERE created_by = $1 AND deleted_at IS NULL`）
CREATE INDEX IF NOT EXISTS idx_files_created_by
    ON files (created_by) WHERE created_by IS NOT NULL;
