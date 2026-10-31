//! 文件操作：上传（内容寻址）、版本化保存、下载/预览流、回收站、移动/复制。

use super::{Result, StoreError};
use crate::object_store::UploadResult;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;
use vk_core::model::FileMeta;

#[derive(sqlx::FromRow)]
struct FileRow {
    id: Uuid,
    directory_id: Uuid,
    name: String,
    size: i64,
    mime: String,
    current_version: i32,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    version: i32,
    sha256: String,
    size: i64,
    note: Option<String>,
    created_by: Option<Uuid>,
    encoding: String,
}

fn to_meta(r: &FileRow) -> FileMeta {
    FileMeta {
        id: r.id,
        directory_id: r.directory_id,
        name: r.name.clone(),
        size: r.size.max(0) as u64,
        mime: r.mime.clone(),
        current_version: r.current_version.max(0) as u32,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
        deleted_at: r.deleted_at,
    }
}

const FILE_SELECT: &str = "id, directory_id, name, size, sha256, mime, current_version, \
     created_by, created_at, updated_at, deleted_at FROM files";

pub struct Files;

impl Files {
    async fn get_row(pool: &PgPool, file_id: Uuid) -> Result<FileRow> {
        let r = sqlx::query_as::<_, FileRow>(&format!("SELECT {FILE_SELECT} WHERE id = $1"))
            .bind(file_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;
        Ok(r)
    }

    pub async fn get_meta(pool: &PgPool, file_id: Uuid) -> Result<FileMeta> {
        let r = Self::get_row(pool, file_id).await?;
        Ok(to_meta(&r))
    }

    pub async fn get_meta_including_trash(pool: &PgPool, file_id: Uuid) -> Result<FileMeta> {
        let r: FileRow = sqlx::query_as(&format!("SELECT {FILE_SELECT} WHERE id = $1"))
            .bind(file_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;
        Ok(to_meta(&r))
    }

    /// 上传新文件：对象写入由调用方先完成（内容寻址），此处只登记元数据。
    pub async fn create(
        pool: &PgPool,
        directory_id: Uuid,
        name: &str,
        mime: &str,
        sha: &UploadResult,
        created_by: Uuid,
    ) -> Result<FileMeta> {
        let id = Uuid::now_v7();
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO files (id, directory_id, name, size, sha256, mime, current_version, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, 1, $7)",
        )
        .bind(id)
        .bind(directory_id)
        .bind(name)
        .bind(sha.size as i64)
        .bind(&sha.sha256)
        .bind(mime)
        .bind(created_by)
        .execute(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                StoreError::NameConflict(format!("同级已存在同名文件：{name}"))
            }
            other => other.into(),
        })?;
        // 初始版本行（v1，原始上传字节 = office 编码）
        sqlx::query(
            "INSERT INTO file_versions (id, file_id, version, sha256, size, note, created_by, encoding)
             VALUES ($1, $2, 1, $3, $4, NULL, $5, 'office')",
        )
        .bind(Uuid::now_v7())
        .bind(id)
        .bind(&sha.sha256)
        .bind(sha.size as i64)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Self::get_meta(pool, id).await
    }

    /// 版本化保存（需求 §8.3 单事务）：
    /// 行锁 → 校验基线版本 → 检查持久锁 → 写入版本行 → 更新 current_version → 审计同事务。
    #[allow(clippy::too_many_arguments)]
    pub async fn save_version(
        pool: &PgPool,
        file_id: Uuid,
        base_version: u32,
        new_object: &UploadResult,
        note: Option<&str>,
        encoding: &str,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<FileMeta> {
        let mut tx = pool.begin().await?;

        // 1. 行锁
        let row: FileRow =
            sqlx::query_as(&format!("SELECT {FILE_SELECT} WHERE id = $1 FOR UPDATE"))
                .bind(file_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;

        // 2. 基线版本校验（乐观锁）
        if row.deleted_at.is_some() {
            return Err(StoreError::Internal("文件已删除，不能保存".into()));
        }
        if row.current_version as u32 != base_version {
            return Err(StoreError::VersionConflict {
                expected: base_version,
                actual: row.current_version.max(0) as u32,
            });
        }

        // 3. 持久锁检查（与权限检查独立；锁定人不匹配即拒绝）
        let lock: Option<(Uuid,)> =
            sqlx::query_as("SELECT locked_by FROM file_locks WHERE file_id = $1")
                .bind(file_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some((locked_by,)) = lock
            && locked_by != actor
        {
            return Err(StoreError::FileLocked);
        }

        // 4. 新版本行
        let new_version = row.current_version + 1;
        sqlx::query(
            "INSERT INTO file_versions (id, file_id, version, sha256, size, note, created_by, encoding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(Uuid::now_v7())
        .bind(file_id)
        .bind(new_version)
        .bind(&new_object.sha256)
        .bind(new_object.size as i64)
        .bind(note)
        .bind(actor)
        .bind(encoding)
        .execute(&mut *tx)
        .await?;

        // 5. 更新 current_version
        sqlx::query(
            "UPDATE files SET current_version = $2, size = $3, updated_at = now() WHERE id = $1",
        )
        .bind(file_id)
        .bind(new_version)
        .bind(new_object.size as i64)
        .execute(&mut *tx)
        .await?;

        // 6. 审计同事务
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "save",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({ "version": new_version, "note": note }),
            ip,
        )
        .await?;

        tx.commit().await?;
        Self::get_meta(pool, file_id).await
    }

    /// 恢复某个历史版本 = 新增一个版本（对象已存在，直接引用 sha）。
    pub async fn restore_version(
        pool: &PgPool,
        file_id: Uuid,
        target_version: u32,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<FileMeta> {
        let mut tx = pool.begin().await?;
        let row: FileRow =
            sqlx::query_as(&format!("SELECT {FILE_SELECT} WHERE id = $1 FOR UPDATE"))
                .bind(file_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;

        if row.deleted_at.is_some() {
            return Err(StoreError::Internal("文件已删除".into()));
        }

        let lock: Option<(Uuid,)> =
            sqlx::query_as("SELECT locked_by FROM file_locks WHERE file_id = $1")
                .bind(file_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some((locked_by,)) = lock
            && locked_by != actor
        {
            return Err(StoreError::FileLocked);
        }

        let (sha, size, encoding): (String, i64, String) = sqlx::query_as(
            "SELECT sha256, size, encoding FROM file_versions WHERE file_id = $1 AND version = $2",
        )
        .bind(file_id)
        .bind(target_version as i32)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("版本 {target_version}")))?;

        let new_version = row.current_version + 1;
        sqlx::query(
            "INSERT INTO file_versions (id, file_id, version, sha256, size, note, created_by, encoding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(Uuid::now_v7())
        .bind(file_id)
        .bind(new_version)
        .bind(&sha)
        .bind(size)
        .bind(Some(format!("恢复自版本 {target_version}")))
        .bind(actor)
        .bind(&encoding)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE files SET current_version = $2, size = $3, updated_at = now() WHERE id = $1",
        )
        .bind(file_id)
        .bind(new_version)
        .bind(size)
        .execute(&mut *tx)
        .await?;

        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "restore_version",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({ "from_version": target_version, "new_version": new_version }),
            ip,
        )
        .await?;

        tx.commit().await?;
        Self::get_meta(pool, file_id).await
    }

    /// 进入回收站（软删除）。
    pub async fn trash(pool: &PgPool, file_id: Uuid, actor: Uuid, ip: Option<&str>) -> Result<()> {
        let mut tx = pool.begin().await?;
        let n = sqlx::query("UPDATE files SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL")
            .bind(file_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("文件 {file_id}")));
        }
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "trash",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({}),
            ip,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// 从回收站恢复；同名冲突时由调用方决定重命名方案。
    pub async fn restore(
        pool: &PgPool,
        file_id: Uuid,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<FileMeta> {
        let mut tx = pool.begin().await?;
        let row: FileRow =
            sqlx::query_as(&format!("SELECT {FILE_SELECT} WHERE id = $1 FOR UPDATE"))
                .bind(file_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;
        if row.deleted_at.is_none() {
            return Err(StoreError::InvalidInput("文件不在回收站".into()));
        }

        // 检查目标目录是否有同名（排除自身）
        let exists: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM files WHERE directory_id = $1 AND name = $2 AND id <> $3 AND deleted_at IS NULL",
        )
        .bind(row.directory_id)
        .bind(&row.name)
        .bind(file_id)
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_some() {
            return Err(StoreError::NameConflict(row.name.clone()));
        }

        // 并发窗口：预检后出现同名存活文件 → 部分唯一索引 23505 → NameConflict（勿 500）
        sqlx::query("UPDATE files SET deleted_at = NULL, updated_at = now() WHERE id = $1")
            .bind(file_id)
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
            "restore",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({}),
            ip,
        )
        .await?;
        tx.commit().await?;
        Self::get_meta(pool, file_id).await
    }

    /// 回收站冲突恢复：重命名为 `name (n).ext`。
    pub async fn restore_with_rename(
        pool: &PgPool,
        file_id: Uuid,
        target_dir: Uuid,
        new_name: &str,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<FileMeta> {
        let mut tx = pool.begin().await?;
        let n = sqlx::query(
            "UPDATE files SET deleted_at = NULL, directory_id = $2, name = $3, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL",
        )
        .bind(file_id)
        .bind(target_dir)
        .bind(new_name)
        .execute(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                StoreError::NameConflict(format!("同级已存在同名文件：{new_name}"))
            }
            other => other.into(),
        })?
        .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("回收站文件 {file_id}")));
        }
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "restore_rename",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({ "new_name": new_name }),
            ip,
        )
        .await?;
        tx.commit().await?;
        Self::get_meta(pool, file_id).await
    }

    /// 移动文件；重名时若 allow_rename 则自动加 (n)。
    pub async fn move_to(
        pool: &PgPool,
        file_id: Uuid,
        target_dir: Uuid,
        new_name: Option<&str>,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<FileMeta> {
        let mut tx = pool.begin().await?;
        let row: FileRow =
            sqlx::query_as(&format!("SELECT {FILE_SELECT} WHERE id = $1 FOR UPDATE"))
                .bind(file_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;
        if row.deleted_at.is_some() {
            return Err(StoreError::InTrash);
        }
        let name = new_name.unwrap_or(&row.name).to_string();

        let dup: Option<()> = sqlx::query_as::<_, (i32,)>(
            "SELECT 1 FROM files WHERE directory_id = $1 AND name = $2 AND id <> $3 AND deleted_at IS NULL",
        )
        .bind(target_dir)
        .bind(&name)
        .bind(file_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(|_| ());
        if dup.is_some() {
            return Err(StoreError::NameConflict(name.clone()));
        }

        sqlx::query(
            "UPDATE files SET directory_id = $2, name = $3, updated_at = now() WHERE id = $1",
        )
        .bind(file_id)
        .bind(target_dir)
        .bind(&name)
        .execute(&mut *tx)
        .await?;
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "move",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({ "to": target_dir.to_string(), "name": name }),
            ip,
        )
        .await?;
        tx.commit().await?;
        Self::get_meta(pool, file_id).await
    }

    /// 重命名（同目录内改名）。
    pub async fn rename(
        pool: &PgPool,
        file_id: Uuid,
        new_name: &str,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<FileMeta> {
        let name = new_name.trim().to_string();
        if name.is_empty() {
            return Err(StoreError::InvalidInput("文件名不能为空".to_string()));
        }
        let mut tx = pool.begin().await?;
        let row: FileRow =
            sqlx::query_as(&format!("SELECT {FILE_SELECT} WHERE id = $1 FOR UPDATE"))
                .bind(file_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| StoreError::NotFound(format!("文件 {file_id}")))?;
        if row.deleted_at.is_some() {
            return Err(StoreError::InTrash);
        }
        let dup: Option<()> = sqlx::query_as::<_, (i32,)>(
            "SELECT 1 FROM files WHERE directory_id = $1 AND name = $2 AND id <> $3 AND deleted_at IS NULL",
        )
        .bind(row.directory_id)
        .bind(&name)
        .bind(file_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(|_| ());
        if dup.is_some() {
            return Err(StoreError::NameConflict(name.clone()));
        }
        sqlx::query("UPDATE files SET name = $2, updated_at = now() WHERE id = $1")
            .bind(file_id)
            .bind(&name)
            .execute(&mut *tx)
            .await?;
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "file",
            "rename",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({ "from": row.name, "to": name }),
            ip,
        )
        .await?;
        tx.commit().await?;
        Self::get_meta(pool, file_id).await
    }

    /// 复制文件（内容寻址共享对象，仅新建元数据行）。
    pub async fn copy_to(
        pool: &PgPool,
        file_id: Uuid,
        target_dir: Uuid,
        new_name: &str,
        actor: Uuid,
        ip: Option<&str>,
    ) -> Result<FileMeta> {
        let row = Self::get_row(pool, file_id).await?;
        if row.deleted_at.is_some() {
            return Err(StoreError::InTrash);
        }
        let src = to_meta(&row);
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO files (id, directory_id, name, size, sha256, mime, current_version, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(id)
        .bind(target_dir)
        .bind(new_name)
        .bind(src.size as i64)
        .bind(sha_of(pool, file_id).await?)
        .bind(&src.mime)
        .bind(src.current_version as i32)
        .bind(actor)
        .execute(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                StoreError::NameConflict(format!("同级已存在同名文件：{new_name}"))
            }
            other => other.into(),
        })?;
        // 复制全部版本行到新文件（内容寻址共享对象，仅复制元数据）
        let versions: Vec<VersionRow> = sqlx::query_as(
            "SELECT version, sha256, size, note, created_by, encoding
                 FROM file_versions WHERE file_id = $1 ORDER BY version",
        )
        .bind(file_id)
        .fetch_all(pool)
        .await?;
        for v in &versions {
            sqlx::query(
                "INSERT INTO file_versions (id, file_id, version, sha256, size, note, created_by, encoding)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(Uuid::now_v7())
            .bind(id)
            .bind(v.version)
            .bind(&v.sha256)
            .bind(v.size)
            .bind(&v.note)
            .bind(v.created_by)
            .bind(&v.encoding)
            .execute(pool)
            .await?;
        }
        // 审计独立提交
        super::audit::Audit::log(
            pool,
            Some(actor),
            "file",
            "copy",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({ "new_file": id.to_string() }),
            ip,
        )
        .await?;
        Self::get_meta(pool, id).await
    }

    /// 物理删除（回收站过期清理调用）：删元数据+版本，对象由 GC 处理。
    pub async fn purge(pool: &PgPool, file_id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM files WHERE id = $1")
            .bind(file_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// 回收站中的文件列表（倒序按删除时间）。
    pub async fn list_trashed(pool: &PgPool) -> Result<Vec<FileMeta>> {
        let rows: Vec<FileRow> = sqlx::query_as(&format!(
            "SELECT {FILE_SELECT} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.iter().map(to_meta).collect())
    }

    /// 列出文件版本（倒序）。
    pub async fn list_versions(
        pool: &PgPool,
        file_id: Uuid,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<VersionInfo>> {
        Self::get_meta(pool, file_id).await?;
        let rows = sqlx::query_as::<_, VersionInfo>(
            "SELECT v.id, v.file_id, v.version, v.size, v.note, v.created_by, v.created_at,
             v.encoding, COALESCE(u.username, 'system') AS created_by_name
             FROM file_versions v LEFT JOIN users u ON u.id = v.created_by
             WHERE v.file_id = $1 ORDER BY v.version DESC LIMIT $2 OFFSET $3",
        )
        .bind(file_id)
        .bind(limit as i32)
        .bind(offset as i32)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// 下载/预览用：取 current 版本对象引用 `(sha256, 存储编码)`。
    pub async fn current_ref(pool: &PgPool, file_id: Uuid) -> Result<(String, String)> {
        let r = Self::get_row(pool, file_id).await?;
        if r.deleted_at.is_some() {
            return Err(StoreError::NotFound(format!("文件 {file_id} 已删除")));
        }
        let (sha, encoding): (String, String) = sqlx::query_as(
            "SELECT sha256, encoding FROM file_versions WHERE file_id = $1 AND version = $2",
        )
        .bind(file_id)
        .bind(r.current_version)
        .fetch_one(pool)
        .await?;
        Ok((sha, encoding))
    }

    /// 取指定版本对象引用 `(sha256, 存储编码)`（历史版本预览/下载）。
    pub async fn version_ref(
        pool: &PgPool,
        file_id: Uuid,
        version: u32,
    ) -> Result<(String, String)> {
        let (sha, encoding): (String, String) = sqlx::query_as(
            "SELECT sha256, encoding FROM file_versions WHERE file_id = $1 AND version = $2",
        )
        .bind(file_id)
        .bind(version as i32)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("版本 {version}")))?;
        Ok((sha, encoding))
    }

    /// 持久锁：原子锁定（INSERT ON CONFLICT DO NOTHING，受影响 0 行=已锁定）。
    pub async fn lock(pool: &PgPool, file_id: Uuid, actor: Uuid, ip: Option<&str>) -> Result<bool> {
        Self::get_meta(pool, file_id).await?;
        let mut tx = pool.begin().await?;
        let n = sqlx::query(
            "INSERT INTO file_locks (file_id, locked_by) VALUES ($1, $2)
             ON CONFLICT (file_id) DO NOTHING",
        )
        .bind(file_id)
        .bind(actor)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            tx.rollback().await?;
            return Ok(false);
        }
        super::audit::Audit::log_tx(
            &mut *tx,
            Some(actor),
            "lock",
            "lock",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({}),
            ip,
        )
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    /// 解锁：仅锁定人或管理员（管理员由上层判断后传入 force=true）。
    pub async fn unlock(
        pool: &PgPool,
        file_id: Uuid,
        actor: Uuid,
        force: bool,
        ip: Option<&str>,
    ) -> Result<()> {
        let n = sqlx::query(
            "DELETE FROM file_locks WHERE file_id = $1 AND ($2::boolean OR locked_by = $3)",
        )
        .bind(file_id)
        .bind(force)
        .bind(actor)
        .execute(pool)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound("未找到有效锁".into()));
        }
        super::audit::Audit::log(
            pool,
            Some(actor),
            "lock",
            "unlock",
            Some("file"),
            Some(&file_id.to_string()),
            serde_json::json!({ "force": force }),
            ip,
        )
        .await?;
        Ok(())
    }

    pub async fn get_lock(pool: &PgPool, file_id: Uuid) -> Result<Option<(Uuid, DateTime<Utc>)>> {
        sqlx::query_as::<_, (Uuid, DateTime<Utc>)>(
            "SELECT locked_by, locked_at FROM file_locks WHERE file_id = $1",
        )
        .bind(file_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
    }
}

async fn sha_of(pool: &PgPool, file_id: Uuid) -> Result<String> {
    let (sha,): (String,) = sqlx::query_as("SELECT sha256 FROM files WHERE id = $1")
        .bind(file_id)
        .fetch_one(pool)
        .await?;
    Ok(sha)
}

/// 文件名加后缀避免冲突：`a.docx` -> `a (1).docx`
pub fn unique_name(base: &str, exists: &dyn Fn(&str) -> bool) -> String {
    let (stem, ext) = split_name(base);
    let mut i = 1u32;
    loop {
        let candidate = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        if !exists(&candidate) {
            return candidate;
        }
        i += 1;
    }
}

fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(p) if p > 0 => (&name[..p], &name[p + 1..]),
        _ => (name, ""),
    }
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct VersionInfo {
    pub id: Uuid,
    pub file_id: Uuid,
    pub version: i32,
    pub size: i64,
    pub note: Option<String>,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub created_by_name: String,
    pub encoding: String,
}
