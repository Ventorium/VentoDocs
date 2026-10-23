//! 目录 ACL：授权 CRUD + 沿祖先路径链的权限解析（vk-core::perm 纯计算）。

use super::{Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;
use vk_core::perm::{DirChain, Perm};

pub struct Grants;

impl Grants {
    /// 创建/更新目录对某主体的授权（upsert）。
    pub async fn upsert(
        pool: &PgPool,
        directory_id: Uuid,
        principal_type: &str,
        principal_id: Uuid,
        perms: Perm,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO grants (id, directory_id, principal_type, principal_id, perms)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (directory_id, principal_type, principal_id)
             DO UPDATE SET perms = EXCLUDED.perms",
        )
        .bind(Uuid::now_v7())
        .bind(directory_id)
        .bind(principal_type)
        .bind(principal_id)
        .bind(perms.bits() as i32)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 删除授权。
    pub async fn remove(
        pool: &PgPool,
        directory_id: Uuid,
        principal_type: &str,
        principal_id: Uuid,
    ) -> Result<()> {
        sqlx::query(
            "DELETE FROM grants WHERE directory_id = $1 AND principal_type = $2 AND principal_id = $3",
        )
        .bind(directory_id)
        .bind(principal_type)
        .bind(principal_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 列出目录上的全部授权。
    pub async fn list_for_directory(pool: &PgPool, directory_id: Uuid) -> Result<Vec<Grant>> {
        let rows = sqlx::query_as::<_, GrantRow>(
            "SELECT id, directory_id, principal_type, principal_id, perms, created_at
             FROM grants WHERE directory_id = $1 ORDER BY principal_type, principal_id",
        )
        .bind(directory_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Grant::from_row).collect())
    }

    /// 解析某用户在某目录的有效权限：
    /// 1. 管理员旁路（core 层处理）；
    /// 2. 目录创建者自动 ALL；
    /// 3. 否则沿 path 链向上收集 user/team 授权并集。
    pub async fn resolve(
        pool: &PgPool,
        user_id: Uuid,
        directory_id: Uuid,
        is_admin: bool,
    ) -> Result<Perm> {
        if is_admin {
            return Ok(Perm::all());
        }
        // 祖先链（含自身）：祖先 D 满足 目标path LIKE D.path || '%'（id 基路径，无通配符字符）
        let rows = sqlx::query_as::<_, ChainRow>(
            "SELECT d.id, d.path, d.created_by,
                    COALESCE(SUM(CASE WHEN g.principal_type = 'user' AND g.principal_id = $1 THEN g.perms ELSE 0 END), 0) AS user_perms,
                    COALESCE(SUM(CASE WHEN g.principal_type = 'team' AND g.principal_id IN (SELECT team_id FROM team_members WHERE user_id = $1) THEN g.perms ELSE 0 END), 0) AS team_perms
             FROM directories d
             LEFT JOIN grants g ON g.directory_id = d.id
             WHERE $2 LIKE d.path || '%'
             GROUP BY d.id, d.path, d.created_by",
        )
        .bind(user_id)
        .bind(self_path(pool, directory_id).await?)
        .fetch_all(pool)
        .await?;

        let mut chain = DirChain::default();
        let mut creator = false;
        for r in &rows {
            chain.layers.push((
                Perm::from_bits_retain(r.user_perms as u16),
                Perm::from_bits_retain(r.team_perms as u16),
            ));
            if r.created_by == Some(user_id) {
                creator = true;
            }
        }
        if creator {
            return Ok(Perm::all());
        }
        Ok(chain.resolve(false))
    }

    /// 文件的有效权限 = 所在目录的有效权限（授权只挂在目录上）。
    pub async fn resolve_for_file(
        pool: &PgPool,
        user_id: Uuid,
        file_id: Uuid,
        is_admin: bool,
    ) -> Result<Perm> {
        let directory_id: Option<Uuid> =
            sqlx::query_as::<_, (Uuid,)>("SELECT directory_id FROM files WHERE id = $1")
                .bind(file_id)
                .fetch_optional(pool)
                .await?
                .map(|r| r.0);
        let directory_id =
            directory_id.ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;
        Self::resolve(pool, user_id, directory_id, is_admin).await
    }
}

async fn self_path(pool: &PgPool, directory_id: Uuid) -> Result<String> {
    sqlx::query_scalar("SELECT path FROM directories WHERE id = $1")
        .bind(directory_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("目录 {directory_id}")))
}

#[derive(sqlx::FromRow)]
struct ChainRow {
    created_by: Option<Uuid>,
    user_perms: i64,
    team_perms: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct GrantRow {
    id: Uuid,
    directory_id: Uuid,
    principal_type: String,
    principal_id: Uuid,
    perms: i32,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Grant {
    pub id: Uuid,
    pub directory_id: Uuid,
    pub principal_type: String,
    pub principal_id: Uuid,
    pub perms: u16,
    pub created_at: DateTime<Utc>,
}

impl Grant {
    fn from_row(r: GrantRow) -> Self {
        Self {
            id: r.id,
            directory_id: r.directory_id,
            principal_type: r.principal_type,
            principal_id: r.principal_id,
            perms: r.perms as u16,
            created_at: r.created_at,
        }
    }
}
