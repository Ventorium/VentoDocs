-- 00000000000007_system_settings_share_scope.sql — M2.24：系统设置（分享端口/外网域名）+ 分享内网/外网范围

-- 系统级设置（KV，JSONB 值）。key='share' 存放分享链接配置：
--   { "port": 8081, "external_enabled": false, "external_domain": "" }
CREATE TABLE system_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 分享范围：internal 内网链接 / external 外网链接（需系统开启外网域名）
ALTER TABLE shares ADD COLUMN scope text NOT NULL DEFAULT 'internal'
    CHECK (scope IN ('internal','external'));
