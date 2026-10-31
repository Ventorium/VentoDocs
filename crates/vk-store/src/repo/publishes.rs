//! 目录网站发布持久化：publish_id 每目录持久，复启复用同一 ID。

use super::{Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
use vk_core::ids::gen_publish_id;
use vk_core::model::{Directory, PublishedDir};

const PUB_SELECT: &str =
    "id, directory_id, publish_id, enabled, policy, password_hash, site_mode, created_by, created_at, updated_at";

#[derive(FromRow)]
struct PubRow {
    id: Uuid,
    directory_id: Uuid,
    publish_id: String,
    enabled: bool,
    policy: String,
    password_hash: Option<String>,
    /// M2.28：站点模式 static | spa | file_index。
    site_mode: String,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

fn to_pub(r: PubRow) -> PublishedDir {
    PublishedDir {
        id: r.id,
        directory_id: r.directory_id,
        publish_id: r.publish_id.clone(),
        enabled: r.enabled,
        policy: r.policy.clone(),
        password_hash: r.password_hash.clone(),
        has_password: r.password_hash.is_some(),
        site_mode: r.site_mode,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

#[derive(FromRow)]
struct PubDirRow {
    id: Uuid,
    directory_id: Uuid,
    publish_id: String,
    enabled: bool,
    policy: String,
    password_hash: Option<String>,
    site_mode: String,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    dir_name: String,
    dir_path: String,
    dir_is_trash: bool,
    dir_deleted_at: Option<DateTime<Utc>>,
}

/// 发布记录 + 其目录（含回收站状态，供 410 判定）。
#[derive(Debug, Clone)]
pub struct PublishWithDir {
    pub publish: PublishedDir,
    pub directory: Directory,
}

pub struct Publishes;

impl Publishes {
    /// 按目录查发布记录（不存在 → None）。
    pub async fn get_by_directory(pool: &PgPool, directory_id: Uuid) -> Result<Option<PublishedDir>> {
        let r: Option<PubRow> =
            sqlx::query_as(&format!("SELECT {PUB_SELECT} FROM published_dirs WHERE directory_id = $1"))
                .bind(directory_id)
                .fetch_optional(pool)
                .await?;
        Ok(r.map(to_pub))
    }

    /// 按 publish_id 查发布记录 + 目录（目录含回收站，供 410 / 越界判定）。
    pub async fn get_by_publish_id(pool: &PgPool, publish_id: &str) -> Result<Option<PublishWithDir>> {
        let r: Option<PubDirRow> = sqlx::query_as(
            "SELECT p.id, p.directory_id, p.publish_id, p.enabled, p.policy, p.password_hash, p.site_mode, p.created_by, p.created_at, p.updated_at,
                    d.name AS dir_name, d.path AS dir_path, d.is_trash AS dir_is_trash, d.deleted_at AS dir_deleted_at
               FROM published_dirs p
               JOIN directories d ON d.id = p.directory_id
              WHERE p.publish_id = $1",
        )
        .bind(publish_id)
        .fetch_optional(pool)
        .await?;
        let r = match r {
            Some(r) => r,
            None => return Ok(None),
        };
        let directory = Directory {
            id: r.directory_id,
            parent_id: None,
            name: r.dir_name,
            path: r.dir_path,
            is_trash: r.dir_is_trash,
            deleted_at: r.dir_deleted_at,
            created_by: r.created_by,
            created_at: r.created_at,
        };
        let publish = to_pub(PubRow {
            id: r.id,
            directory_id: r.directory_id,
            publish_id: r.publish_id,
            enabled: r.enabled,
            policy: r.policy,
            password_hash: r.password_hash,
            site_mode: r.site_mode,
            created_by: r.created_by,
            created_at: r.created_at,
            updated_at: r.updated_at,
        });
        Ok(Some(PublishWithDir { publish, directory }))
    }

    /// 开启/更新发布：无记录则创建并生成 publish_id，否则复用同一 ID 并启用。
    /// M2.26：password_hash 为站点密码哈希（None = 清除/未设置）。
    /// M2.28：site_mode = static | spa | file_index（默认 static）。
    pub async fn upsert_enable(
        pool: &PgPool,
        directory_id: Uuid,
        policy: &str,
        password_hash: Option<&str>,
        site_mode: &str,
        created_by: Uuid,
    ) -> Result<PublishedDir> {
        let r: PubRow = sqlx::query_as(
            "INSERT INTO published_dirs (id, directory_id, publish_id, enabled, policy, password_hash, site_mode, created_by)
             VALUES ($1, $2, $3, true, $4, $5, $6, $7)
             ON CONFLICT (directory_id) DO UPDATE SET
                enabled = true,
                policy = EXCLUDED.policy,
                password_hash = EXCLUDED.password_hash,
                site_mode = EXCLUDED.site_mode,
                updated_at = now()
             RETURNING id, directory_id, publish_id, enabled, policy, password_hash, site_mode, created_by, created_at, updated_at",
        )
        .bind(Uuid::now_v7())
        .bind(directory_id)
        .bind(gen_publish_id())
        .bind(policy)
        .bind(password_hash)
        .bind(site_mode)
        .bind(created_by)
        .fetch_one(pool)
        .await?;
        Ok(to_pub(r))
    }

    /// 关闭发布（行保留，仅切 enabled=false，保留 publish_id 供复启复用）。
    pub async fn disable(pool: &PgPool, directory_id: Uuid) -> Result<()> {
        let n = sqlx::query("UPDATE published_dirs SET enabled = false, updated_at = now() WHERE directory_id = $1")
            .bind(directory_id)
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("目录 {directory_id} 无发布记录")));
        }
        Ok(())
    }
}
