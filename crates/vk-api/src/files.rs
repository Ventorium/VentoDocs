//! 文件 API：上传/下载/在线编辑保存/锁/回收站/版本/移动/复制。
//!
//! 权限：全部入口服务端校验（§8.3）；锁 ⊥ 权限（写操作同时要求无他人持锁）。

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::header;
use axum::response::Response;
use bytes::Bytes;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, ReadBuf};
use uuid::Uuid;
use vk_core::model::{FileLock, FileMeta};
use vk_core::perm::Perm;
use vk_store::StoreError;
use vk_store::object_store::UploadResult;
use vk_store::repo::audit::Audit;
use vk_store::repo::directories::Directories;
use vk_store::repo::files::{Files, VersionInfo};
use vk_store::repo::grants::Grants;
use vk_store::repo::users::Users;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::ApiError;

/// 检查用户对文件是否具有指定权限（经其所在目录解析）。
async fn require_file_perm(
    pool: &sqlx::PgPool,
    user: &AuthUser,
    file_id: Uuid,
    need: Perm,
) -> Result<(), ApiError> {
    let have = Grants::resolve_for_file(pool, user.id, file_id, user.is_admin).await?;
    if have.contains(need) {
        Ok(())
    } else {
        Err(ApiError::forbidden("无权限执行该操作"))
    }
}

/// 写操作前的锁预检（权威检查仍在 save_version 事务内；这里为了返回锁定人姓名）。
async fn lock_precheck(
    pool: &sqlx::PgPool,
    user: &AuthUser,
    file_id: Uuid,
) -> Result<(), ApiError> {
    if let Some((locked_by, _)) = Files::get_lock(pool, file_id).await?
        && locked_by != user.id
    {
        let name = Users::get_by_id(pool, locked_by)
            .await
            .ok()
            .map(|u| u.display_name)
            .unwrap_or_else(|| locked_by.to_string());
        return Err(ApiError::file_locked(Some(serde_json::json!({
            "locked_by": locked_by,
            "locked_by_name": name,
        }))));
    }
    Ok(())
}

/// 当前锁的展示信息（未锁定 → None）。
async fn lock_info(pool: &sqlx::PgPool, file_id: Uuid) -> Result<Option<FileLock>, StoreError> {
    let (locked_by, locked_at) = match Files::get_lock(pool, file_id).await? {
        Some(v) => v,
        None => return Ok(None),
    };
    let name = Users::get_by_id(pool, locked_by)
        .await
        .ok()
        .map(|u| u.display_name)
        .unwrap_or_else(|| locked_by.to_string());
    Ok(Some(FileLock {
        locked_by,
        locked_by_name: name,
        locked_at,
    }))
}

/// multipart 字段流 → AsyncRead 适配器（axum MultipartField 只暴露字节流）。
struct StreamReader<S> {
    stream: S,
    buf: bytes::BytesMut,
}

impl<S> StreamReader<S> {
    fn new(stream: S) -> Self {
        Self {
            stream,
            buf: bytes::BytesMut::new(),
        }
    }
}

impl<S> AsyncRead for StreamReader<S>
where
    S: Stream<Item = Result<Bytes, axum::extract::multipart::MultipartError>> + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            if self.buf.is_empty() {
                match Pin::new(&mut self.stream).poll_next(cx) {
                    Poll::Ready(Some(Ok(chunk))) => {
                        self.buf.extend_from_slice(&chunk);
                        continue;
                    }
                    Poll::Ready(Some(Err(e))) => {
                        return Poll::Ready(Err(io::Error::other(format!(
                            "multipart 流中断：{e:?}",
                        ))));
                    }
                    Poll::Ready(None) => return Poll::Ready(Ok(())),
                    Poll::Pending => return Poll::Pending,
                }
            }
            let n = buf.remaining().min(self.buf.len());
            if n == 0 {
                return Poll::Ready(Ok(()));
            }
            buf.put_slice(&self.buf.split_to(n));
            return Poll::Ready(Ok(()));
        }
    }
}

/// 从扩展名猜测 MIME（避免引入额外依赖）。
fn guess_mime(name: &str) -> String {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt" | "log" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

/// RFC5987 UTF-8 百分号编码（用于 Content-Disposition filename*）。
fn pct_rfc5987(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'&'
            | b'+'
            | b'-'
            | b'.'
            | b'_'
            | b'^'
            | b'`'
            | b'|'
            | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn content_disposition(name: &str, download: bool) -> String {
    let ascii_fallback: String = name
        .chars()
        .filter(|c| c.is_ascii() && *c != '"' && *c != '\\')
        .collect();
    let enc = pct_rfc5987(name);
    if download {
        format!(
            "attachment; filename=\"{}\"; filename*=UTF-8''{}",
            ascii_fallback, enc
        )
    } else {
        format!("inline; filename*=UTF-8''{}", enc)
    }
}

/// 把 tokio::fs::File 切成 256KiB 字节流。
fn file_stream(file: tokio::fs::File) -> impl Stream<Item = Result<Bytes, io::Error>> {
    let reader = tokio::io::BufReader::new(file);
    futures_util::stream::unfold(reader, move |mut reader| async move {
        let mut buf = vec![0u8; 256 * 1024];
        match reader.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), reader))
            }
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => None,
            Err(e) => Some((Err(e), reader)),
        }
    })
}

/// 上传：multipart 单文件 → 对象存储（流式 sha256）→ 元数据行。
pub async fn upload(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(dir_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    let have = Grants::resolve(pool, user.id, dir_id, user.is_admin).await?;
    if !have.contains(Perm::CREATE_UPLOAD) {
        return Err(ApiError::forbidden("无权限在该目录上传"));
    }

    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("multipart 解析失败：{e:?}")))?
        .ok_or_else(|| ApiError::bad_request("缺少上传文件"))?;
    let file_name = field
        .file_name()
        .filter(|n| !n.is_empty())
        .unwrap_or("未命名文件")
        .to_string();

    let stream = field;
    let reader = StreamReader::new(stream);
    let obj = state
        .objects
        .ingest(reader, state.cfg.max_upload_bytes)
        .await
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("超过上限") {
                ApiError::upload_too_large()
            } else {
                ApiError::internal(format!("文件写入失败：{msg}"))
            }
        })?;

    let meta = Files::create(
        pool,
        dir_id,
        &file_name,
        &guess_mime(&file_name),
        &obj,
        user.id,
    )
    .await?;
    Audit::log(
        pool,
        Some(user.id),
        "file",
        "upload",
        Some("file"),
        Some(&meta.id.to_string()),
        serde_json::json!({ "name": file_name, "size": obj.size, "directory_id": dir_id }),
        None,
    )
    .await?;
    Ok(Json(meta))
}

/// 文件元信息（含锁与当前用户权限位）。
#[derive(Serialize)]
pub struct FileOut {
    pub file: FileMeta,
    pub lock: Option<FileLock>,
    pub my_perms: u16,
}

pub async fn meta(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<FileOut>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::READ_PREVIEW).await?;
    let file = Files::get_meta(pool, id).await?;
    let lock = lock_info(pool, id).await?;
    let perms = Grants::resolve_for_file(pool, user.id, id, user.is_admin).await?;
    Ok(Json(FileOut {
        file,
        lock,
        my_perms: perms.bits(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct ContentQuery {
    /// 指定历史版本（缺省 = 当前版本）
    #[serde(default)]
    pub version: Option<u32>,
    /// preview | download（缺省 = download）
    #[serde(default)]
    pub purpose: Option<String>,
}

/// 文件内容流式下载 / 在线预览。
pub async fn content(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Query(q): Query<ContentQuery>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let download = q.purpose.as_deref() != Some("preview");
    let need = if download {
        Perm::DOWNLOAD
    } else {
        Perm::READ_PREVIEW
    };
    require_file_perm(pool, &user, id, need).await?;

    let file = Files::get_meta(pool, id).await?;
    let sha = match q.version {
        Some(v) => Files::version_sha(pool, id, v).await?,
        None => Files::current_sha(pool, id).await?,
    };
    let obj = state
        .objects
        .open(&sha)
        .await
        .map_err(|_| ApiError::not_found("文件对象不存在（存储损坏）"))?;
    let len = obj
        .metadata()
        .await
        .map_err(|e| ApiError::internal(format!("读取文件元数据失败：{e}")))?
        .len();

    let stream = file_stream(obj);
    let response = Response::builder()
        .header(header::CONTENT_TYPE, file.mime)
        .header(
            header::CONTENT_DISPOSITION,
            content_disposition(&file.name, download),
        )
        .header(header::CONTENT_LENGTH, len.to_string())
        .body(Body::from_stream(stream))
        .map_err(|e| ApiError::internal(format!("构造响应失败：{e}")))?;
    Ok(response)
}

/// 在线编辑保存：multipart（file + base_version + note?）→ 新版本。
pub async fn save(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::MODIFY_RENAME).await?;
    let file = Files::get_meta(pool, id).await?;
    lock_precheck(pool, &user, id).await?;

    let mut base_version: u32 = file.current_version;
    let mut note: Option<String> = None;
    let mut obj: Option<UploadResult> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("multipart 解析失败：{e:?}")))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                if obj.is_some() {
                    return Err(ApiError::bad_request("file 字段重复"));
                }
                let reader = StreamReader::new(field);
                obj = Some(
                    state
                        .objects
                        .ingest(reader, state.cfg.max_upload_bytes)
                        .await
                        .map_err(|e| {
                            let msg = e.to_string();
                            if msg.contains("超过上限") {
                                ApiError::upload_too_large()
                            } else {
                                ApiError::internal(format!("文件写入失败：{msg}"))
                            }
                        })?,
                );
            }
            "base_version" => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("base_version 读取失败：{e:?}")))?;
                base_version = text
                    .trim()
                    .parse()
                    .map_err(|_| ApiError::bad_request("base_version 必须是整数"))?;
            }
            "note" => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("note 读取失败：{e:?}")))?;
                let t = text.trim().to_string();
                if !t.is_empty() {
                    note = Some(t);
                }
            }
            _ => {}
        }
    }
    let obj = obj.ok_or_else(|| ApiError::bad_request("缺少 file 字段"))?;

    let meta =
        Files::save_version(pool, id, base_version, &obj, note.as_deref(), user.id, None).await?;
    Ok(Json(meta))
}

#[derive(Debug, Deserialize)]
pub struct VersionsQuery {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

/// 版本列表。
pub async fn versions(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Query(q): Query<VersionsQuery>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<VersionInfo>>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::READ_PREVIEW).await?;
    let limit = q.limit.unwrap_or(20).min(200);
    let list = Files::list_versions(pool, id, limit, q.offset.unwrap_or(0)).await?;
    Ok(Json(list))
}

/// 恢复历史版本 = 追加一个新版本。
pub async fn restore_version(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path((id, version)): Path<(Uuid, u32)>,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::MODIFY_RENAME).await?;
    lock_precheck(pool, &user, id).await?;
    let meta = Files::restore_version(pool, id, version, user.id, None).await?;
    Ok(Json(meta))
}

/// 锁定文件（持久锁；锁 ⊥ 权限，持锁人才能写）。
pub async fn lock(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::READ_PREVIEW).await?;
    match Files::lock(pool, id, user.id, None).await? {
        true => Ok(Json(serde_json::json!({ "locked": true }))),
        false => {
            // 已被他人锁定
            let (locked_by, locked_at) = Files::get_lock(pool, id)
                .await?
                .ok_or_else(|| ApiError::conflict("文件已被锁定"))?;
            let name = Users::get_by_id(pool, locked_by)
                .await
                .ok()
                .map(|u| u.display_name)
                .unwrap_or_else(|| locked_by.to_string());
            Err(ApiError::file_locked(Some(serde_json::json!({
                "locked_by": locked_by,
                "locked_by_name": name,
                "locked_at": locked_at,
            }))))
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct UnlockReq {
    #[serde(default)]
    pub force: bool,
}

/// 解锁：仅锁定人或管理员（force）。
pub async fn unlock(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    body: Option<axum::Json<UnlockReq>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let force = body.map(|b| b.0.force).unwrap_or(false);
    if force && !user.is_admin {
        return Err(ApiError::forbidden("仅管理员可强制解锁"));
    }
    let current = Files::get_lock(pool, id).await?;
    if current.is_none() {
        return Err(ApiError::bad_request("文件当前未处于锁定状态"));
    }
    Files::unlock(pool, id, user.id, force, None).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 移入回收站。
pub async fn trash(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::DELETE_RESTORE).await?;
    Files::trash(pool, id, user.id, None).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 从回收站恢复（原目录存在且未删；否则 409 让前端重命名）。
pub async fn restore(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::DELETE_RESTORE).await?;
    match Files::restore(pool, id, user.id, None).await {
        Ok(meta) => Ok(Json(meta)),
        Err(StoreError::NameConflict(name)) => Err(ApiError::conflict("原位置已存在同名文件")
            .with_details(serde_json::json!({ "action": "restore_rename", "name": name }))),
        Err(e) => Err(e.into()),
    }
}

#[derive(Deserialize)]
pub struct RestoreRenameReq {
    pub new_name: String,
}

/// 恢复并重命名（前端选择新名后调用）。
pub async fn restore_rename(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<RestoreRenameReq>,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    if body.new_name.trim().is_empty() {
        return Err(ApiError::bad_request("文件名不能为空"));
    }
    require_file_perm(pool, &user, id, Perm::DELETE_RESTORE).await?;
    // 恢复到文件原所在目录；原目录本身在回收站时提示先恢复目录
    let trashed = Files::get_meta_including_trash(pool, id).await?;
    let dir = Directories::get_including_trash(pool, trashed.directory_id).await?;
    if dir.is_trash {
        return Err(ApiError::conflict("文件原所在目录已在回收站，请先恢复目录")
            .with_details(serde_json::json!({ "directory_id": dir.id })));
    }
    let meta =
        Files::restore_with_rename(pool, id, dir.id, body.new_name.trim(), user.id, None).await?;
    Ok(Json(meta))
}

/// 彻底删除（不可恢复；对象存储 GC 另行清理）。
pub async fn purge(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::DELETE_RESTORE).await?;
    Files::purge(pool, id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct MoveFileReq {
    pub target_directory_id: Uuid,
    #[serde(default)]
    pub new_name: Option<String>,
}

/// 移动（可改名）。
pub async fn move_file(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<MoveFileReq>,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::MOVE_COPY).await?;
    let have_target =
        Grants::resolve(pool, user.id, body.target_directory_id, user.is_admin).await?;
    if !have_target.contains(Perm::CREATE_UPLOAD) {
        return Err(ApiError::forbidden("无权限在目标目录放置文件"));
    }
    let meta = Files::move_to(
        pool,
        id,
        body.target_directory_id,
        body.new_name.as_deref(),
        user.id,
        None,
    )
    .await
    .map_err(|e| match e {
        StoreError::NameConflict(name) => ApiError::conflict("目标位置已存在同名文件")
            .with_details(serde_json::json!({ "action": "rename", "name": name })),
        other => other.into(),
    })?;
    Ok(Json(meta))
}

#[derive(Deserialize)]
pub struct RenameReq {
    pub new_name: String,
}

/// 重命名（同目录内）。
pub async fn rename(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<RenameReq>,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::MODIFY_RENAME).await?;
    let name = body.new_name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("文件名不能为空"));
    }
    let meta = Files::rename(pool, id, &name, user.id, None)
        .await
        .map_err(|e| match e {
            StoreError::NameConflict(name) => ApiError::conflict("同级已存在同名文件")
                .with_details(serde_json::json!({ "action": "rename", "name": name })),
            other => other.into(),
        })?;
    Ok(Json(meta))
}

#[derive(Deserialize)]
pub struct CopyFileReq {
    pub target_directory_id: Uuid,
    /// 缺省沿用原文件名
    #[serde(default)]
    pub new_name: Option<String>,
}

/// 复制（内容寻址共享对象，仅新元数据行）。
pub async fn copy_file(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<CopyFileReq>,
) -> Result<Json<FileMeta>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::MOVE_COPY).await?;
    let have_target =
        Grants::resolve(pool, user.id, body.target_directory_id, user.is_admin).await?;
    if !have_target.contains(Perm::CREATE_UPLOAD) {
        return Err(ApiError::forbidden("无权限在目标目录放置文件"));
    }
    let src = Files::get_meta(pool, id).await?;
    let name = body.new_name.as_deref().unwrap_or(&src.name);
    let meta = Files::copy_to(pool, id, body.target_directory_id, name, user.id, None)
        .await
        .map_err(|e| match e {
            StoreError::NameConflict(name) => ApiError::conflict("目标位置已存在同名文件")
                .with_details(serde_json::json!({ "action": "rename", "name": name })),
            other => other.into(),
        })?;
    Ok(Json(meta))
}

/// 回收站文件列表。
pub async fn list_trashed(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<Vec<FileMeta>>, ApiError> {
    let pool = state.db.pool();
    let all = Files::list_trashed(pool).await?;
    let mut out: Vec<FileMeta> = Vec::with_capacity(all.len());
    for f in all {
        if !user.is_admin
            && f.created_by != Some(user.id)
            && !Grants::resolve_for_file(pool, user.id, f.id, false)
                .await
                .is_ok_and(|p| p.contains(Perm::DELETE_RESTORE))
        {
            continue;
        }
        out.push(f);
    }
    Ok(Json(out))
}
