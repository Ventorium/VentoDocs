//! vk-api：axum 路由、JWT 认证中间件、权限校验与错误映射。
//!
//! 所有写操作入口在 handler 内先做权限校验（§8.3 服务端强制），
//! 再交给 store 层；内容写入在 store 单事务内二次校验持久锁。

pub mod auth;
pub mod directories;
pub mod error;
pub mod files;
pub mod teams;
pub mod users;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, State};
use axum::middleware;
use axum::routing::{delete, get, post};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use vk_store::Db;
use vk_store::object_store::ObjectStore;

/// 运行时配置（来自环境变量，见 .env.example）。
#[derive(Clone)]
pub struct Config {
    pub jwt_secret: String,
    pub jwt_ttl_hours: u64,
    pub max_upload_bytes: u64,
    pub trash_retention_days: u32,
    pub version_keep: u32,
    pub publish_domain: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let jwt_secret = std::env::var("VIENTO_JWT_SECRET")
            .map_err(|_| anyhow::anyhow!("缺少环境变量 VIENTO_JWT_SECRET"))?;
        if jwt_secret.len() < 16 {
            anyhow::bail!("VIENTO_JWT_SECRET 至少 16 字符");
        }
        Ok(Self {
            jwt_secret,
            jwt_ttl_hours: env_u64("VIENTO_JWT_TTL_HOURS", 24),
            max_upload_bytes: env_u64("VIENTO_MAX_UPLOAD_MB", 500) * 1024 * 1024,
            trash_retention_days: env_u64("VIENTO_TRASH_RETENTION_DAYS", 180) as u32,
            version_keep: env_u64("VIENTO_VERSION_KEEP", 20) as u32,
            publish_domain: std::env::var("VIENTO_PUBLISH_DOMAIN")
                .ok()
                .filter(|s| !s.trim().is_empty()),
        })
    }
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// 全局应用状态。
#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub objects: ObjectStore,
    pub cfg: Arc<Config>,
}

/// 组装完整路由：公开端点 + 需认证端点 + CORS。
pub fn router(state: AppState) -> Router {
    let max_body = state.cfg.max_upload_bytes + 16 * 1024 * 1024;

    let public = Router::new()
        .route("/api/v1/health", get(health))
        .route("/_env", get(env_info))
        .route("/api/v1/auth/bootstrap", post(auth::bootstrap))
        .route("/api/v1/auth/login", post(auth::login));

    let protected = Router::new()
        .route("/api/v1/auth/me", get(auth::me))
        .route("/api/v1/users", get(users::list).post(users::create))
        .route("/api/v1/users/{id}", get(users::get).patch(users::update))
        .route("/api/v1/users/{id}/password", post(users::set_password))
        .route("/api/v1/users/ldap/import", post(users::import_ldap))
        .route("/api/v1/teams", get(teams::list).post(teams::create))
        .route("/api/v1/teams/{id}", get(teams::get).patch(teams::update))
        .route("/api/v1/teams/{id}/members", post(teams::add_member))
        .route(
            "/api/v1/teams/{team_id}/members/{user_id}",
            delete(teams::remove_member),
        )
        .route("/api/v1/directories/root", get(directories::root))
        .route("/api/v1/directories/{id}", get(directories::get))
        .route("/api/v1/directories", post(directories::create))
        .route("/api/v1/directories/{id}/rename", post(directories::rename))
        .route("/api/v1/directories/{id}/move", post(directories::move_dir))
        .route("/api/v1/directories/{id}", delete(directories::trash))
        .route(
            "/api/v1/directories/{id}/restore",
            post(directories::restore),
        )
        .route(
            "/api/v1/directories/{id}/grants",
            get(directories::list_grants).put(directories::set_grant),
        )
        .route(
            "/api/v1/directories/{id}/grants/{ptype}/{pid}",
            delete(directories::remove_grant),
        )
        .route("/api/v1/trash/directories", get(directories::list_trashed))
        .route("/api/v1/trash/files", get(files::list_trashed))
        .route("/api/v1/directories/{id}/files", post(files::upload))
        .route("/api/v1/files/{id}", get(files::meta).delete(files::trash))
        .route("/api/v1/files/{id}/content", get(files::content))
        .route("/api/v1/files/{id}/save", post(files::save))
        .route("/api/v1/files/{id}/lock", post(files::lock))
        .route("/api/v1/files/{id}/unlock", post(files::unlock))
        .route("/api/v1/files/{id}/restore", post(files::restore))
        .route(
            "/api/v1/files/{id}/restore/rename",
            post(files::restore_rename),
        )
        .route("/api/v1/files/{id}/purge", delete(files::purge))
        .route("/api/v1/files/{id}/versions", get(files::versions))
        .route(
            "/api/v1/files/{id}/versions/{version}/restore",
            post(files::restore_version),
        )
        .route("/api/v1/files/{id}/move", post(files::move_file))
        .route("/api/v1/files/{id}/copy", post(files::copy_file))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .layer(DefaultBodyLimit::max(max_body as usize));

    public
        .merge(protected)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

/// 前端运行时环境信息（web 的 fetchConfig 消费；生产由单二进制直接服务）。
async fn env_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "publishDomain": state.cfg.publish_domain,
    }))
}
