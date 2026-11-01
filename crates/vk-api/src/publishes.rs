//! 目录网站发布 API：登录态管理（开启/关闭/查询）+ 公开访问端点（§11）。
//!
//! 公开端点无会话；策略 login = 站点密码门（M2.26）：访问者输入发布时设置的站点密码，
//! 后端签发 24h 站点 token（sub=publish:{publish_id}），与 VentoDocs 系统账号无关。
//! 有效发布域名 = 环境变量 VIENTO_PUBLISH_DOMAIN（.env），修改后需重启服务生效。
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

use crate::auth::AuthUser;
use crate::AppState;
use crate::error::ApiError;
use crate::files;
use crate::shares::entries_json;

/// 校验发布策略。
const VALID_POLICIES: &[&str] = &["anon", "login", "preview_only"];

/// M2.28：站点模式。static = 纯静态；spa = Vite try_files 回退；file_index = 目录文件列表。
pub const VALID_SITE_MODES: &[&str] = &["static", "spa", "file_index"];

/// M2.26：站点 token 有效期（秒）。
const SITE_TOKEN_TTL_SECONDS: i64 = 24 * 3600;

#[derive(Deserialize)]
pub struct PublishReq {
    /// anon（默认匿名可读）| login（需站点密码）| preview_only（匿名仅预览）
    #[serde(default = "default_policy")]
    pub policy: String,
    /// M2.26：站点访问密码（login 策略；空/缺省 = 保持不变或清除）。
    #[serde(default)]
    pub password: Option<String>,
    /// M2.28：站点模式 static | spa | file_index（缺省 = 新建用 static / 更新沿用原值）。
    #[serde(default)]
    pub site_mode: Option<String>,
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

/// M2.27：有效发布域名 = 环境变量 VIENTO_PUBLISH_DOMAIN（.env）唯一来源；
/// 管理页面只读展示，不再从系统设置读取。未设置/空 = 发布功能不可用。
pub fn effective_publish_domain(state: &AppState) -> Option<String> {
    state.cfg.publish_domain.clone().filter(|s| !s.trim().is_empty())
}

/// M2.26：站点 token 有效期（小时）。
const SITE_TOKEN_TTL_HOURS: u64 = 24;

/// 开启（或更新策略）目录发布。
pub async fn enable(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<PublishReq>,
) -> Result<Json<PublishOut>, ApiError> {
    if !VALID_POLICIES.contains(&body.policy.as_str()) {
        return Err(ApiError::bad_request("policy 仅支持 anon | login | preview_only"));
    }
    let site_mode_req = body.site_mode.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(m) = site_mode_req
        && !VALID_SITE_MODES.contains(&m)
    {
        return Err(ApiError::bad_request("site_mode 仅支持 static | spa | file_index"));
    }
    let pool = state.db.pool();
    let dir = Directories::get(pool, id).await?;
    // M2.35：仅目录创建者可发布（管理员无旁路；发布状态查询不受影响）
    if dir.created_by != Some(user.id) {
        return Err(ApiError::forbidden("仅目录创建者可发布该目录"));
    }
    // M2.27：有效发布域名 = 环境变量 VIENTO_PUBLISH_DOMAIN（.env）唯一来源
    let domain = effective_publish_domain(&state);
    if domain.is_none() {
        return Err(ApiError::bad_request(
            "尚未配置发布域名：请在服务器 .env 中设置 VIENTO_PUBLISH_DOMAIN=你的域名（如 sites.example.com，无需协议头），并配置泛解析 *.域名 指向服务器 IP，重启服务后再发布",
        ));
    }
    // M2.26：站点密码（login 策略）——提供则更新；缺省时沿用原 login 密码，否则必须提供
    let password = body.password.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let existing = Publishes::get_by_directory(pool, id).await?;
    let password_hash = if body.policy == "login" {
        match password {
            Some(p) => Some(vk_store::repo::users::hash_password(p)?),
            None => existing
                .as_ref()
                .filter(|e| e.policy == "login")
                .and_then(|e| e.password_hash.clone()),
        }
    } else {
        None
    };
    if body.policy == "login" && password_hash.is_none() {
        return Err(ApiError::bad_request("「需密码」策略必须设置站点访问密码"));
    }
    // M2.28：站点模式——提供则更新；缺省时沿用原值，新建默认 static（纯静态）
    let site_mode = match site_mode_req {
        Some(m) => m.to_string(),
        None => existing.map(|e| e.site_mode).unwrap_or_else(|| "static".into()),
    };
    let publish = Publishes::upsert_enable(pool, id, &body.policy, password_hash.as_deref(), &site_mode, user.id)
        .await?;
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
            "has_password": publish.has_password,
            "site_mode": publish.site_mode,
            "url": publish_url(domain.as_deref(), &publish.publish_id),
        }),
        None,
    )
    .await?;
    Ok(Json(PublishOut {
        url: publish_url(domain.as_deref(), &publish.publish_id),
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
    let dir = Directories::get(pool, id).await?;
    // M2.35：仅目录创建者可关闭发布（管理员无旁路）
    if dir.created_by != Some(user.id) {
        return Err(ApiError::forbidden("仅目录创建者可管理该目录的发布"));
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
    let domain = effective_publish_domain(&state);
    let url = publish
        .as_ref()
        .and_then(|p| publish_url(domain.as_deref(), &p.publish_id));
    Ok(Json(serde_json::json!({ "publish": publish, "url": url })))
}

// ---------------------------------------------------------------------------
// 公开端点（无会话；login 策略 = 站点密码门，M2.26）
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

/// M2.26 发布策略访问校验：login = 站点密码门（24h 站点 token，sub=publish:{publish_id}），
/// 与 VentoDocs 系统账号完全无关；系统账号 token（UUID sub）在此被拒绝。
async fn check_policy(
    state: &AppState,
    publish: &PublishedDir,
    headers: &HeaderMap,
) -> Result<(), Box<Response>> {
    if publish.policy == "anon" || publish.policy == "preview_only" {
        return Ok(());
    }
    // policy == "login"
    let Some(hash) = publish.password_hash.as_deref() else {
        return Err(Box::new(
            ApiError::unauthorized_with("站点尚未设置访问密码，请联系管理员").into_response(),
        ));
    };
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return Err(Box::new(ApiError::unauthorized_with("该站点需输入访问密码").into_response()));
    };
    if !crate::auth::verify_site_token(&state.cfg.jwt_secret, token, &publish.publish_id) {
        return Err(Box::new(ApiError::unauthorized_with("访问令牌无效或已过期，请重新输入密码").into_response()))
    }
    let _ = hash; // 密码已在签发 token 时验证；此处仅确认已配置
    Ok(())
}

/// 站点密码校验：`POST /api/v1/public/published/{publish_id}/password`。
/// 登录态无关（公开端点）；密码正确 → 签发 24h 站点 token；错误 → 401。
#[derive(Deserialize)]
pub struct SitePasswordReq {
    pub password: String,
}

pub async fn public_verify_password(
    State(state): State<AppState>,
    Path(publish_id): Path<String>,
    Json(body): Json<SitePasswordReq>,
) -> Result<Response, ApiError> {
    let pool = state.db.pool();
    let w = match load_publish(pool, &publish_id).await {
        Ok(w) => w,
        Err(resp) => return Ok(*resp),
    };
    if w.publish.policy != "login" {
        return Err(ApiError::bad_request("该站点无需密码"));
    }
    let Some(hash) = w.publish.password_hash.clone() else {
        return Err(ApiError::unauthorized_with("站点尚未设置访问密码，请联系管理员"));
    };
    if body.password.trim().is_empty()
        || !vk_store::repo::users::verify_password(&body.password, &hash)
    {
        return Err(ApiError::unauthorized_with("站点密码错误"));
    }
    let token = crate::auth::sign_site_token(&state.cfg.jwt_secret, &w.publish.publish_id, SITE_TOKEN_TTL_HOURS)?;
    let body = serde_json::json!({ "token": token, "expires_in": SITE_TOKEN_TTL_SECONDS });
    Ok(json_no_cache(&body))
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
    if let Err(resp) = check_policy(&state, &w.publish, &headers).await {
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
    if let Err(resp) = check_policy(&state, &w.publish, &headers).await {
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
    if let Err(resp) = check_policy(&state, &w.publish, &headers).await {
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
    if let Err(resp) = check_policy(&state, &w.publish, &headers).await {
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
