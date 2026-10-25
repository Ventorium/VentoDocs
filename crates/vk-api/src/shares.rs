//! 分享 API：登录态管理（创建/列表/撤销）+ 公开访问端点（无会话，§10）。
//!
//! 公开端点校验链：token → 密码（argon2id 常时间）→ 有效期 → 下载次数（原子）。
//! 分享页不产生登录会话；密码经 `X-Share-Password` 头随每个受校验请求重传。
//! 公开访问审计 category=share，actor=NULL + actor_name="分享访客"。

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vk_core::error::DomainError;
use vk_core::model::{EntryKind, FileMeta, Share};
use vk_core::perm::Perm;
use vk_store::repo::audit::Audit;
use vk_store::repo::directories::Directories;
use vk_store::repo::files::Files;
use vk_store::repo::grants::Grants;
use vk_store::repo::shares::Shares;
use vk_store::repo::users::{hash_password, verify_password};

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::files;

/// 默认分享有效期（天）。
const DEFAULT_EXPIRE_DAYS: i64 = 7;
/// 有效期上限（天）。
const MAX_EXPIRE_DAYS: i64 = 3650;
/// 公开端点密码头。
const SHARE_PASSWORD_HEADER: &str = "x-share-password";

/// 审计中固定使用的访客身份。
pub(super) const SHARE_VISITOR: &str = "分享访客";

// ---------------------------------------------------------------------------
// 登录态：创建 / 列表 / 撤销
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateShareReq {
    /// `file` 或 `directory`
    pub resource_type: String,
    pub resource_id: Uuid,
    /// 访问密码；缺省或空 = 无密码
    #[serde(default)]
    pub password: Option<String>,
    /// 有效期（天）：字段缺省 = 默认 7 天；显式 null = 不限；数字 = N 天
    #[serde(default)]
    pub expires_in_days: Option<Option<i64>>,
    /// 下载次数上限；缺省 = 不限
    #[serde(default)]
    pub max_downloads: Option<i32>,
    /// 仅预览（禁止下载）；缺省 false
    #[serde(default)]
    pub preview_only: bool,
}

/// 对外分享视图：剔除 `password_hash`（哈希绝不外发），补充 `has_password` 供前端展示。
#[derive(Serialize)]
pub struct SharePublic {
    pub id: Uuid,
    pub token: String,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub has_password: bool,
    pub expires_at: Option<chrono::DateTime<Utc>>,
    pub max_downloads: Option<i32>,
    pub download_count: i32,
    pub access_count: i32,
    pub preview_only: bool,
    pub revoked: bool,
    pub created_by: Option<Uuid>,
    pub created_at: chrono::DateTime<Utc>,
}

impl From<&Share> for SharePublic {
    fn from(s: &Share) -> Self {
        Self {
            id: s.id,
            token: s.token.clone(),
            resource_type: s.resource_type.clone(),
            resource_id: s.resource_id,
            has_password: s.password_hash.is_some(),
            expires_at: s.expires_at,
            max_downloads: s.max_downloads,
            download_count: s.download_count,
            access_count: s.access_count,
            preview_only: s.preview_only,
            revoked: s.revoked,
            created_by: s.created_by,
            created_at: s.created_at,
        }
    }
}

#[derive(Serialize)]
pub struct ShareOut {
    pub share: SharePublic,
    /// 前端拼 origin 用：`/s/{token}`
    pub url: String,
}

/// 对分享目标校验 SHARE 权限位。
async fn check_share_perm(
    pool: &sqlx::PgPool,
    user: &AuthUser,
    resource_type: &str,
    resource_id: Uuid,
) -> Result<(), ApiError> {
    let have = match resource_type {
        "file" => {
            Files::get_meta(pool, resource_id).await?;
            Grants::resolve_for_file(pool, user.id, resource_id, user.is_admin).await?
        }
        "directory" => {
            Directories::get(pool, resource_id).await?;
            Grants::resolve(pool, user.id, resource_id, user.is_admin).await?
        }
        _ => return Err(ApiError::bad_request("resource_type 仅支持 file 或 directory")),
    };
    if !have.contains(Perm::SHARE) {
        return Err(ApiError::forbidden("无权限分享该资源"));
    }
    Ok(())
}

/// 创建分享。
pub async fn create(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Json(body): Json<CreateShareReq>,
) -> Result<(StatusCode, Json<ShareOut>), ApiError> {
    let pool = state.db.pool();
    check_share_perm(pool, &user, &body.resource_type, body.resource_id).await?;

    let password = body
        .password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if body.password.as_deref().is_some_and(|s| s.trim().is_empty()) {
        return Err(ApiError::bad_request("访问密码不能为空"));
    }
    let password_hash = password.map(hash_password).transpose()?;

    let expires_at = match body.expires_in_days {
        None => Some(Utc::now() + Duration::days(DEFAULT_EXPIRE_DAYS)),
        Some(None) => None,
        Some(Some(days)) => {
            if !(1..=MAX_EXPIRE_DAYS).contains(&days) {
                return Err(ApiError::bad_request(format!(
                    "有效期需在 1–{MAX_EXPIRE_DAYS} 天之间"
                )));
            }
            Some(Utc::now() + Duration::days(days))
        }
    };
    if body.max_downloads.is_some_and(|m| m < 1) {
        return Err(ApiError::bad_request("下载次数上限需 ≥ 1，留空表示不限"));
    }

    let share = Shares::create(
        pool,
        &body.resource_type,
        body.resource_id,
        password_hash.as_deref(),
        expires_at,
        body.max_downloads,
        body.preview_only,
        user.id,
    )
    .await?;
    Audit::log(
        pool,
        Some(user.id),
        "share",
        "share_create",
        Some(&body.resource_type),
        Some(&body.resource_id.to_string()),
        serde_json::json!({
            "share_id": share.id,
            "expires_at": expires_at,
            "max_downloads": body.max_downloads,
            "preview_only": body.preview_only,
            "has_password": password.is_some(),
        }),
        None,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(ShareOut {
            url: format!("/s/{}", share.token),
            share: (&share).into(),
        }),
    ))
}

#[derive(Deserialize)]
pub struct ListSharesQuery {
    pub resource_type: String,
    pub resource_id: Uuid,
}

#[derive(Serialize)]
pub struct ShareListOut {
    pub shares: Vec<SharePublic>,
}

/// 某资源的全部分享（最新在前）。
pub async fn list(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Query(q): Query<ListSharesQuery>,
) -> Result<Json<ShareListOut>, ApiError> {
    let pool = state.db.pool();
    check_share_perm(pool, &user, &q.resource_type, q.resource_id).await?;
    let shares = Shares::list_for_resource(pool, &q.resource_type, q.resource_id).await?;
    let shares = shares.iter().map(SharePublic::from).collect();
    Ok(Json(ShareListOut { shares }))
}

/// 撤销分享。
pub async fn revoke(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let share = Shares::get(pool, id).await?;
    // 资源可能已在回收站（目录 get 会 404），用 including_trash 变体做权限校验
    let have = match share.resource_type.as_str() {
        "file" => {
            Files::get_meta(pool, share.resource_id).await?;
            Grants::resolve_for_file(pool, user.id, share.resource_id, user.is_admin).await?
        }
        "directory" => {
            Directories::get_including_trash(pool, share.resource_id).await?;
            Grants::resolve(pool, user.id, share.resource_id, user.is_admin).await?
        }
        _ => return Err(ApiError::not_found("分享资源类型无效")),
    };
    if !have.contains(Perm::SHARE) {
        return Err(ApiError::forbidden("无权限管理该分享"));
    }
    Shares::revoke(pool, id).await?;
    Audit::log(
        pool,
        Some(user.id),
        "share",
        "share_revoke",
        Some(&share.resource_type),
        Some(&share.resource_id.to_string()),
        serde_json::json!({ "share_id": share.id }),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// 公开端点（无会话）
// ---------------------------------------------------------------------------

async fn load_share(pool: &sqlx::PgPool, token: &str) -> Result<Share, ApiError> {
    let share = Shares::get_by_token(pool, token)
        .await?
        .filter(|s| !s.revoked)
        .ok_or_else(|| ApiError::not_found("分享链接不存在或已失效"))?;
    Ok(share)
}

fn is_expired(share: &Share) -> bool {
    share.expires_at.is_some_and(|e| e <= Utc::now())
}

/// 校验 X-Share-Password 头（无密码分享直接通过）。
fn check_password(share: &Share, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(hash) = &share.password_hash else {
        return Ok(());
    };
    let provided = headers
        .get(SHARE_PASSWORD_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_password(provided, hash) {
        return Err(DomainError::SharePasswordWrong.into());
    }
    Ok(())
}

/// 已过期 → 410 GONE（带 details.status 供前端展示）。
fn expired_error() -> ApiError {
    ApiError::gone("分享链接已过期")
        .with_details(serde_json::json!({ "status": "expired" }))
}

/// 解析分享资源当前状态：(资源名, 是否已进回收站, 文件元信息（仅文件分享）)。
async fn resource_state(
    pool: &sqlx::PgPool,
    share: &Share,
) -> Result<(String, bool, Option<FileMeta>), ApiError> {
    match share.resource_type.as_str() {
        "file" => {
            let m = Files::get_meta(pool, share.resource_id).await?;
            Ok((m.name.clone(), m.deleted_at.is_some(), Some(m)))
        }
        "directory" => {
            let d = Directories::get_including_trash(pool, share.resource_id).await?;
            Ok((d.name, d.deleted_at.is_some(), None))
        }
        _ => Err(ApiError::not_found("分享资源类型无效")),
    }
}

/// 公开元信息：`GET /api/v1/public/shares/{token}`。
pub async fn public_meta(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let share = load_share(pool, &token).await?;
    let (name, trashed, file) = resource_state(pool, &share).await?;
    if trashed {
        return Err(ApiError::gone("分享内容已删除")
            .with_details(serde_json::json!({ "status": "deleted" })));
    }
    let expired = is_expired(&share);
    // 无密码分享：meta 即一次已校验访问（访问计数 + 审计）
    if !expired && share.password_hash.is_none() {
        let _ = Shares::increment_access(pool, share.id).await;
        let _ = Audit::log_named(
            pool,
            None,
            Some(SHARE_VISITOR),
            "share",
            "share_access",
            Some(&share.resource_type),
            Some(&share.resource_id.to_string()),
            serde_json::json!({ "share_id": share.id }),
            None,
        )
        .await;
    }
    // 文件分享附带文件元信息（size/时间/当前版本），供公开预览页头部展示；目录分享为 null。
    let (size, updated_at, current_version) = match &file {
        Some(m) => (Some(m.size), Some(m.updated_at), Some(m.current_version)),
        None => (None, None, None),
    };
    Ok(Json(serde_json::json!({
        "resourceType": share.resource_type,
        "resourceId": share.resource_id,
        "name": name,
        "hasPassword": share.password_hash.is_some(),
        "status": if expired { "expired" } else { "ok" },
        "previewOnly": share.preview_only,
        "expiresAt": share.expires_at,
        "maxDownloads": share.max_downloads,
        "downloadCount": share.download_count,
        "size": size,
        "updatedAt": updated_at,
        "currentVersion": current_version,
    })))
}

#[derive(Deserialize)]
pub struct VerifyReq {
    #[serde(default)]
    pub password: Option<String>,
}

/// 密码校验：`POST /api/v1/public/shares/{token}/verify`。
pub async fn public_verify(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<VerifyReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let share = load_share(pool, &token).await?;
    if is_expired(&share) {
        return Err(expired_error());
    }
    let hash = share
        .password_hash
        .clone()
        .ok_or_else(|| ApiError::bad_request("该分享未设置密码"))?;
    let provided = body
        .password
        .as_deref()
        .unwrap_or("")
        .to_string();
    let provided = match headers.get(SHARE_PASSWORD_HEADER).and_then(|v| v.to_str().ok()) {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => provided,
    };
    if !verify_password(&provided, &hash) {
        return Err(DomainError::SharePasswordWrong.into());
    }
    let _ = Shares::increment_access(pool, share.id).await;
    let _ = Audit::log_named(
        pool,
        None,
        Some(SHARE_VISITOR),
        "share",
        "share_verify",
        Some(&share.resource_type),
        Some(&share.resource_id.to_string()),
        serde_json::json!({ "share_id": share.id }),
        None,
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct EntriesQuery {
    pub dir_id: Uuid,
}

/// 目录分享子项列表：`GET /api/v1/public/shares/{token}/entries?dir_id=`。
pub async fn public_entries(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<EntriesQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let share = load_share(pool, &token).await?;
    if share.resource_type != "directory" {
        return Err(ApiError::bad_request("该分享不是目录分享"));
    }
    if is_expired(&share) {
        return Err(expired_error());
    }
    check_password(&share, &headers)?;

    let shared = Directories::get_including_trash(pool, share.resource_id).await?;
    if shared.deleted_at.is_some() {
        return Err(ApiError::gone("分享内容已删除")
            .with_details(serde_json::json!({ "status": "deleted" })));
    }
    let target = Directories::get(pool, q.dir_id).await?;
    if !(q.dir_id == shared.id || target.path.starts_with(&shared.path)) {
        return Err(ApiError::forbidden("超出分享范围"));
    }
    let (_dir, entries) = Directories::list_children(pool, q.dir_id).await?;
    Ok(Json(entries_json(&entries)))
}

/// 条目列表（剥除 lock 字段，避免泄露内部锁状态）。
pub(super) fn entries_json(entries: &[EntryKind]) -> serde_json::Value {
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        match e {
            EntryKind::Directory { directory: d } => {
                out.push(serde_json::json!({ "kind": "directory", "directory": d }))
            }
            EntryKind::File(fe) => out.push(serde_json::json!({ "kind": "file", "file": fe.file })),
        }
    }
    serde_json::json!(out)
}

/// 加载分享 + 文件，并做范围校验（目录分享要求文件在子树内）。
async fn load_share_file(
    pool: &sqlx::PgPool,
    token: &str,
    file_id: Uuid,
) -> Result<(Share, FileMeta), ApiError> {
    let share = load_share(pool, token).await?;
    if is_expired(&share) {
        return Err(expired_error());
    }
    let file = Files::get_meta(pool, file_id).await?;
    if file.deleted_at.is_some() {
        return Err(ApiError::gone("分享内容已删除")
            .with_details(serde_json::json!({ "status": "deleted" })));
    }
    if share.resource_type == "file" {
        if share.resource_id != file_id {
            return Err(ApiError::forbidden("超出分享范围"));
        }
    } else {
        let shared = Directories::get_including_trash(pool, share.resource_id).await?;
        if shared.deleted_at.is_some() {
            return Err(ApiError::gone("分享内容已删除")
                .with_details(serde_json::json!({ "status": "deleted" })));
        }
        let fdir = Directories::get(pool, file.directory_id).await?;
        if !(fdir.id == shared.id || fdir.path.starts_with(&shared.path)) {
            return Err(ApiError::forbidden("超出分享范围"));
        }
    }
    Ok((share, file))
}

/// 公开预览：统一回原始字节（inline）；Office/CSV 由前端内置编辑器渲染。
pub async fn public_preview(
    State(state): State<AppState>,
    Path((token, file_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let (share, file) = load_share_file(pool, &token, file_id).await?;
    check_password(&share, &headers)?;
    let _ = Audit::log_named(
        pool,
        None,
        Some(SHARE_VISITOR),
        "share",
        "share_preview",
        Some("file"),
        Some(&file_id.to_string()),
        serde_json::json!({ "share_id": share.id }),
        None,
    )
    .await;
    files::deliver_current(&state, &file, false).await
}

/// 公开下载：计数原子 +1；preview_only → 403；用尽 → 403。
pub async fn public_download(
    State(state): State<AppState>,
    Path((token, file_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let (share, file) = load_share_file(pool, &token, file_id).await?;
    check_password(&share, &headers)?;
    if share.preview_only {
        return Err(ApiError::forbidden("该分享仅限预览，禁止下载"));
    }
    if !Shares::try_increment_download(pool, share.id).await? {
        return Err(ApiError::forbidden("下载次数已用尽或分享已失效"));
    }
    let _ = Audit::log_named(
        pool,
        None,
        Some(SHARE_VISITOR),
        "share",
        "share_download",
        Some("file"),
        Some(&file_id.to_string()),
        serde_json::json!({ "share_id": share.id }),
        None,
    )
    .await;
    files::deliver_current(&state, &file, true).await
}
