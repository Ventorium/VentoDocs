//! vk-api：axum 路由、JWT 认证中间件、权限校验与错误映射。
//!
//! 所有写操作入口在 handler 内先做权限校验（§8.3 服务端强制），
//! 再交给 store 层；内容写入在 store 单事务内二次校验持久锁。

pub mod audits;
pub mod auth;
pub mod directories;
pub mod error;
pub mod files;
pub mod janitor;
pub mod notifications;
pub mod publishes;
pub mod rate_limit;
pub mod search;
pub mod settings;
pub mod shares;
pub mod site;
pub mod teams;
pub mod users;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware;
use axum::response::Response;
use axum::routing::{delete, get, post};
use std::net::SocketAddr;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use vk_store::Db;
use vk_store::object_store::ObjectStore;
use vk_store::repo::audit;

/// 运行时配置（来自环境变量，见 .env.example）。
#[derive(Clone)]
pub struct Config {
    pub jwt_secret: String,
    pub jwt_ttl_hours: u64,
    pub max_upload_bytes: u64,
    pub trash_retention_days: u32,
    pub version_keep: u32,
    /// 审计日志保留天数（M2.42 后台清理任务使用）。
    pub audit_retention_days: u32,
    /// 后台清理任务间隔分钟数（0 = 关闭）。
    pub janitor_interval_minutes: u64,
    pub publish_domain: Option<String>,
    /// 在线编辑器静态资源目录（`VENTO_EDITOR_DIST`，默认 `editor-dist`，相对进程 CWD）。
    pub editor_dist: std::path::PathBuf,
    /// 编辑器目录就绪（含 index.html）；false 时前端不展示编辑功能。
    pub editor_available: bool,
    /// 允许的跨域来源白名单（`VIENTO_CORS_ORIGINS`，逗号分隔）。
    /// 空 = 不启用 CORS（仅同源访问），这是默认且最安全的配置。
    pub cors_origins: Vec<String>,
    /// 是否信任 `X-Forwarded-For` / `X-Real-IP`（`VIENTO_TRUST_PROXY=true`）。
    /// 默认 **false**：直连部署时这两个头可被客户端任意伪造，既污染审计 IP，
    /// 也能绕过按 IP 的登录限流；只有挂在可信反向代理后面才应打开。
    pub trust_proxy: bool,
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
            audit_retention_days: env_u64("VIENTO_AUDIT_RETENTION_DAYS", 365) as u32,
            janitor_interval_minutes: env_u64("VIENTO_JANITOR_INTERVAL_MINUTES", 360),
            publish_domain: std::env::var("VIENTO_PUBLISH_DOMAIN")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            editor_dist: std::env::var("VENTO_EDITOR_DIST")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from("editor-dist")),
            editor_available: false,
            cors_origins: std::env::var("VIENTO_CORS_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            trust_proxy: matches!(
                std::env::var("VIENTO_TRUST_PROXY")
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "1" | "true" | "yes"
            ),
        })
        .map(|mut c| {
            c.editor_available = c.editor_dist.join("index.html").is_file();
            if !c.editor_available {
                tracing::warn!(
                    dir = %c.editor_dist.display(),
                    "在线编辑器资源目录缺失（index.html 不存在），编辑功能已禁用；运行 scripts/fetch-editor.sh 拉取"
                );
            }
            c
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
    /// M2.24：实际绑定的分享端口（启动时确定；设置页改端口需重启后生效）。
    pub share_port: u16,
}

/// 客户端 IP 中间件：解析 X-Forwarded-For（取首跳）→ X-Real-IP → TCP 对端地址，
/// 写入审计上下文（`vk_store::repo::audit::scope_client_ip`），审计日志自动记录。
async fn attach_client_ip(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    req: Request,
    next: axum::middleware::Next,
) -> Response {
    // 直连部署（默认）不信任转发头：`X-Forwarded-For` 可被客户端随意伪造，
    // 既污染审计 IP，也能绕过按 IP 的登录/口令限流。
    let ip = if state.cfg.trust_proxy {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| headers.get("x-real-ip").and_then(|v| v.to_str().ok()))
            .map(str::to_string)
            .unwrap_or_else(|| peer.ip().to_string())
    } else {
        peer.ip().to_string()
    };
    audit::scope_client_ip(Some(ip), next.run(req)).await
}

/// 组装完整路由：公开端点 + 需认证端点 + CORS。
pub fn router(state: AppState) -> Router {
    let max_body = state.cfg.max_upload_bytes + 16 * 1024 * 1024;

    let public = Router::new()
        .route("/api/v1/health", get(health))
        .route("/_env", get(env_info))
        // 目录发布公开端点（无会话，§11）
        .route(
            "/api/v1/public/published/{publish_id}",
            get(publishes::public_meta),
        )
        .route(
            "/api/v1/public/published/{publish_id}/entries",
            get(publishes::public_entries),
        )
        .route(
            "/api/v1/public/published/{publish_id}/files/{file_id}/preview",
            get(publishes::public_preview),
        )
        .route(
            "/api/v1/public/published/{publish_id}/files/{file_id}/download",
            get(publishes::public_download),
        );

    // 口令端点 → 进程内失败计数限流（防暴力破解）。
    // 注意 axum 的 `layer` 只作用于「此前已添加」的路由，故按端点分组依次叠加。
    let sensitive = Router::new()
        // 登录 / 首次初始化
        .route("/api/v1/auth/bootstrap", post(auth::bootstrap))
        .route("/api/v1/auth/login", post(auth::login))
        .layer(middleware::from_fn(rate_limit::login_guard))
        // 分享密码校验 + 受密码保护的公开分享端点（错误密码会 401）
        .route("/api/v1/public/shares/{token}", get(shares::public_meta))
        .route(
            "/api/v1/public/shares/{token}/verify",
            post(shares::public_verify),
        )
        .route(
            "/api/v1/public/shares/{token}/entries",
            get(shares::public_entries),
        )
        .route(
            "/api/v1/public/shares/{token}/files/{file_id}/preview",
            get(shares::public_preview),
        )
        .route(
            "/api/v1/public/shares/{token}/files/{file_id}/download",
            get(shares::public_download),
        )
        .layer(middleware::from_fn(rate_limit::share_guard))
        // M2.26：站点密码校验（login 策略；正确 → 24h 站点 token）
        .route(
            "/api/v1/public/published/{publish_id}/password",
            post(publishes::public_verify_password),
        )
        .layer(middleware::from_fn(rate_limit::publish_guard));

    let protected = Router::new()
        .route("/api/v1/auth/me", get(auth::me))
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/users", get(users::list).post(users::create))
        .route(
            "/api/v1/users/{id}",
            get(users::get).patch(users::update).delete(users::delete),
        )
        .route("/api/v1/users/{id}/password", post(users::set_password))
        .route(
            "/api/v1/users/{id}/quota",
            axum::routing::put(users::set_quota),
        )
        .route("/api/v1/users/ldap/import", post(users::import_ldap))
        .route(
            "/api/v1/users/ldap/config",
            get(users::ldap_config)
                .put(users::save_ldap_config)
                .delete(users::delete_ldap_config),
        )
        .route("/api/v1/users/ldap/test", post(users::test_ldap))
        .route("/api/v1/teams", get(teams::list).post(teams::create))
        .route(
            "/api/v1/teams/{id}",
            get(teams::get).patch(teams::update).delete(teams::delete),
        )
        .route("/api/v1/teams/{id}/members", post(teams::add_member))
        .route(
            "/api/v1/teams/{team_id}/members/{user_id}",
            delete(teams::remove_member),
        )
        .route("/api/v1/directories/root", get(directories::root))
        .route("/api/v1/directories/shared", get(directories::shared))
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
        .route("/api/v1/files/{id}/zip", get(files::zip_list))
        .route("/api/v1/files/{id}/zip-entry", get(files::zip_entry))
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
        .route("/api/v1/files/{id}/rename", post(files::rename))
        .route("/api/v1/files/{id}/move", post(files::move_file))
        .route("/api/v1/files/{id}/copy", post(files::copy_file))
        // M2.23：文件级授权（覆盖所在目录的继承权限）
        .route(
            "/api/v1/files/{id}/grants",
            get(files::list_file_grants).put(files::set_file_grant),
        )
        .route(
            "/api/v1/files/{id}/grants/{ptype}/{pid}",
            delete(files::remove_file_grant),
        )
        // 分享管理（§10）
        .route("/api/v1/shares", get(shares::list).post(shares::create))
        .route("/api/v1/shares/{id}/revoke", post(shares::revoke))
        // 目录发布管理（§11）
        .route(
            "/api/v1/directories/{id}/publish",
            get(publishes::get)
                .post(publishes::enable)
                .delete(publishes::disable),
        )
        // 文件名搜索（§9）
        .route("/api/v1/search", get(search::search))
        // 用户设置（桌面外观，§P1）
        .route(
            "/api/v1/settings/desktop",
            get(settings::get_desktop).put(settings::put_desktop),
        )
        // M2.24: 系统设置（分享端口 / 外网域名）
        .route(
            "/api/v1/settings/system/share",
            get(settings::get_share_settings).put(settings::put_share_settings),
        )
        // M2.27: 系统设置（发布域名，只读；域名仅来自环境变量 VIENTO_PUBLISH_DOMAIN）
        .route(
            "/api/v1/settings/system/publish",
            get(settings::get_publish_settings),
        )
        .route("/api/v1/audits", get(audits::list))
        .route("/api/v1/notifications", get(notifications::list))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .layer(DefaultBodyLimit::max(max_body as usize));

    let merged = public.merge(sensitive).merge(protected);

    // CORS：默认**不放开**跨域（SPA 与 API 同源）；需要跨域的前端用
    // VIENTO_CORS_ORIGINS（逗号分隔）显式列出来源，避免 `permissive()` 让任意站点
    // 携带令牌读取接口。
    let merged = if state.cfg.cors_origins.is_empty() {
        merged
    } else {
        let origins: Vec<HeaderValue> = state
            .cfg
            .cors_origins
            .iter()
            .filter_map(|o| o.parse::<HeaderValue>().ok())
            .collect();
        tracing::info!(count = origins.len(), "CORS 来源白名单已启用");
        merged.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    header::AUTHORIZATION,
                    header::CONTENT_TYPE,
                    header::ACCEPT,
                    HeaderName::from_static("x-share-password"),
                ])
                .max_age(std::time::Duration::from_secs(3600)),
        )
    };

    merged
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            attach_client_ip,
        ))
        .with_state(state)
}

/// 基础安全响应头（幂等：已存在则跳过）。在 vk-app 里对**整个应用**（含静态资源、
/// SPA、发布站点）统一套用。
///
/// 不含 CSP：在线编辑器是第三方 WASM bundle（内联脚本、eval、wasm-eval 都可能用到），
/// 收紧 CSP 会直接打断编辑器；待编辑器路由可独立加头时再补。
pub async fn security_headers(req: Request, next: axum::middleware::Next) -> Response {
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.entry(header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(HeaderValue::from_static("nosniff"));
    h.entry(header::X_FRAME_OPTIONS)
        .or_insert(HeaderValue::from_static("SAMEORIGIN"));
    h.entry(header::REFERRER_POLICY)
        .or_insert(HeaderValue::from_static("same-origin"));
    resp
}

/// 健康检查：探活数据库（readiness 用）。DB 不可用时返回 503，便于反代/k8s 摘流。
async fn health(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(state.db.pool())
        .await
    {
        Ok(_) => (StatusCode::OK, "ok"),
        Err(e) => {
            tracing::warn!(error = %e, "健康检查：数据库不可用");
            (StatusCode::SERVICE_UNAVAILABLE, "db unavailable")
        }
    }
}

/// 前端运行时环境信息（web 的 fetchConfig 消费；生产由单二进制直接服务）。
/// M2.26：publishDomain 返回有效域名（系统设置优先，回退环境变量）。
async fn env_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "publishDomain": publishes::effective_publish_domain(&state),
        // 编辑器以 base:'./' 相对引用构建，文档 URL 必须带尾斜杠，
        // 相对资源（./sdkjs/...）才能解析到 /document/ 之下
        "editorBase": if state.cfg.editor_available { Some("/document/") } else { None },
    }))
}
