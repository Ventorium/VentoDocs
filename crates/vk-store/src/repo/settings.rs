//! 用户设置持久化（KV，JSONB 值）。

use super::Result;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct SettingRow {
    value: serde_json::Value,
}

pub struct UserSettings;

impl UserSettings {
    /// 读取某用户某 key 的设置；未设置过返回 None。
    pub async fn get(pool: &PgPool, user_id: Uuid, key: &str) -> Option<serde_json::Value> {
        let r: Option<SettingRow> = sqlx::query_as(
            "SELECT value FROM user_settings WHERE user_id = $1 AND key = $2",
        )
        .bind(user_id)
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()?;
        r.map(|r| r.value)
    }

    /// 写入（整体覆盖）某用户某 key 的设置。
    pub async fn put(
        pool: &PgPool,
        user_id: Uuid,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO user_settings (user_id, key, value, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (user_id, key)
             DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
        )
        .bind(user_id)
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
        Ok(())
    }
}

/// 系统级设置持久化（KV，JSONB 值）。M2.24：key='share' 存放分享端口 / 外网域名配置。
pub struct SystemSettings;

impl SystemSettings {
    /// 读取某 key 的系统设置；未设置过返回 None。
    pub async fn get(pool: &PgPool, key: &str) -> Option<serde_json::Value> {
        let r: Option<SettingRow> = sqlx::query_as("SELECT value FROM system_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .ok()?;
        r.map(|r| r.value)
    }

    /// 写入（整体覆盖）某 key 的系统设置。
    pub async fn put(pool: &PgPool, key: &str, value: &serde_json::Value) -> Result<()> {
        sqlx::query(
            "INSERT INTO system_settings (key, value, updated_at)
             VALUES ($1, $2, now())
             ON CONFLICT (key)
             DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
        Ok(())
    }
}
