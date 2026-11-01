-- 性能审计补索引（M2.40）
--
-- 背景：权限解析、文件名搜索、通知中心是三条最热的查询路径。
-- 目录 path 是 id 物化路径（`/id1/id2`），前缀匹配需要 text_pattern_ops
-- （默认排序规则下 btree 索引用不了 `LIKE 'prefix%'`）。

-- 1) 搜索：`d.path LIKE ANY(prefix%)` 的前缀索引
CREATE INDEX IF NOT EXISTS idx_directories_path_pattern
    ON directories (path text_pattern_ops);

-- 2) 团队授权解析：`WHERE user_id = $1`（主键是 (team_id, user_id)，用不上）
CREATE INDEX IF NOT EXISTS idx_team_members_user
    ON team_members (user_id);

-- 3) 搜索可见目录集合 / 个人根视图过滤：`WHERE d.created_by = $1`
CREATE INDEX IF NOT EXISTS idx_directories_created_by
    ON directories (created_by);

-- 4) 通知中心 / 审计按 actor 过滤 + ts 倒序
CREATE INDEX IF NOT EXISTS idx_audit_actor
    ON audit_logs (actor_id, ts DESC) WHERE actor_id IS NOT NULL;

-- 5) 回收站列表（仅已删除行，倒序）
CREATE INDEX IF NOT EXISTS idx_files_trashed
    ON files (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_directories_trashed
    ON directories (deleted_at DESC) WHERE deleted_at IS NOT NULL;
