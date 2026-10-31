-- 00000000000008_publish_password.sql — M2.26：发布策略 login = 站点密码门（非系统账号）

-- password_hash 存发布时设置的「站点访问密码」argon2 哈希：
-- 仅 policy='login' 使用；anon/preview_only 及未设置密码时为 NULL。
-- 公开页输对密码后由后端签发短期站点 token（sub=publish:{publish_id}）。
ALTER TABLE published_dirs ADD COLUMN password_hash text;
