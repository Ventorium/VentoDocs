-- JWT 吊销：每个用户一个凭证版本号。
--
-- 签发 token 时把 token_version 写进 claims.ver；认证中间件要求 ver 与库中值一致。
-- 改密 / 禁用 / 删除 / 主动登出时自增，即可让该用户**已签发但未过期**的所有 token
-- 立即失效（无需服务端黑名单，水平扩展也天然一致）。
-- 老 token 无 ver 字段 → serde 默认 0，与初始值一致，升级不打断在线会话。
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
