//! 目录网站发布 API：登录态管理（开启/关闭/查询）+ 公开访问端点（§11）。
//!
//! 公开端点无会话；策略 login 时校验 Authorization Bearer JWT。
//! 不存在/停用/目录已删除 → 410 + Cache-Control: no-store。
//! 内容 = 子树当前状态（无快照）；公开 JSON 响应带 no-cache + ETag。

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::header::{self, HeaderMap};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vk_core::model::PublishedDir;
use vk_core::perm::Perm;
use vk_store::repo::audit::Audit;
use vk_store::repo::directories::Directories;
use vk_store::repo::files::Files;
use vk_store::repo::grants::Grants;
use vk_store::repo::publishes::{Publishes, PublishWithDir};
use vk_store::repo::users::Users;

use crate::auth::{parse_token, AuthUser};
use crate::AppState;
use crate::error::ApiError;
use crate::files;
use crate::shares::entries_json;

/// 校验发布策略。
const VALID_POLICIES: &[&str] = &["anon", "login", "preview_only"];

#[derive(Deserialize)]
pub struct PublishReq {
    /// anon（默认匿名可读）| login（需登录）| preview_only（匿名仅预览）
    #[serde(default = "default_policy")]
    pub policy: String,
}

fn default_policy() -> String {
    "anon".into()
}

#[derive(Serialize)]
pub struct PublishOut {
    pub publish: PublishedDir,
    /// 完整站点地址；未配置域名为 null
    pub url: Option<String>,
}

fn publish_url(domain: Option<&str>, publish_id: &str) -> Option<String> {
    domain.map(|d| format!("https://{}.{}/", publish_id, d))
}

/// 开启（或更新策略）目录发布。
pub async fn enable(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<PublishReq>,
) -> Result<Json<PublishOut>, ApiError> {
    let domain = state.cfg.publish_domain.as_deref();
    if domain.is_none_or(str::is_empty) {
        return Err(ApiError::bad_request(
            "管理员未配置发布域名 VIENTO_PUBLISH_DOMAIN",
        ));
    }
    if !VALID_POLICIES.contains(&body.policy.as_str()) {
        return Err(ApiError::bad_request("policy 仅支持 anon | login | preview_only"));
    }
    let pool = state.db.pool();
    let _dir = Directories::get(pool, id).await?;
    let have = Grants::resolve(pool, user.id, id, user.is_admin).await?;
    if !have.contains(Perm::PUBLISH) {
        return Err(ApiError::forbidden("无权限发布该目录"));
    }
    let publish = Publishes::upsert_enable(pool, id, &body.policy, user.id).await?;
    Audit::log(
        pool,
        Some(user.id),
        "publish",
        "publish_enable",
        Some("directory"),
        Some(&id.to_string()),
        serde_json::json!({
            "publish_id": publish.publish_id,
            "policy": publish.policy,
            "url": publish_url(domain, &publish.publish_id),
        }),
        None,
    )
    .await?;
    Ok(Json(PublishOut {
        url: publish_url(domain, &publish.publish_id),
        publish,
    }))
}

/// 关闭目录发布（enabled=false，publish_id 保留复用）。
pub async fn disable(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let _dir = Directories::get(pool, id).await?;
    let have = Grants::resolve(pool, user.id, id, user.is_admin).await?;
    if !have.contains(Perm::PUBLISH) {
        return Err(ApiError::forbidden("无权限发布该目录"));
    }
    Publishes::disable(pool, id).await?;
    Audit::log(
        pool,
        Some(user.id),
        "publish",
        "publish_disable",
        Some("directory"),
        Some(&id.to_string()),
        serde_json::json!({}),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 查询目录发布状态。
pub async fn get(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let _dir = Directories::get(pool, id).await?;
    let have = Grants::resolve(pool, user.id, id, user.is_admin).await?;
    if !have.contains(Perm::PUBLISH) {
        return Err(ApiError::forbidden("无权限发布该目录"));
    }
    let publish = Publishes::get_by_directory(pool, id).await?;
    let url = publish
        .as_ref()
        .and_then(|p| publish_url(state.cfg.publish_domain.as_deref(), &p.publish_id));
    Ok(Json(serde_json::json!({ "publish": publish, "url": url })))
}

// ---------------------------------------------------------------------------
// 公开端点（无会话；login 策略下校验 Bearer JWT）
// ---------------------------------------------------------------------------

/// 410 GONE + Cache-Control: no-store（站点不存在/停用/已删除，禁止浏览器缓存）。
fn gone_response(message: &str) -> Response {
    let body = serde_json::json!({
        "error": { "code": "PUBLISH_DISABLED", "message": message },
    });
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    Response::builder()
        .status(StatusCode::GONE)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(bytes))
        .unwrap_or_default()
}

/// 公开 JSON 响应：no-cache + 弱 ETag（内容=子树当前状态，无快照，§11）。
fn json_no_cache(body: &serde_json::Value) -> Response {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in &bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ETAG, format!("W/\"{:016x}\"", h))
        .body(Body::from(bytes))
        .unwrap_or_default()
}

/// 加载发布站点；DB 错误 → 5xx，不存在/停用/已删除 → 410 no-store。
async fn load_publish(pool: &sqlx::PgPool, publish_id: &str) -> Result<PublishWithDir, Box<Response>> {
    let w = Publishes::get_by_publish_id(pool, publish_id)
        .await
        .map_err(|e| Box::new(ApiError::from(e).into_response()))?;
    let Some(w) = w else {
        return Err(Box::new(gone_response("发布站点不存在或已停用")));
    };
    if !w.publish.enabled {
        return Err(Box::new(gone_response("发布站点不存在或已停用")));
    }
    if w.directory.deleted_at.is_some() {
        return Err(Box::new(gone_response("发布目录已删除")));
    }
    Ok(w)
}

/// 发布策略访问校验：login 需要有效 JWT 且账号未禁用。
async fn check_policy(
    state: &AppState,
    pool: &sqlx::PgPool,
    policy: &str,
    headers: &HeaderMap,
) -> Result<(), Box<Response>> {
    if policy == "anon" || policy == "preview_only" {
        return Ok(());
    }
    // policy == "login"
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return Err(Box::new(ApiError::unauthorized().into_response()));
    };
    let (uid, _role) = parse_token(&state.cfg.jwt_secret, token)
        .map_err(|e| Box::new(e.into_response()))?;
    match Users::get_by_id(pool, uid).await {
        Ok(u) if !u.disabled => Ok(()),
        _ => Err(Box::new(ApiError::unauthorized().into_response())),
    }
}

/// 公开站点元信息：`GET /api/v1/public/published/{publish_id}`。
pub async fn public_meta(
    State(state): State<AppState>,
    Path(publish_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let w = match load_publish(pool, &publish_id).await {
        Ok(w) => w,
        Err(resp) => return Ok(*resp),
    };
    if let Err(resp) = check_policy(&state, pool, &w.publish.policy, &headers).await {
        return Ok(*resp);
    }
    Ok(json_no_cache(&serde_json::json!({
        "name": w.directory.name,
        "publishId": w.publish.publish_id,
        "policy": w.publish.policy,
        "directoryId": w.directory.id,
    })))
}

#[derive(Deserialize)]
pub struct PubEntriesQuery {
    pub dir_id: Uuid,
}

/// 公开站点目录列表：`GET /api/v1/public/published/{publish_id}/entries?dir_id=`。
pub async fn public_entries(
    State(state): State<AppState>,
    Path(publish_id): Path<String>,
    Query(q): Query<PubEntriesQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let w = match load_publish(pool, &publish_id).await {
        Ok(w) => w,
        Err(resp) => return Ok(*resp),
    };
    if let Err(resp) = check_policy(&state, pool, &w.publish.policy, &headers).await {
        return Ok(*resp);
    }
    let root = w.directory;
    let target = if q.dir_id == root.id {
        root
    } else {
        let t = Directories::get(pool, q.dir_id).await?;
        if !t.path.starts_with(&root.path) {
            return Err(ApiError::forbidden("超出发布范围"));
        }
        t
    };
    let (_dir, entries) = Directories::list_children(pool, target.id).await?;
    Ok(json_no_cache(&serde_json::json!({ "entries": entries_json(&entries) })))
}

/// 公开站点文件预览：Office/CSV → Univer 快照 JSON；其余回原始字节（inline）。
pub async fn public_preview(
    State(state): State<AppState>,
    Path((publish_id, file_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let w = match load_publish(pool, &publish_id).await {
        Ok(w) => w,
        Err(resp) => return Ok(*resp),
    };
    if let Err(resp) = check_policy(&state, pool, &w.publish.policy, &headers).await {
        return Ok(*resp);
    }
    let root = w.directory;
    let file = Files::get_meta(pool, file_id).await?;
    if file.deleted_at.is_some() {
        return Ok(gone_response("文件已删除"));
    }
    let fdir = Directories::get(pool, file.directory_id).await?;
    if !(fdir.id == root.id || fdir.path.starts_with(&root.path)) {
        return Err(ApiError::forbidden("超出发布范围"));
    }
    files::deliver_current(&state, &file, false).await
}

/// 公开站点文件下载。
pub async fn public_download(
    State(state): State<AppState>,
    Path((publish_id, file_id)): Path<(String, Uuid)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let w = match load_publish(pool, &publish_id).await {
        Ok(w) => w,
        Err(resp) => return Ok(*resp),
    };
    if let Err(resp) = check_policy(&state, pool, &w.publish.policy, &headers).await {
        return Ok(*resp);
    }
    if w.publish.policy == "preview_only" {
        return Err(ApiError::forbidden("该站点仅限预览，禁止下载"));
    }
    let root = w.directory;
    let file = Files::get_meta(pool, file_id).await?;
    if file.deleted_at.is_some() {
        return Ok(gone_response("文件已删除"));
    }
    let fdir = Directories::get(pool, file.directory_id).await?;
    if !(fdir.id == root.id || fdir.path.starts_with(&root.path)) {
        return Err(ApiError::forbidden("超出发布范围"));
    }
    files::deliver_current(&state, &file, true).await
}
