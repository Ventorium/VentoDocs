-- M2.23: 文件级授权（file_grants）
-- 某主体（user/team）在文件上存在授权时，其在该文件上的有效权限取这些授权的并集，
-- 覆盖所在目录链上同一主体的全部目录授权；无任何文件级授权时回退目录链解析
-- （对未设置文件授权的文件完全向后兼容）。
CREATE TABLE file_grants (
    id             uuid PRIMARY KEY,
    file_id        uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    principal_type text NOT NULL CHECK (principal_type IN ('user', 'team')),
    principal_id   uuid NOT NULL,
    perms          integer NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (file_id, principal_type, principal_id)
);

CREATE INDEX idx_file_grants_file ON file_grants (file_id);
CREATE INDEX idx_file_grants_principal ON file_grants (principal_id);
