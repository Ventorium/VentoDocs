//! VentoKnowledge 单一可执行入口。
//!
//! 职责：加载 .env → 初始化日志 → 连接数据库并迁移 → 初始化对象存储 → 启动 axum。
//! 前端静态资源由 include_dir 在编译期嵌入（与 Docker 部署行为一致）。

use std::net::SocketAddr;
use std::sync::Arc;

use clap::Parser;
use include_dir::{Dir, include_dir};
use tracing::info;

/// 内嵌的前端构建产物（web/dist）。
const WEB_DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

#[derive(Parser, Debug)]
#[command(name = "vento", version, about = "VentoKnowledge 文档管理系统")]
struct Cli {
    /// 监听地址（环境变量 VIENTO_BIND_ADDR 优先于该默认值）
    #[arg(long, default_value = "0.0.0.0:8080")]
    bind: SocketAddr,
}

/// 极简 .env 加载器：不覆盖已存在的环境变量（真实环境变量优先）。
fn load_dotenv() {
    let Ok(content) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim();
        if k.is_empty() {
            continue;
        }
        let v = v.trim().trim_matches('"').trim_matches('\'');
        if std::env::var_os(k).is_none() {
            unsafe {
                std::env::set_var(k, v);
            }
        }
    }
}

/// 静态资源 MIME（前端构建产物种类有限，无需引入额外依赖）。
fn static_mime(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .as_deref()
    {
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    load_dotenv();

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,sqlx=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let cfg = vk_api::Config::from_env()?;
    let db_url = std::env::var("VIENTO_DB_URL")
        .map_err(|_| anyhow::anyhow!("缺少环境变量 VIENTO_DB_URL"))?;
    let db = vk_store::Db::connect(&db_url).await?;
    db.migrate().await?;

    let data_dir = std::env::var("VIENTO_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    let objects =
        vk_store::object_store::ObjectStore::new(std::path::Path::new(&data_dir).join("objects"));
    objects.ensure_dirs().await?;

    let state = vk_api::AppState {
        db,
        objects,
        cfg: Arc::new(cfg),
    };
    let app = vk_api::router(state.clone()).merge(static_files());
    // 发布子域名路由（§11）：{publish_id}.{VIENTO_PUBLISH_DOMAIN}
    let app = app.layer(axum::middleware::from_fn_with_state(
        state.clone(),
        host_publish_route,
    ));

    let listener = tokio::net::TcpListener::bind(cli.bind).await?;
    info!(addr = %cli.bind, "VentoKnowledge 已启动");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

/// 前端静态资源：/ → index.html，/assets/* 按文件服务，其余 GET 回退 SPA。
fn static_files() -> axum::Router {
    use axum::extract::{Path as UrlPath, State as UrlState};
    use axum::http::{StatusCode, header};
    use axum::routing::get;

    let index = WEB_DIST
        .get_file("index.html")
        .map(|f| f.contents().to_vec())
        .unwrap_or_default();

    fn index_response(index: &[u8]) -> axum::response::Response {
        axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(axum::body::Body::from(index.to_vec()))
            .unwrap_or_else(|_| axum::response::Response::new(axum::body::Body::empty()))
    }

    async fn index_route(UrlState(index): UrlState<Vec<u8>>) -> axum::response::Response {
        index_response(&index)
    }

    /// 已知静态文件按内嵌路径服务（注意 `{*path}` 不含 `/assets/` 前缀）；未命中则回退 SPA。
    async fn static_or_index(
        UrlState(index): UrlState<Vec<u8>>,
        UrlPath(path): UrlPath<String>,
    ) -> axum::response::Response {
        let Some(file) = WEB_DIST.get_file(path.as_str()) else {
            return index_response(&index);
        };
        axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, static_mime(&path))
            .body(axum::body::Body::from(file.contents().to_vec()))
            .unwrap_or_else(|_| axum::response::Response::new(axum::body::Body::empty()))
    }

    axum::Router::new()
        .route("/", get(index_route))
        .route("/{*path}", get(static_or_index))
        .with_state(index)
}

/// 发布子域名 410 响应体（禁止缓存，§11）。
const GONE_BODY: &str = r#"{"error":{"code":"GONE","message":"发布站点不存在或已停用"}}"#;

fn gone_response() -> axum::response::Response {
    axum::response::Response::builder()
        .status(axum::http::StatusCode::GONE)
        .header(axum::http::header::CACHE_CONTROL, "no-store")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(GONE_BODY.to_string()))
        .unwrap_or_default()
}

async fn run_next(
    next: axum::middleware::Next,
    req: axum::extract::Request,
) -> axum::response::Response {
    next.run(req).await
}

/// 发布子域名路由（§11）：Host = `{publish_id}.{VIENTO_PUBLISH_DOMAIN}`。
///
/// - 站点已启用 → 页面路径重写为 `/p/{publish_id}{原路径}`；`/api/`、`/assets/`、
///   `/_env` 原样放行（公开 API 与静态资源在任意主机头下均可用）。
/// - 站点不存在 / 停用 / 目录已删除 → 整站 410 + `Cache-Control: no-store`。
/// - 未配置域名或非 `{pid}.{domain}` 主机头 → 直接放行。
async fn host_publish_route(
    axum::extract::State(state): axum::extract::State<vk_api::AppState>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let Some(domain) = state
        .cfg
        .publish_domain
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    else {
        return run_next(next, req).await;
    };
    let Some(host) = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return run_next(next, req).await;
    };
    let host = host
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host)
        .trim()
        .to_lowercase();
    let Some(pid) = host.strip_suffix(&format!(".{domain}")) else {
        return run_next(next, req).await;
    };
    // publish_id 形如 16 位 [a-z2-9]；形都不像则不视为发布站点
    if pid.len() != 16
        || !pid
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'9').contains(&b))
    {
        return run_next(next, req).await;
    }
    let w = match vk_store::repo::publishes::Publishes::get_by_publish_id(state.db.pool(), pid).await {
        Ok(w) => w,
        Err(e) => {
            tracing::error!(error = %e, "发布站点查询失败");
            return run_next(next, req).await;
        }
    };
    let Some(w) = w else {
        return gone_response();
    };
    if !w.publish.enabled || w.directory.deleted_at.is_some() {
        return gone_response();
    }
    // 页面路径重写；API/静态资源/环境信息原样放行
    let old = req.uri().clone();
    let path = old.path().to_string();
    if !path.starts_with("/api/") && !path.starts_with("/assets/") && path != "/_env" {
        let pq = match old.query() {
            Some(q) => format!("/p/{pid}{path}?{q}"),
            None => format!("/p/{pid}{path}"),
        };
        if let Ok(pq) = axum::http::uri::PathAndQuery::from_maybe_shared(pq) {
            let mut parts = old.into_parts();
            parts.path_and_query = Some(pq);
            if let Ok(uri) = axum::http::uri::Uri::from_parts(parts) {
                *req.uri_mut() = uri;
            }
        }
    }
    run_next(next, req).await
}
