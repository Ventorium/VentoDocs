-- 00000000000003_m3_share_publish_ldap.sql — M3：分享计数 / 发布策略 / LDAP 用户字段 / 审计匿名访问者

-- 分享：访问计数（每次成功校验的访问 +1）
ALTER TABLE shares ADD COLUMN access_count integer NOT NULL DEFAULT 0;

-- 目录发布：访问策略（anon 匿名 | login 需登录 | preview_only 仅预览）
ALTER TABLE published_dirs ADD COLUMN policy text NOT NULL DEFAULT 'anon'
    CHECK (policy IN ('anon','login','preview_only'));

-- LDAP 导入用户扩展字段（§15）
ALTER TABLE users ADD COLUMN email text;
ALTER TABLE users ADD COLUMN ldap_dn text;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE email IS NOT NULL;

-- 审计：匿名访问者名称（分享访问写 actor_name，actor_id 为 NULL）
ALTER TABLE audit_logs ADD COLUMN actor_name text;
