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
use vk_store::repo::shares::Shares;
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
/// M2.29：`pub(crate)` 供站点文件服务修正 DB 中遗留的 octet-stream（html 被浏览器当下载）。
pub(crate) fn guess_mime(name: &str) -> String {
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
        // M2.29：网页族扩展名（站点静态/SPA 文件服务依赖它纠正 Content-Type）
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "xml" => "application/xml",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "webmanifest" => "application/manifest+json",
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

// ─────────────── M2.23：文件级授权 ───────────────
// 文件可拥有独立于所在目录的授权（file_grants）：某主体存在文件级授权时，
// 其在该文件上的有效权限取文件授权并集，覆盖所在目录链上同一主体的目录授权；
// 无任何文件级授权时回退目录链解析（完全向后兼容）。
// 管理权限 = 文件创建者（M2.35：管理员不再拥有旁路，管理操作归资源原有人）。

#[derive(Serialize)]
pub struct FileGrantOut {
    pub id: Uuid,
    pub file_id: Uuid,
    pub principal_type: String,
    pub principal_id: Uuid,
    pub principal_name: String,
    pub perms: u16,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize)]
pub struct GrantOut {
    pub id: Uuid,
    pub directory_id: Uuid,
    pub principal_type: String,
    pub principal_id: Uuid,
    pub principal_name: String,
    pub perms: u16,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize)]
pub struct InheritedGrants {
    pub directory_id: Uuid,
    pub directory_name: String,
    pub grants: Vec<GrantOut>,
}

#[derive(Serialize)]
pub struct FileGrantsOut {
    pub file_grants: Vec<FileGrantOut>,
    pub inherited: InheritedGrants,
}

/// 主体显示名（用户显示名 / 团队名），解析失败回退 uuid 字符串。
async fn principal_name(pool: &sqlx::PgPool, principal_type: &str, principal_id: Uuid) -> String {
    if principal_type == "user" {
        Users::get_by_id(pool, principal_id)
            .await
            .ok()
            .map(|u| u.display_name)
            .unwrap_or_else(|| principal_id.to_string())
    } else {
        vk_store::repo::teams::Teams::get(pool, principal_id)
            .await
            .ok()
            .map(|t| t.name)
            .unwrap_or_else(|| principal_id.to_string())
    }
}

/// 文件授权管理入口：仅文件创建者（M2.35：管理员无旁路）。
fn require_file_creator(user: &AuthUser, file: &FileMeta) -> Result<(), ApiError> {
    if file.created_by == Some(user.id) {
        Ok(())
    } else {
        Err(ApiError::forbidden("仅文件创建者可管理该文件的授权"))
    }
}

/// 文件授权管理：列出该文件的独立授权 + 所在目录的继承授权。
pub async fn list_file_grants(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<FileGrantsOut>, ApiError> {
    let pool = state.db.pool();
    let file = Files::get_meta(pool, id).await?;
    require_file_creator(&user, &file)?;
    let dir = Directories::get(pool, file.directory_id).await?;
    let file_grants = Grants::list_for_file(pool, id).await?;
    let inherited = Grants::list_for_directory(pool, file.directory_id).await?;
    let file_names = file_grants
        .iter()
        .map(|g| principal_name(pool, &g.principal_type, g.principal_id))
        .collect::<futures_util::future::JoinAll<_>>()
        .await
        .into_iter()
        .collect::<Vec<_>>();
    let file_out: Vec<FileGrantOut> = file_grants
        .iter()
        .zip(file_names)
        .map(
            |(g, name)| FileGrantOut {
                id: g.id,
                file_id: g.file_id,
                principal_type: g.principal_type.clone(),
                principal_id: g.principal_id,
                principal_name: name,
                perms: g.perms,
                created_at: g.created_at,
            },
        )
        .collect();
    let inh_names = inherited
        .iter()
        .map(|g| principal_name(pool, &g.principal_type, g.principal_id))
        .collect::<futures_util::future::JoinAll<_>>()
        .await
        .into_iter()
        .collect::<Vec<_>>();
    let inh_out: Vec<GrantOut> = inherited
        .iter()
        .zip(inh_names)
        .map(
            |(g, name)| GrantOut {
                id: g.id,
                directory_id: g.directory_id,
                principal_type: g.principal_type.clone(),
                principal_id: g.principal_id,
                principal_name: name,
                perms: g.perms,
                created_at: g.created_at,
            },
        )
        .collect();
    Ok(Json(FileGrantsOut {
        file_grants: file_out,
        inherited: InheritedGrants {
            directory_id: dir.id,
            directory_name: dir.name.clone(),
            grants: inh_out,
        },
    }))
}

/// 文件授权管理：创建/更新某主体在文件上的授权（覆盖目录继承）。
pub async fn set_file_grant(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<crate::directories::SetGrantReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let pt = match body.principal_type.as_str() {
        "user" | "team" => body.principal_type.clone(),
        _ => return Err(ApiError::bad_request("principal_type 仅支持 user 或 team")),
    };
    let perms = Perm::validate_ui_input(body.perms)?;
    let file = Files::get_meta(pool, id).await?;
    require_file_creator(&user, &file)?;
    if pt == "user" {
        Users::get_by_id(pool, body.principal_id).await?;
    } else {
        vk_store::repo::teams::Teams::get(pool, body.principal_id).await?;
    }
    Grants::upsert_for_file(pool, id, &pt, body.principal_id, perms).await?;
    Audit::log(
        pool,
        Some(user.id),
        "admin",
        "file_grant_set",
        Some("file"),
        Some(&id.to_string()),
        serde_json::json!({ "principal_type": pt, "principal_id": body.principal_id, "perms": body.perms }),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true, "perms": perms.bits() })))
}

/// 文件授权管理：移除某主体在文件上的授权（该主体在此文件上恢复目录继承权限）。
pub async fn remove_file_grant(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path((id, principal_type, principal_id)): Path<(Uuid, String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let file = Files::get_meta(pool, id).await?;
    require_file_creator(&user, &file)?;
    Grants::remove_for_file(pool, id, &principal_type, principal_id).await?;
    Audit::log(
        pool,
        Some(user.id),
        "admin",
        "file_grant_remove",
        Some("file"),
        Some(&id.to_string()),
        serde_json::json!({ "principal_type": principal_type, "principal_id": principal_id }),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
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
    /// M2.36：当前用户在此文件上的授权权限位（不含管理员旁路；文件创建者恒为
    /// ALL）——文件详情页据此按「实际授权」显隐编辑等按钮。
    pub granted_perms: u16,
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
    // M2.36：不含管理员旁路的授权权限位（文件创建者恒为 ALL）
    let granted = Grants::resolve_for_file(pool, user.id, id, false).await?;
    Ok(Json(FileOut {
        file,
        lock,
        my_perms: perms.bits(),
        granted_perms: granted.bits(),
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
    let (sha, _encoding) = match q.version {
        Some(v) => Files::version_ref(pool, id, v).await?,
        None => Files::current_ref(pool, id).await?,
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

/// 当前版本内容交付（不做权限校验，供分享/发布公开端点调用，调用方自行校验范围）。
pub(super) async fn deliver_current(
    state: &AppState,
    file: &FileMeta,
    download: bool,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let (sha, _encoding) = Files::current_ref(pool, file.id).await?;
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
    Response::builder()
        .header(header::CONTENT_TYPE, file.mime.clone())
        .header(
            header::CONTENT_DISPOSITION,
            content_disposition(&file.name, download),
        )
        .header(header::CONTENT_LENGTH, len.to_string())
        .body(Body::from_stream(file_stream(obj)))
        .map_err(|e| ApiError::internal(format!("构造响应失败：{e}")))
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

    let meta = Files::save_version(
        pool,
        id,
        base_version,
        &obj,
        note.as_deref(),
        "office",
        user.id,
        None,
    )
    .await?;
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
    // 尽力撤销该文件的全部分享（失败仅记录，不影响 purge 结果）
    if let Err(e) = Shares::revoke_for_resource(pool, "file", id).await {
        tracing::warn!("purge 后撤销分享失败 file={id}: {e}");
    }
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

/// 回收站文件项：文件元数据 + 删除前的可读路径。
#[derive(Serialize)]
pub struct TrashedFile {
    #[serde(flatten)]
    pub file: FileMeta,
    pub original_path: String,
}

/// 回收站文件列表。
pub async fn list_trashed(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<Vec<TrashedFile>>, ApiError> {
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
    // 把文件所在目录的 id 路径解析为可读名称路径
    let dir_ids: Vec<Uuid> = out.iter().map(|f| f.directory_id).collect();
    let dir_paths = Directories::paths_by_ids(pool, &dir_ids).await?;
    let mut chain_ids: Vec<Uuid> = Vec::new();
    for path in dir_paths.values() {
        chain_ids.extend(Directories::parse_id_path(path));
    }
    let names = Directories::names_by_ids(pool, &chain_ids).await?;
    let result: Vec<TrashedFile> = out
        .into_iter()
        .map(|f| {
            let path = dir_paths.get(&f.directory_id).cloned().unwrap_or_default();
            let ids = Directories::parse_id_path(&path);
            TrashedFile {
                original_path: Directories::render_id_path(&ids, &names),
                file: f,
            }
        })
        .collect();
    Ok(Json(result))
}

// ────────────────────────────── zip 预览（M2.15）──────────────────────────────

/// zip 列表接口允许读取的最大压缩包大小（512MB，全部读入内存解析）。
const ZIP_LIST_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// zip 内单条内容接口允许解压后的最大大小（128MB，浏览器内预览）。
const ZIP_ENTRY_MAX_BYTES: u64 = 128 * 1024 * 1024;
/// zip 内条目数上限，超出视为异常归档拒绝预览。
const ZIP_ENTRY_MAX_COUNT: usize = 100_000;

/// zip 内单个条目的元数据（name 为归一化后的相对路径，目录不带尾斜杠）。
#[derive(Debug, Serialize)]
pub struct ZipEntryOut {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    /// DOS 时间戳（1980 起，本地时间）转成的 ISO 形式；缺失为 None。
    pub modified: Option<String>,
}

/// zip 列表接口响应。
#[derive(Debug, Serialize)]
pub struct ZipListOut {
    pub name: String,
    pub size: u64,
    pub entry_count: usize,
    pub entries: Vec<ZipEntryOut>,
}

/// 把 zip 内的条目名归一化为正斜杠相对路径（去前导/尾部斜杠、反斜杠转正斜杠）。
fn normalize_zip_name(raw: &str) -> String {
    raw.replace('\\', "/").trim_matches('/').to_string()
}

/// zip DOS 时间戳 → ISO 本地时间字符串（展示用，非精确时区）。
fn dos_datetime_to_iso(dt: zip::DateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    )
}

/// 读取 zip 文件对象到内存（先校验大小上限）。
async fn read_zip_object(state: &AppState, id: Uuid) -> Result<(FileMeta, Vec<u8>), ApiError> {
    let file = Files::get_meta(state.db.pool(), id).await?;
    let (sha, _encoding) = Files::current_ref(state.db.pool(), id).await?;
    let mut obj = state
        .objects
        .open(&sha)
        .await
        .map_err(|_| ApiError::not_found("文件对象不存在（存储损坏）"))?;
    let len = obj
        .metadata()
        .await
        .map_err(|e| ApiError::internal(format!("读取文件元数据失败：{e}")))?
        .len();
    if len > ZIP_LIST_MAX_BYTES {
        return Err(ApiError::bad_request("压缩包过大，暂不支持预览（超过 512MB）"));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    tokio::io::AsyncReadExt::read_to_end(&mut obj, &mut bytes)
        .await
        .map_err(|e| ApiError::internal(format!("读取压缩包失败：{e}")))?;
    Ok((file, bytes))
}

/// 解析 zip 中央目录，返回扁平条目列表（含隐含目录由前端根据路径分组）。
async fn parse_zip_entries(bytes: Vec<u8>) -> Result<Vec<ZipEntryOut>, ApiError> {
    let parsed = tokio::task::spawn_blocking(move || -> Result<Vec<ZipEntryOut>, ApiError> {
        let mut archive = zip::read::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|_| ApiError::bad_request("不是有效的 zip 压缩包"))?;
        if archive.len() > ZIP_ENTRY_MAX_COUNT {
            return Err(ApiError::bad_request("压缩包内文件过多，暂不支持预览"));
        }
        let mut out: Vec<ZipEntryOut> = Vec::with_capacity(archive.len());
        for i in 0..archive.len() {
            let f = archive
                .by_index(i)
                .map_err(|e| ApiError::internal(format!("解析压缩包条目失败：{e}")))?;
            if f.encrypted() {
                return Err(ApiError::bad_request("加密压缩包暂不支持预览"));
            }
            let name = normalize_zip_name(f.name());
            if name.is_empty() {
                continue;
            }
            let is_dir = f.is_dir();
            out.push(ZipEntryOut {
                name: name.trim_end_matches('/').to_string(),
                size: if is_dir { 0 } else { f.size() },
                is_dir,
                modified: f.last_modified().map(dos_datetime_to_iso),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| ApiError::internal(format!("解析压缩包任务失败：{e}")))?;
    parsed
}

/// zip 内条目内容查询参数。
#[derive(Debug, Deserialize)]
pub struct ZipEntryQuery {
    pub path: String,
}

/// 校验 zip 内条目路径：非空、相对路径、不含 `..` 段、不含反斜杠。
fn validate_zip_entry_path(raw: &str) -> Result<String, ApiError> {
    let p = raw.trim();
    if p.is_empty() {
        return Err(ApiError::bad_request("缺少压缩包内文件路径"));
    }
    if p.starts_with('/') || p.contains('\\') {
        return Err(ApiError::bad_request("无效的压缩包内文件路径"));
    }
    if p.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return Err(ApiError::bad_request("无效的压缩包内文件路径"));
    }
    Ok(p.to_string())
}

/// zip 包条目列表：GET /api/v1/files/:id/zip。
/// 返回压缩包内全部条目的相对路径/大小/时间，前端据此做目录树导航。
pub async fn zip_list(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<ZipListOut>, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::READ_PREVIEW).await?;
    let (file, bytes) = read_zip_object(&state, id).await?;
    let entries = parse_zip_entries(bytes).await?;
    Ok(Json(ZipListOut {
        name: file.name,
        size: file.size,
        entry_count: entries.len(),
        entries,
    }))
}

/// zip 包内单个条目内容：GET /api/v1/files/:id/zip-entry?path=...。
/// 按归一化路径精确匹配条目并解压返回原始字节（Content-Disposition: inline）。
pub async fn zip_entry(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Query(q): Query<ZipEntryQuery>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    require_file_perm(pool, &user, id, Perm::READ_PREVIEW).await?;
    let entry_path = validate_zip_entry_path(&q.path)?;
    let entry_path_cmp = entry_path.clone();
    let (_file, bytes) = read_zip_object(&state, id).await?;
    let data = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, ApiError> {
        let mut archive = zip::read::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|_| ApiError::not_found("不是有效的 zip 压缩包"))?;
        // 按归一化名匹配（兼容反斜杠/前导斜杠存储的旧归档），目录条目直接排除
        let mut target: Option<usize> = None;
        for i in 0..archive.len() {
            if let Ok(f) = archive.by_index(i) {
                if normalize_zip_name(f.name()) == entry_path_cmp {
                    target = Some(i);
                    break;
                }
            }
        }
        let Some(idx) = target else {
            return Err(ApiError::not_found("压缩包内不存在该文件"));
        };
        let mut f = archive
            .by_index(idx)
            .map_err(|e| ApiError::internal(format!("读取压缩包条目失败：{e}")))?;
        if f.is_dir() {
            return Err(ApiError::bad_request("该路径是压缩包内的目录"));
        }
        if f.encrypted() {
            return Err(ApiError::bad_request("加密压缩包暂不支持预览"));
        }
        if f.size() > ZIP_ENTRY_MAX_BYTES {
            return Err(ApiError::bad_request("压缩包内文件过大，暂不支持预览（超过 128MB）"));
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        std::io::Read::read_to_end(&mut f, &mut buf)
            .map_err(|e| ApiError::internal(format!("解压压缩包内文件失败：{e}")))?;
        Ok(buf)
    })
    .await
    .map_err(|e| ApiError::internal(format!("解析压缩包任务失败：{e}")))?
    ?;
    let entry_name = entry_path.rsplit('/').next().unwrap_or(&entry_path).to_string();
    let response = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            content_disposition(&entry_name, false),
        )
        .header(header::CONTENT_LENGTH, data.len().to_string())
        .body(Body::from(data))
        .map_err(|e| ApiError::internal(format!("构造响应失败：{e}")))?;
    Ok(response)
}
