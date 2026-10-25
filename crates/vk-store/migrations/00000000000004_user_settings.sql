-- 用户级设置（KV，JSONB 值）。
-- 桌面外观等偏好按 (user_id, key) 存储，key='desktop' 为桌面设置对象。
CREATE TABLE IF NOT EXISTS user_settings (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        text NOT NULL,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);
