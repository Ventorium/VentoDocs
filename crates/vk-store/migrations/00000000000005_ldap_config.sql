-- 0005：LDAP 在线配置（§15 在线化扩展）
-- 单行表（id 恒为 1），管理员经 /api/v1/users/ldap/config 维护。
-- bind_password 为 AES-256-GCM 密文（hex：12 字节随机 nonce ‖ 密文），NULL 表示未设置；
-- 密钥 = SHA-256(VIENTO_JWT_SECRET)。
-- 表内无行时，系统回退 VIENTO_LDAP_* 环境变量。
CREATE TABLE ldap_config (
    id            integer     PRIMARY KEY CHECK (id = 1),
    host          text        NOT NULL,
    port          integer     NOT NULL CHECK (port > 0 AND port < 65536),
    start_tls     boolean     NOT NULL DEFAULT false,
    base_dn       text        NOT NULL DEFAULT '',
    bind_dn       text        NOT NULL DEFAULT '',
    bind_password text,
    user_filter   text        NOT NULL DEFAULT '(objectClass=inetOrgPerson)',
    attr_username text        NOT NULL DEFAULT 'uid',
    attr_name     text        NOT NULL DEFAULT 'cn',
    attr_email    text        NOT NULL DEFAULT 'mail',
    updated_at    timestamptz NOT NULL DEFAULT now()
);
