//! 分享持久化：创建 / 查询 / 撤销 / 下载计数（原子）。

use super::{Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
use vk_core::ids::gen_share_token;
use vk_core::model::Share;

const SHARE_SELECT: &str = "id, token, shareable_type, shareable_id, password_hash, expires_at, \
     max_downloads, download_count, access_count, preview_only, revoked, created_by, created_at";

#[derive(FromRow)]
struct ShareRow {
    id: Uuid,
    token: String,
    shareable_type: String,
    shareable_id: Uuid,
    password_hash: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    max_downloads: Option<i32>,
    download_count: i32,
    access_count: i32,
    preview_only: bool,
    revoked: bool,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
}

fn to_share(r: &ShareRow) -> Share {
    Share {
        id: r.id,
        token: r.token.clone(),
        resource_type: r.shareable_type.clone(),
        resource_id: r.shareable_id,
        password_hash: r.password_hash.clone(),
        expires_at: r.expires_at,
        max_downloads: r.max_downloads,
        download_count: r.download_count,
        access_count: r.access_count,
        preview_only: r.preview_only,
        revoked: r.revoked,
        created_by: r.created_by,
        created_at: r.created_at,
    }
}

pub struct Shares;

impl Shares {
    /// 创建分享记录（生成不可枚举 token）。
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        pool: &PgPool,
        resource_type: &str,
        resource_id: Uuid,
        password_hash: Option<&str>,
        expires_at: Option<DateTime<Utc>>,
        max_downloads: Option<i32>,
        preview_only: bool,
        created_by: Uuid,
    ) -> Result<Share> {
        let id = Uuid::now_v7();
        let token = gen_share_token();
        sqlx::query(
            "INSERT INTO shares (id, token, shareable_type, shareable_id, password_hash,
                                 expires_at, max_downloads, preview_only, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(id)
        .bind(&token)
        .bind(resource_type)
        .bind(resource_id)
        .bind(password_hash)
        .bind(expires_at)
        .bind(max_downloads)
        .bind(preview_only)
        .bind(created_by)
        .execute(pool)
        .await?;
        Self::get(pool, id).await
    }

    pub async fn get(pool: &PgPool, id: Uuid) -> Result<Share> {
        let r: ShareRow = sqlx::query_as(&format!("SELECT {SHARE_SELECT} FROM shares WHERE id = $1"))
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("分享 {id}")))?;
        Ok(to_share(&r))
    }

    pub async fn get_by_token(pool: &PgPool, token: &str) -> Result<Option<Share>> {
        let r: Option<ShareRow> =
            sqlx::query_as(&format!("SELECT {SHARE_SELECT} FROM shares WHERE token = $1"))
                .bind(token)
                .fetch_optional(pool)
                .await?;
        Ok(r.map(|r| to_share(&r)))
    }

    /// 列出某资源的全部分享（最新在前）。
    pub async fn list_for_resource(
        pool: &PgPool,
        resource_type: &str,
        resource_id: Uuid,
    ) -> Result<Vec<Share>> {
        let rows: Vec<ShareRow> = sqlx::query_as(&format!(
            "SELECT {SHARE_SELECT} FROM shares
             WHERE shareable_type = $1 AND shareable_id = $2
             ORDER BY created_at DESC, id DESC"
        ))
        .bind(resource_type)
        .bind(resource_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.iter().map(to_share).collect())
    }

    /// 撤销分享（幂等）。
    pub async fn revoke(pool: &PgPool, id: Uuid) -> Result<()> {
        let n = sqlx::query("UPDATE shares SET revoked = true WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("分享 {id}")));
        }
        Ok(())
    }

    /// 撤销某资源的全部分享（文件/目录 purge 时调用）。
    pub async fn revoke_for_resource(
        pool: &PgPool,
        resource_type: &str,
        resource_id: Uuid,
    ) -> Result<u64> {
        let n = sqlx::query(
            "UPDATE shares SET revoked = true
             WHERE shareable_type = $1 AND shareable_id = $2 AND revoked = false",
        )
        .bind(resource_type)
        .bind(resource_id)
        .execute(pool)
        .await?
        .rows_affected();
        Ok(n)
    }

    /// 访问计数 +1（每次成功校验的访问）。
    pub async fn increment_access(pool: &PgPool, id: Uuid) -> Result<()> {
        sqlx::query("UPDATE shares SET access_count = access_count + 1 WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// 原子下载计数：仅当未撤销、未过期、未达上限时 +1。
    /// 返回是否成功计数（false = 已用尽 / 失效）。
    pub async fn try_increment_download(pool: &PgPool, id: Uuid) -> Result<bool> {
        let n = sqlx::query(
            "UPDATE shares SET download_count = download_count + 1
             WHERE id = $1 AND revoked = false
               AND (expires_at IS NULL OR expires_at > now())
               AND (max_downloads IS NULL OR download_count < max_downloads)",
        )
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();
        Ok(n > 0)
    }
}
