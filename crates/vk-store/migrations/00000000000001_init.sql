-- 00000000000001_init.sql — VentoKnowledge 初始 schema（v1 全量）

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 用户（两级：admin / user；本地或 LDAP 导入）
CREATE TABLE users (
    id            uuid PRIMARY KEY,
    username      text NOT NULL UNIQUE,
    display_name  text NOT NULL,
    password_hash text,                          -- 本地用户必填；LDAP 导入用户为空
    auth_provider text NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local','ldap')),
    role          text NOT NULL DEFAULT 'user'  CHECK (role IN ('admin','user')),
    disabled      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
    id         uuid PRIMARY KEY,
    name       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
    team_id  uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);

-- 目录树：path 为物化路径（'/' 分隔 id 的 slug 形式），根目录固定 UUID
CREATE TABLE directories (
    id         uuid PRIMARY KEY,
    parent_id  uuid REFERENCES directories(id) ON DELETE RESTRICT,
    name       text NOT NULL,
    path       text NOT NULL,                    -- 例: /a1b2/c3d4/
    is_trash   boolean NOT NULL DEFAULT false,
    deleted_at timestamptz,                      -- 进入回收站的时间（软删除）
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (parent_id, name)
);
CREATE INDEX idx_directories_path ON directories (path);
CREATE INDEX idx_directories_parent ON directories (parent_id) WHERE parent_id IS NOT NULL;

-- 固定根目录（常量 UUID，便于代码引用）
INSERT INTO directories (id, parent_id, name, path, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000001', NULL, '根目录', '/', now(), now());

-- 文件（元数据；内容在本地对象存储）
CREATE TABLE files (
    id              uuid PRIMARY KEY,
    directory_id    uuid NOT NULL REFERENCES directories(id) ON DELETE RESTRICT,
    name            text NOT NULL,
    size            bigint NOT NULL DEFAULT 0,
    sha256          text NOT NULL,               -- 内容寻址 key
    mime            text NOT NULL DEFAULT 'application/octet-stream',
    current_version integer NOT NULL DEFAULT 1,
    created_by      uuid REFERENCES users(id),
    deleted_at      timestamptz,                 -- 回收站（软删除）
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (directory_id, name)
);
CREATE INDEX idx_files_directory ON files (directory_id);
CREATE INDEX idx_files_sha ON files (sha256);
CREATE INDEX idx_files_name_trgm ON files USING gin (name gin_trgm_ops);

-- 版本：恢复 = 新增版本；编辑保存 = 新增版本
CREATE TABLE file_versions (
    id          uuid PRIMARY KEY,
    file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version     integer NOT NULL,
    sha256      text NOT NULL,
    size        bigint NOT NULL,
    note        text,
    created_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (file_id, version)
);
CREATE INDEX idx_file_versions_file ON file_versions (file_id, version DESC);

-- 持久锁：锁定不随登出消失；解锁仅锁定人或管理员
CREATE TABLE file_locks (
    file_id    uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    locked_by  uuid NOT NULL REFERENCES users(id),
    locked_at  timestamptz NOT NULL DEFAULT now()
);

-- 授权：只挂在目录上；principal 为用户或团队
CREATE TABLE grants (
    id             uuid PRIMARY KEY,
    directory_id   uuid NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
    principal_type text NOT NULL CHECK (principal_type IN ('user','team')),
    principal_id   uuid NOT NULL,
    perms          integer NOT NULL,             -- Perm 位集（int 存储）
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (directory_id, principal_type, principal_id)
);
CREATE INDEX idx_grants_dir ON grants (directory_id);
CREATE INDEX idx_grants_principal ON grants (principal_id);

-- 分享：文件或目录；token 52 位 base62（256-bit）
CREATE TABLE shares (
    id             uuid PRIMARY KEY,
    token          text NOT NULL UNIQUE,
    shareable_type text NOT NULL CHECK (shareable_type IN ('file','directory')),
    shareable_id   uuid NOT NULL,
    created_by     uuid REFERENCES users(id),
    password_hash  text,                         -- NULL = 无密码
    expires_at     timestamptz,                  -- NULL = 不过期
    max_downloads  integer,                      -- NULL = 不限
    download_count integer NOT NULL DEFAULT 0,
    preview_only   boolean NOT NULL DEFAULT false,
    revoked        boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shares_shareable ON shares (shareable_type, shareable_id);

-- 目录网站发布：publish_id 16 位随机，每目录持久，复启复用
CREATE TABLE published_dirs (
    id          uuid PRIMARY KEY,
    directory_id uuid NOT NULL UNIQUE REFERENCES directories(id) ON DELETE CASCADE,
    publish_id  text NOT NULL UNIQUE,            -- 16 位 [a-z2-9]
    enabled     boolean NOT NULL DEFAULT true,
    created_by  uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 审计：与业务同事务写入
CREATE TABLE audit_logs (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts            timestamptz NOT NULL DEFAULT now(),
    actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    category      text NOT NULL,                 -- auth|file|share|publish|lock|agent|admin
    action        text NOT NULL,
    resource_type text,
    resource_id   text,
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip            text
);
CREATE INDEX idx_audit_ts ON audit_logs (ts DESC);
CREATE INDEX idx_audit_category ON audit_logs (category, ts DESC);

-- v2 预留：索引任务（zvec-grep）
CREATE TABLE index_jobs (
    id          uuid PRIMARY KEY,
    file_id     uuid REFERENCES files(id) ON DELETE CASCADE,
    status      text NOT NULL DEFAULT 'pending',
    attempts    integer NOT NULL DEFAULT 0,
    last_error  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_index_jobs_status ON index_jobs (status) WHERE status IN ('pending','failed');
