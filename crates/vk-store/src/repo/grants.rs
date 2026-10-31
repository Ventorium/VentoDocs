//! 目录 ACL：授权 CRUD + 沿祖先路径链的权限解析（vk-core::perm 纯计算）。

use super::{Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
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

    /// M2.23：创建/更新文件级授权（upsert）。
    pub async fn upsert_for_file(
        pool: &PgPool,
        file_id: Uuid,
        principal_type: &str,
        principal_id: Uuid,
        perms: Perm,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO file_grants (id, file_id, principal_type, principal_id, perms)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (file_id, principal_type, principal_id)
             DO UPDATE SET perms = EXCLUDED.perms",
        )
        .bind(Uuid::now_v7())
        .bind(file_id)
        .bind(principal_type)
        .bind(principal_id)
        .bind(perms.bits() as i32)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// M2.23：删除文件级授权（该主体在此文件上回退为目录继承权限）。
    pub async fn remove_for_file(
        pool: &PgPool,
        file_id: Uuid,
        principal_type: &str,
        principal_id: Uuid,
    ) -> Result<()> {
        sqlx::query(
            "DELETE FROM file_grants WHERE file_id = $1 AND principal_type = $2 AND principal_id = $3",
        )
        .bind(file_id)
        .bind(principal_type)
        .bind(principal_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// M2.23：列出文件上的全部文件级授权。
    pub async fn list_for_file(pool: &PgPool, file_id: Uuid) -> Result<Vec<FileGrant>> {
        let rows = sqlx::query_as::<_, FileGrantRow>(
            "SELECT id, file_id, principal_type, principal_id, perms, created_at
             FROM file_grants WHERE file_id = $1 ORDER BY principal_type, principal_id",
        )
        .bind(file_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(FileGrant::from_row).collect())
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

    /// 分享给我的目录（scope='me'：直接授给我的 user 授权；scope='team'：授给我所在团队的 team 授权）。
    /// 排除我创建的目录（那是「个人」空间的）；perms 为链解析后的有效权限位。
    pub async fn list_shared(pool: &PgPool, user_id: Uuid, scope: &str) -> Result<Vec<SharedDir>> {
        let rows = if scope == "me" {
            sqlx::query(
                r#"
                SELECT d.id, d.name, d.path, d.parent_id, d.created_by,
                       u.display_name AS owner_name,
                       NULL::text AS team_name
                FROM grants g
                JOIN directories d ON d.id = g.directory_id AND d.deleted_at IS NULL AND d.is_trash = FALSE
                LEFT JOIN users u ON u.id = d.created_by
                WHERE g.principal_type = 'user' AND g.principal_id = $1
                  AND d.created_by IS DISTINCT FROM $1
                ORDER BY d.name
                "#,
            )
            .bind(user_id)
            .fetch_all(pool)
            .await?
        } else if scope == "team" {
            sqlx::query(
                r#"
                SELECT d.id, d.name, d.path, d.parent_id, d.created_by,
                       u.display_name AS owner_name,
                       MIN(t.name) AS team_name
                FROM grants g
                JOIN directories d ON d.id = g.directory_id AND d.deleted_at IS NULL AND d.is_trash = FALSE
                LEFT JOIN users u ON u.id = d.created_by
                JOIN teams t ON t.id = g.principal_id
                JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1
                WHERE g.principal_type = 'team'
                  AND d.created_by IS DISTINCT FROM $1
                GROUP BY d.id, d.name, d.path, d.parent_id, d.created_by, u.display_name
                ORDER BY d.name
                "#,
            )
            .bind(user_id)
            .fetch_all(pool)
            .await?
        } else {
            return Err(StoreError::NotFound(format!("未知分享作用域：{scope}")));
        };
        let mut out: Vec<SharedDir> = Vec::with_capacity(rows.len());
        let mut seen = std::collections::HashSet::new();
        for r in rows {
            let id: Uuid = r.get(0);
            if !seen.insert(id) {
                continue
            }
            let perms = Self::resolve(pool, user_id, id, false).await?;
            out.push(SharedDir {
                id,
                name: r.get(1),
                path: r.get(2),
                parent_id: r.get(3),
                created_by: r.get(4),
                owner_name: r.get(5),
                team_name: r.get(6),
                perms: perms.bits() as u16,
            });
        }
        Ok(out)
    }

    /// 文件的有效权限（M2.23 文件级授权；M2.36 创建者规则）：
    /// 1. 管理员旁路（始终 ALL）；
    /// 2. 文件创建者恒等于 ALL（模型文档语义：创建者对自己的文件有完全控制，
    ///    即使文件位于他人创建、仅授权部分权限位的目录中——例如仅有上传权限
    ///    的协作者上传的文件，其上传者也应能重命名/删除自己上传的文件）；
    /// 3. 若该用户（直接 user 授权 ∪ 其所在团队的 team 授权）在文件上存在文件级授权，
    ///    取这些授权的并集——覆盖所在目录链上同一主体的全部目录授权（可为 0）；
    /// 4. 否则回退为所在目录链的有效权限（与目录授权向后兼容）。
    pub async fn resolve_for_file(
        pool: &PgPool,
        user_id: Uuid,
        file_id: Uuid,
        is_admin: bool,
    ) -> Result<Perm> {
        if is_admin {
            return Ok(Perm::all());
        }
        let row: Option<(Uuid, Option<Uuid>)> =
            sqlx::query_as::<_, (Uuid, Option<Uuid>)>(
                "SELECT directory_id, created_by FROM files WHERE id = $1",
            )
            .bind(file_id)
            .fetch_optional(pool)
            .await?;
        let (directory_id, created_by) =
            row.ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;
        // M2.36：文件创建者恒等于 ALL（与目录创建者规则对齐）
        if created_by == Some(user_id) {
            return Ok(Perm::all());
        }
        // SUM 聚合恒返回 1 行；空集 → NULL。必须按 Option 解码，
        // 否则 sqlx 对 i64 解码 NULL 报 "unexpected null"（M2.32 e2e 发现并修复）。
        // None = 该主体无任何文件级授权 → 回退目录链；Some(v) = 文件级并集（覆盖目录链）。
        let file_union: Option<i64> = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT SUM(perms) FROM file_grants
             WHERE file_id = $1 AND (
                (principal_type = 'user' AND principal_id = $2)
                OR (principal_type = 'team' AND principal_id IN (SELECT team_id FROM team_members WHERE user_id = $2))
             )",
        )
        .bind(file_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        if let Some(v) = file_union {
            return Ok(Perm::from_bits_retain(v as u16));
        }
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

#[derive(Debug, Clone, sqlx::FromRow)]
struct FileGrantRow {
    id: Uuid,
    file_id: Uuid,
    principal_type: String,
    principal_id: Uuid,
    perms: i32,
    created_at: DateTime<Utc>,
}

/// M2.23：文件级授权。
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileGrant {
    pub id: Uuid,
    pub file_id: Uuid,
    pub principal_type: String,
    pub principal_id: Uuid,
    pub perms: u16,
    pub created_at: DateTime<Utc>,
}

impl FileGrant {
    fn from_row(r: FileGrantRow) -> Self {
        Self {
            id: r.id,
            file_id: r.file_id,
            principal_type: r.principal_type,
            principal_id: r.principal_id,
            perms: r.perms as u16,
            created_at: r.created_at,
        }
    }
}

/// 分享给我/我所在团队的目录项。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SharedDir {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub parent_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    /// 目录创建者显示名（即「来自谁」）。
    pub owner_name: Option<String>,
    /// scope=team 时：分享该目录的团队名；scope=me 时为 None。
    pub team_name: Option<String>,
    /// 当前用户对该目录链解析后的有效权限位。
    pub perms: u16,
}
