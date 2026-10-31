//! 目录树持久化（M0：创建 / 查询 / 列表；M1 补齐移动 / 重命名 / 回收站）。

use std::collections::{BTreeSet, HashMap};

use super::{ROOT_DIR, Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;
use vk_core::model::{Directory, EntryKind, FileEntry, FileLock, FileMeta};

const DIR_SELECT: &str = "id, parent_id, name, path, is_trash, deleted_at, created_by, created_at";

#[derive(sqlx::FromRow)]
struct DirRow {
    id: Uuid,
    parent_id: Option<Uuid>,
    name: String,
    path: String,
    is_trash: bool,
    deleted_at: Option<DateTime<Utc>>,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
}

fn to_dir(r: &DirRow) -> Directory {
    Directory {
        id: r.id,
        parent_id: r.parent_id,
        name: r.name.clone(),
        path: r.path.clone(),
        is_trash: r.is_trash,
        deleted_at: r.deleted_at,
        created_by: r.created_by,
        created_at: r.created_at,
    }
}

pub struct Directories;

impl Directories {
    /// 取目录；不存在或已删除返回 NotFound。
    pub async fn get(pool: &PgPool, id: Uuid) -> Result<Directory> {
        let r = sqlx::query_as::<_, DirRow>(&format!(
            "SELECT {DIR_SELECT} FROM directories WHERE id = $1 AND deleted_at IS NULL"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("目录 {id}")))?;
        Ok(to_dir(&r))
    }

    /// 根目录。
    pub async fn root(pool: &PgPool) -> Result<Directory> {
        Self::get(pool, ROOT_DIR).await
    }

    /// 在 parent 下创建子目录；名称冲突返回 NameConflict。
    /// path 采用 id 拼接（物化路径），避免名称含通配符影响祖先链 LIKE 匹配。
    pub async fn create(
        pool: &PgPool,
        parent_id: Uuid,
        name: &str,
        creator: Uuid,
    ) -> Result<Directory> {
        let parent = Self::get(pool, parent_id).await?;
        let id = Uuid::now_v7();
        let path = format!("{}/{}", parent.path.trim_end_matches('/'), id);
        sqlx::query(
            "INSERT INTO directories (id, parent_id, name, path, created_by)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(id)
        .bind(Some(parent_id))
        .bind(name)
        .bind(&path)
        .bind(creator)
        .execute(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                StoreError::NameConflict(format!("同级已存在同名项：{name}"))
            }
            other => other.into(),
        })?;
        Self::get(pool, id).await
    }

    /// 列目录内容：子目录 + 文件（未删除），按名称排序。
    pub async fn list_children(pool: &PgPool, dir_id: Uuid) -> Result<(Directory, Vec<EntryKind>)> {
        let dir = Self::get(pool, dir_id).await?;
        let dirs: Vec<DirRow> =
            sqlx::query_as(&format!("SELECT {DIR_SELECT} FROM directories WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY name"))
                .bind(dir_id)
                .fetch_all(pool)
                .await?;
        type DirFileRow = (
            Uuid,
            String,
            i64,
            String,
            i32,
            Uuid,
            DateTime<Utc>,
            DateTime<Utc>,
            Option<Uuid>,
            Option<String>,
            Option<DateTime<Utc>>,
        );
        let files: Vec<DirFileRow> = sqlx::query_as(
            "SELECT f.id, f.name, f.size, f.mime, f.current_version, f.created_by, f.created_at, f.updated_at,
                    l.locked_by, COALESCE(u.display_name, l.locked_by::text), l.locked_at
                 FROM files f
                 LEFT JOIN file_locks l ON l.file_id = f.id
                 LEFT JOIN users u ON u.id = l.locked_by
                 WHERE f.directory_id = $1 AND f.deleted_at IS NULL
                 ORDER BY f.name",
        )
        .bind(dir_id)
        .fetch_all(pool)
        .await?;

        let mut children = Vec::new();
        for d in &dirs {
            children.push(EntryKind::Directory { directory: to_dir(d) });
        }
        for f in files {
            let lock = match (f.8, f.9, f.10) {
                (Some(by), Some(name), Some(at)) => Some(FileLock {
                    locked_by: by,
                    locked_by_name: name,
                    locked_at: at,
                }),
                _ => None,
            };
            children.push(EntryKind::File(FileEntry {
                file: FileMeta {
                    id: f.0,
                    directory_id: dir_id,
                    name: f.1,
                    size: f.2.max(0) as u64,
                    mime: f.3,
                    current_version: f.4.max(0) as u32,
                    created_by: Some(f.5),
                    created_at: f.6,
                    updated_at: f.7,
                    deleted_at: None,
                },
                lock,
            }));
        }
        Ok((dir, children))
    }

    /// 取目录（含回收站中的）。
    pub async fn get_including_trash(pool: &PgPool, id: Uuid) -> Result<Directory> {
        let r = sqlx::query_as::<_, DirRow>(&format!(
            "SELECT {DIR_SELECT} FROM directories WHERE id = $1"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("目录 {id}")))?;
        Ok(to_dir(&r))
    }

    /// 回收站中的目录（M1 回收站页面用）。
    pub async fn list_trashed(pool: &PgPool) -> Result<Vec<Directory>> {
        let rows: Vec<DirRow> = sqlx::query_as(&format!(
            "SELECT {DIR_SELECT} FROM directories WHERE is_trash = TRUE ORDER BY deleted_at DESC"
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.iter().map(to_dir).collect())
    }

    /// 解析目录 id 路径（形如 `/id1/id2`，不含根目录）为 id 列表。
    pub fn parse_id_path(path: &str) -> Vec<Uuid> {
        path.split('/').filter_map(|s| Uuid::parse_str(s).ok()).collect()
    }

    /// 将 id 链渲染为可读名称路径；空链表示根目录。
    pub fn render_id_path(ids: &[Uuid], names: &HashMap<Uuid, String>) -> String {
        if ids.is_empty() {
            return "根目录".to_string();
        }
        let parts: Vec<&str> = ids
            .iter()
            .map(|id| names.get(id).map(String::as_str).unwrap_or("—"))
            .collect();
        format!("/{}", parts.join("/"))
    }

    /// 批量查询目录名称，用于把回收站条目的 id 路径解析为可读原路径。
    pub async fn names_by_ids(pool: &PgPool, ids: &[Uuid]) -> Result<HashMap<Uuid, String>> {
        let uniq: Vec<Uuid> = ids.iter().copied().collect::<BTreeSet<_>>().into_iter().collect();
        if uniq.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id, name FROM directories WHERE id = ANY($1)")
                .bind(&uniq)
                .fetch_all(pool)
                .await?;
        Ok(rows.into_iter().collect())
    }

    /// 批量查询目录 id 路径。
    pub async fn paths_by_ids(pool: &PgPool, ids: &[Uuid]) -> Result<HashMap<Uuid, String>> {
        let uniq: Vec<Uuid> = ids.iter().copied().collect::<BTreeSet<_>>().into_iter().collect();
        if uniq.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id, path FROM directories WHERE id = ANY($1)")
                .bind(&uniq)
                .fetch_all(pool)
                .await?;
        Ok(rows.into_iter().collect())
    }

    /// 重命名；根目录不可改名。
    pub async fn rename(
        pool: &PgPool,
        id: Uuid,
        new_name: &str,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<Directory> {
        if id == ROOT_DIR {
            return Err(StoreError::RootProtected);
        }
        let mut tx = pool.begin().await?;
        let row: DirRow = sqlx::query_as(&format!(
            "SELECT {DIR_SELECT} FROM directories WHERE id = $1 FOR UPDATE"
        ))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("目录 {id}")))?;
        if row.deleted_at.is_some() {
            return Err(StoreError::InTrash);
        }
        sqlx::query("UPDATE directories SET name = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(new_name)
            .execute(&mut *tx)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                    StoreError::NameConflict(format!("同级已存在同名项：{new_name}"))
                }
                other => other.into(),
            })?;
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "dir_rename",
            Some("directory"),
            Some(&id.to_string()),
            serde_json::json!({ "old_name": row.name, "new_name": new_name }),
            ip,
        )
        .await?;
        tx.commit().await?;
        Self::get(pool, id).await
    }

    /// 移动到目标父目录（禁止移入自身或自身子孙）；同步修正子树物化路径。
    pub async fn move_to(
        pool: &PgPool,
        id: Uuid,
        target_parent_id: Uuid,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<Directory> {
        if id == ROOT_DIR {
            return Err(StoreError::RootProtected);
        }
        let mut tx = pool.begin().await?;
        let src: DirRow = sqlx::query_as(&format!(
            "SELECT {DIR_SELECT} FROM directories WHERE id = $1 FOR UPDATE"
        ))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("目录 {id}")))?;
        if src.deleted_at.is_some() {
            return Err(StoreError::InTrash);
        }
        let target: DirRow = sqlx::query_as(&format!(
            "SELECT {DIR_SELECT} FROM directories WHERE id = $1 FOR UPDATE"
        ))
        .bind(target_parent_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::ParentInvalid(target_parent_id))?;
        if target.deleted_at.is_some() {
            return Err(StoreError::ParentInvalid(target_parent_id));
        }
        // 不能移入自身或子孙（path 前缀判断，id 基路径无通配符问题）
        let src_prefix = format!("{}/", src.path.trim_end_matches('/'));
        if target
            .path
            .trim_end_matches('/')
            .starts_with(src_prefix.trim_end_matches('/'))
        {
            return Err(StoreError::Internal("不能移动目录到自身或其子目录".into()));
        }

        let new_parent_path = target.path.trim_end_matches('/');
        // 子孙路径前缀 = 自身旧路径（materialized path 含自身 id）
        let old_prefix = src.path.clone();
        // 先修正子孙路径，再改自身（避免父路径先变导致子树 LIKE 失效）
        let new_path = format!("{new_parent_path}/{id}");
        sqlx::query(
            "UPDATE directories
                SET path = $2 || substring(path, length($1) + 1)
              WHERE path LIKE $1 || '/%' AND id <> $3",
        )
        .bind(&old_prefix)
        .bind(&new_path)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE directories SET parent_id = $2, path = $3, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(target_parent_id)
        .bind(&new_path)
        .execute(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                StoreError::NameConflict(format!("目标同级已存在同名项：{}", src.name))
            }
            other => other.into(),
        })?;
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "dir_move",
            Some("directory"),
            Some(&id.to_string()),
            serde_json::json!({ "target_parent_id": target_parent_id }),
            ip,
        )
        .await?;
        tx.commit().await?;
        Self::get(pool, id).await
    }

    /// 移入回收站（软删除；子树随隐藏，不级联改标记）。
    pub async fn trash(pool: &PgPool, id: Uuid, actor: Uuid, ip: Option<&str>) -> Result<()> {
        if id == ROOT_DIR {
            return Err(StoreError::RootProtected);
        }
        let mut tx = pool.begin().await?;
        let n = sqlx::query(
            "UPDATE directories SET is_trash = TRUE, deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("目录 {id}")));
        }
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "dir_trash",
            Some("directory"),
            Some(&id.to_string()),
            serde_json::json!({}),
            ip,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// 从回收站恢复；同名冲突返回 NameConflict。
    pub async fn restore(
        pool: &PgPool,
        id: Uuid,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<Directory> {
        if id == ROOT_DIR {
            return Err(StoreError::RootProtected);
        }
        let mut tx = pool.begin().await?;
        let row: DirRow = sqlx::query_as(&format!(
            "SELECT {DIR_SELECT} FROM directories WHERE id = $1 FOR UPDATE"
        ))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("目录 {id}")))?;
        if row.deleted_at.is_none() {
            return Err(StoreError::InvalidInput("目录不在回收站".into()));
        }
        if let Some(parent_id) = row.parent_id {
            let exists: Option<(Uuid,)> = sqlx::query_as(
                "SELECT id FROM directories WHERE parent_id = $1 AND name = $2 AND id <> $3 AND deleted_at IS NULL",
            )
            .bind(parent_id)
            .bind(&row.name)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            if exists.is_some() {
                return Err(StoreError::NameConflict(row.name.clone()));
            }
        }
        // 并发窗口：预检后出现同名存活目录 → 部分唯一索引 23505 → NameConflict（勿 500）
        sqlx::query("UPDATE directories SET is_trash = FALSE, deleted_at = NULL, updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                    StoreError::NameConflict(row.name.clone())
                }
                other => other.into(),
            })?;
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "dir_restore",
            Some("directory"),
            Some(&id.to_string()),
            serde_json::json!({}),
            ip,
        )
        .await?;
        tx.commit().await?;
        Self::get(pool, id).await
    }
}
