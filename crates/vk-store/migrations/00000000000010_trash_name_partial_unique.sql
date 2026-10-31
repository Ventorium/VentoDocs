-- 00000000000010_trash_name_partial_unique.sql
-- 修复：删除（移入回收站）后重新上传/创建同名项报「同级已存在同名文件」。
-- 原 UNIQUE(directory_id, name) / UNIQUE(parent_id, name) 为全量约束，软删除
-- （deleted_at IS NOT NULL）的行仍占用名称槽位，导致同名项无法重建。
-- 改为部分唯一索引：仅对未删除项强制同级唯一名；回收站中的项不再占名。
-- restore/rename/move 的预检均已按 deleted_at IS NULL（排除自身）过滤，语义一致；
-- restore UPDATE 的 23505（并发窗口）在代码侧另行映射为 NameConflict。

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_directory_id_name_key;
ALTER TABLE directories DROP CONSTRAINT IF EXISTS directories_parent_id_name_key;

CREATE UNIQUE INDEX files_directory_id_name_live_key
    ON files (directory_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX directories_parent_id_name_live_key
    ON directories (parent_id, name) WHERE deleted_at IS NULL;
