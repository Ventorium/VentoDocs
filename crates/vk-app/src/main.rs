//! VentoDocs 单一可执行入口。
//!
//! 职责：加载 .env → 初始化日志 → 连接数据库并迁移 → 初始化对象存储 → 启动 axum。
//! 前端静态资源由 include_dir 在编译期嵌入（与 Docker 部署行为一致）。

use std::net::SocketAddr;
use std::sync::Arc;

use clap::Parser;
use include_dir::{Dir, include_dir};
use tracing::{info, warn};

/// 内嵌的前端构建产物（web/dist）。
const WEB_DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

#[derive(Parser, Debug)]
#[command(name = "vento", version, about = "VentoDocs 文档管理系统")]
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
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("br") => "application/octet-stream",
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

    // M2.24：分享端口——第二监听，独立端口服务同一应用（/s/{token} 分享链接对外）。
    // 端口优先级：system_settings.share.port（管理端可改）> VENTO_SHARE_PORT > 8090；
    // 修改端口需重启服务生效（管理端设置页有提示）。
    let share_port: u16 = vk_store::repo::settings::SystemSettings::get(
        db.pool(),
        vk_api::settings::SHARE_KEY,
    )
    .await
    .and_then(|v| v.get("port").and_then(serde_json::Value::as_u64))
    .and_then(|p| u16::try_from(p).ok())
    .or_else(|| std::env::var("VENTO_SHARE_PORT").ok().and_then(|v| v.parse().ok()))
    .unwrap_or(vk_api::settings::DEFAULT_SHARE_PORT);

    let state = vk_api::AppState {
        db,
        objects,
        cfg: Arc::new(cfg),
        share_port,
    };
    let app = vk_api::router(state.clone()).merge(static_files(state.clone()));
    // 发布子域名路由（§11）：{publish_id}.{VIENTO_PUBLISH_DOMAIN}
    let app = app.layer(axum::middleware::from_fn_with_state(
        state.clone(),
        host_publish_route,
    ));

    let listener = tokio::net::TcpListener::bind(cli.bind).await?;
    info!(addr = %cli.bind, "VentoDocs 已启动（主端口）");

    let share_addr = SocketAddr::from(([0, 0, 0, 0], share_port));
    if share_port == cli.bind.port() {
        warn!(addr = %share_addr, "分享端口与主端口相同，未启动分享监听");
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await?;
    } else {
        match tokio::net::TcpListener::bind(share_addr).await {
            Ok(share_listener) => {
                info!(addr = %share_addr, "VentoDocs 已启动（分享端口）");
                let (main_result, _share_result) = tokio::join!(
                    axum::serve(
                        listener,
                        app.clone().into_make_service_with_connect_info::<SocketAddr>(),
                    ),
                    axum::serve(
                        share_listener,
                        app.into_make_service_with_connect_info::<SocketAddr>(),
                    ),
                );
                // 主端口异常退出；分享端口先行异常（如网络变更）不影响主服务。
                main_result?;
            }
            Err(e) => {
                warn!(addr = %share_addr, error = %e, "分享端口绑定失败，该端口上的分享链接不可用");
                axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await?;
            }
        }
    }
    Ok(())
}

/// 前端静态资源 + 在线编辑器：
///
/// - `/`、`/assets/*` 等：编译期内嵌的 SPA 产物。
/// - `/document`、`/document/{*path}`：从磁盘目录 `editor-dist/`（`VENTO_EDITOR_DIST`）
///   按文件服务；目录缺失时返回 404 JSON（编辑功能静默不可用，SPA 照常）。
///
/// 关于 COOP/COEP：曾为启用跨源隔离（SharedArrayBuffer → WASM 多线程）在顶层文档与
/// `/document` 上设置 `COOP: same-origin` + `COEP: require-corp`。实测官方编辑器自带
/// 无多线程降级路径（`crossOriginIsolated=false` 时功能完整），而真实访问环境
/// （http + 内网 IP，非安全上下文）下标准浏览器本就忽略这些头；个别浏览器/内核 fork
/// 对它们处理异常会导致编辑器加载失败（2026-10 用户实机问题排查）。故移除 COOP/COEP；
/// 代价：即使日后走 https 也不会启用 WASM 多线程，大表格性能略降，功能不受影响。
/// 另：服务时向 `/document` 下的 HTML 注入 `crypto.randomUUID` polyfill
/// （非安全上下文下该 API 不可用，官方 bundle 个别路径无防护地调用它）。
fn static_files(state: vk_api::AppState) -> axum::Router {
    use axum::extract::{Path as UrlPath, State as UrlState};
    use axum::http::{StatusCode, header};
    use axum::routing::get;

    let index = WEB_DIST
        .get_file("index.html")
        .map(|f| f.contents().to_vec())
        .unwrap_or_default();

    #[derive(Clone)]
    struct StaticState {
        index: Vec<u8>,
        editor: Option<std::path::PathBuf>,
    }

    let st = StaticState {
        index,
        editor: (state.cfg.editor_available).then(|| state.cfg.editor_dist.clone()),
    };

    /// 顶层文档响应（不再带 COOP/COEP，见 `static_files` 注释）。
    /// `no-cache`：每次重新协商，避免客户端缓存旧 index.html 引向已不存在的旧 hash 资源
    /// （2026-10 用户实机出现编辑器加载超时 + 审计页旧版式的共同根因之一）。
    fn index_response(index: &[u8]) -> axum::response::Response {
        axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(axum::body::Body::from(index.to_vec()))
            .unwrap_or_else(|_| axum::response::Response::new(axum::body::Body::empty()))
    }

    async fn index_route(UrlState(st): UrlState<StaticState>) -> axum::response::Response {
        index_response(&st.index)
    }

    /// 已知静态文件按内嵌路径服务（注意 `{*path}` 不含 `/assets/` 前缀）；未命中则回退 SPA。
    async fn static_or_index(
        UrlState(st): UrlState<StaticState>,
        UrlPath(path): UrlPath<String>,
    ) -> axum::response::Response {
        let Some(file) = WEB_DIST.get_file(path.as_str()) else {
            return index_response(&st.index);
        };
        // 内嵌产物文件名均带内容 hash（如 assets/index-XXXX.js），可长期缓存；未命中走 no-cache 的 index 回退
        axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, static_mime(&path))
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(axum::body::Body::from(file.contents().to_vec()))
            .unwrap_or_else(|_| axum::response::Response::new(axum::body::Body::empty()))
    }

    fn editor_not_deployed() -> axum::response::Response {
        axum::response::Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(axum::body::Body::from(
                r#"{"error":{"code":"EDITOR_NOT_DEPLOYED","message":"在线编辑器资源未部署：运行 scripts/fetch-editor.sh 拉取 editor-dist/ 后重启服务"}}"#,
            ))
            .unwrap_or_default()
    }

    /// 非安全上下文（http + 内网 IP）下 `crypto.randomUUID` 不可用（仅 secure-context 提供），
    /// 官方 bundle 的 AI/webllm 路径无防护地调用它，个别情况下导致打开编辑器抛错。
    /// 服务时向 HTML 的 `<head>` 注入 polyfill（用全上下文可用的
    /// `crypto.getRandomValues` 实现 v4 UUID）；磁盘上的官方 dist 保持原样不改。
    const UUID_POLYFILL: &str = "<script>(function(){if(typeof crypto!=='undefined'&&crypto.getRandomValues&&!crypto.randomUUID){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=Array.prototype.map.call(b,function(x){return x.toString(16).padStart(2,'0')});return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('')}}})();</script>";

    /// 向 `<head>` 后插入 polyfill；找不到标记或 HTML 非 UTF-8 时返回 None（保持原字节）。
    fn inject_uuid_polyfill(bytes: Vec<u8>) -> Option<Vec<u8>> {
        const MARKER: &str = "<head>";
        let mut html = String::from_utf8(bytes).ok()?;
        let pos = html.find(MARKER)? + MARKER.len();
        html.insert_str(pos, UUID_POLYFILL);
        Some(html.into_bytes())
    }

    fn editor_html_response(html: Vec<u8>) -> axum::response::Response {
        let html = inject_uuid_polyfill(html.clone()).unwrap_or(html);
        axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(axum::body::Body::from(html))
            .unwrap_or_default()
    }

    async fn editor_root(UrlState(st): UrlState<StaticState>) -> axum::response::Response {
        serve_editor(&st, "").await
    }

    async fn editor_file(
        UrlState(st): UrlState<StaticState>,
        UrlPath(path): UrlPath<String>,
    ) -> axum::response::Response {
        serve_editor(&st, &path).await
    }

    /// 官方 bundle 在站点根 `/sw.js` 注册 Service Worker。本部署有意禁用官方 SW
    /// （避免 SW 缓存干扰版本更新，fetch 时已删除 sw.js），但删除后注册会以
    /// 200 text/html（SPA 回退）失败并刷控制台错误。这里返回一个不拦截任何请求
    /// 的空 worker：注册成功、无缓存行为、无控制台错误。
    async fn sw_stub() -> axum::response::Response {
        const BODY: &str = "// VentoDocs no-op Service Worker：本部署不使用官方编辑器的 SW 缓存，\n// 此空 worker 仅使官方 bundle 的注册流程成功，不拦截任何请求。\n";
        let no_cache: header::HeaderValue = "no-cache".parse().unwrap();
        axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
            .header(header::CACHE_CONTROL, no_cache)
            .body(axum::body::Body::from(BODY.to_string()))
            .unwrap_or_default()
    }

    /// M2.29：浏览器默认请求 /favicon.ico（此前被 SPA 回退返回 index.html，favicon 加载失败）。
    /// 返回主站 favicon 的 SVG 字节（声明 image/svg+xml），主站与分享端口统一生效；
    /// 发布子域名由站点服务接管（site.rs 内同路径回退主站图标）。
    async fn favicon_route() -> axum::response::Response {
        const FA: &[u8] = include_bytes!("../../../web/dist/favicon.svg");
        axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/svg+xml")
            .header(header::CACHE_CONTROL, "public, max-age=86400")
            .body(axum::body::Body::from(FA.to_vec()))
            .unwrap_or_default()
    }

    /// 官方构建硬编码的根绝对路径别名：X2T worker 以 `/sdkjs/...`（站点根）请求，
    /// 部署在子路径（`/document`）时必须同盘服务同一目录，否则 worker 脚本 404/回退 HTML。
    async fn sdkjs_alias(
        UrlState(st): UrlState<StaticState>,
        UrlPath(path): UrlPath<String>,
    ) -> axum::response::Response {
        // 捕获的路径不含前导 /sdkjs/，映射回 editor-dist 下的真实目录
        serve_editor(&st, &format!("sdkjs/{}", path)).await
    }

    /// 从 `editor-dist/` 按文件服务 `/document` 下的资源；无扩展名未命中回退 index.html。
    async fn serve_editor(st: &StaticState, rel: &str) -> axum::response::Response {
        let Some(dir) = st.editor.as_deref() else {
            return editor_not_deployed();
        };
        // 路径穿越防护：拒绝绝对路径、`..` 段与空段（rel 本身可为空，表示 /document/ 根）
        if !rel.is_empty() && (rel.starts_with('/') || rel.split('/').any(|seg| seg == ".." || seg.is_empty())) {
            return editor_not_deployed();
        }
        let target = if rel.is_empty() {
            dir.join("index.html")
        } else {
            dir.join(rel)
        };
        if target.is_file() {
            match tokio::fs::read(&target).await {
                Ok(mut bytes) => {
                    // HTML 页面（/document 根的 index.html 及编辑器自身的 clean-url 页）注入 polyfill
                    if (rel.is_empty() || rel.ends_with(".html"))
                        && let Some(injected) = inject_uuid_polyfill(bytes.clone())
                    {
                        bytes = injected;
                    }
                    let mut resp = axum::response::Response::builder()
                        .status(StatusCode::OK)
                        .body(axum::body::Body::from(bytes))
                        .unwrap_or_default();
                    apply_editor_headers(&mut resp, rel);
                    resp
                }
                Err(_) => axum::response::Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                    .body(axum::body::Body::from("读取编辑器资源失败\n"))
                    .unwrap_or_default(),
            }
        } else if rel.contains('.') {
            // 带扩展名但未命中：404（不能回退 HTML，否则 404 的 js/wasm 会被当页面执行）
            axum::response::Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(axum::body::Body::from(format!("Not Found: /document/{rel}\n")))
                .unwrap_or_default()
        } else {
            // 无扩展名路径（编辑器自身的 clean-url 页面）→ 回退 index.html
            match tokio::fs::read(dir.join("index.html")).await {
                Ok(html) => editor_html_response(html),
                Err(_) => editor_not_deployed(),
            }
        }
    }

    /// `/document` 资源响应头（对齐官方镜像 sws.toml 契约）：
    /// 默认 `no-cache`；构建指纹化资源 immutable；
    /// `x2t.wasm.br` 文件内实际是 GZIP 字节，按 gzip 声明；`build-identity.json` 不缓存。
    /// COOP/COEP 已移除（见 `static_files` 注释），此处不再添加。
    fn apply_editor_headers(resp: &mut axum::response::Response, rel: &str) {
        let h = resp.headers_mut();
        let fonts_catalog = rel.starts_with("fonts/") && !rel.contains('.');
        // x2t.wasm.br 在 /document 下路径为 wasm/x2t/x2t.wasm.br，
        // 经 /sdkjs 别名路由时为 sdkjs/common/wasm/x2t/x2t.wasm.br，按文件名匹配。
        let is_x2t_wasm = rel == "wasm/x2t/x2t.wasm.br" || rel.ends_with("wasm/x2t/x2t.wasm.br");
        let content_type = if rel.is_empty() {
            "text/html; charset=utf-8"
        } else if fonts_catalog {
            "font/ttf"
        } else if is_x2t_wasm {
            "application/octet-stream"
        } else {
            static_mime(rel)
        };
        h.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
        h.insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
        let immutable: header::HeaderValue = "public, max-age=31536000, immutable".parse().unwrap();
        if rel.starts_with("assets/")
            || fonts_catalog
            || is_x2t_wasm
        {
            h.insert(header::CACHE_CONTROL, immutable);
        }
        if rel == "build-identity.json" {
            h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        }
        if is_x2t_wasm {
            // 注意：x2t.wasm.br 文件名带 .br，但官方镜像内的实际字节是 GZIP
            // （魔数 1f 8b，gzip -t 通过）；浏览器按声明的编码在网络层解码，
            // 声明 br 会导致解码失败（ReadableStream 读取中止）。
            h.insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        }
        if rel.starts_with("sdkjs/") || rel.starts_with("web-apps/") {
            h.insert("X-Robots-Tag", "noindex".parse().unwrap());
        }
    }

    axum::Router::new()
        .route("/", get(index_route))
        .route("/document", get(editor_root))
        .route("/document/", get(editor_root))
        .route("/document/{*path}", get(editor_file))
        // 官方编辑器硬编码的站点根绝对路径（X2T worker：/sdkjs/common/wasm/x2t/x2t.worker.js），
        // 部署在 /document 子路径时须把根下 sdkjs/ 也指回 editor-dist，否则 worker 404/被 SPA 回退。
        .route("/sdkjs/{*path}", get(sdkjs_alias))
        .route("/sw.js", get(sw_stub))
        .route("/favicon.ico", get(favicon_route))
        .route("/{*path}", get(static_or_index))
        .with_state(st)
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

/// 发布子域名路由（§11 / M2.28）：Host = `{publish_id}.{VIENTO_PUBLISH_DOMAIN}`。
///
/// - 站点已启用 → 直接返回站点原始文件（`site::serve_site` 三模式：static / spa / file_index），
///   不再重写进文档浏览器 SPA。
/// - 站点不存在 / 停用 / 目录已删除 → 整站 410 + `Cache-Control: no-store`。
/// - `/api/` 与 `/_env` 原样放行（公开 API 与环境信息在任意主机头下可用）。
/// - 未配置域名或非 `{pid}.{domain}` 主机头 → 直接放行。
/// - 主机头解析顺序：`X-Forwarded-Host`（首值）→ `Host`，均去掉端口并转小写
///   （适配会重写 Host 的前置代理）。
async fn host_publish_route(
    axum::extract::State(state): axum::extract::State<vk_api::AppState>,
    req: axum::extract::Request,
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
    let headers = req.headers();
    let xfh = axum::http::header::HeaderName::from_static("x-forwarded-host");
    // 主机头候选：X-Forwarded-Host 首值优先，其次 Host（代理可能重写 Host）
    let mut host: Option<String> = headers
        .get(&xfh)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| strip_port(s.trim().to_lowercase()));
    if host.as_deref().is_none_or(str::is_empty) {
        host = headers
            .get(axum::http::header::HOST)
            .and_then(|v| v.to_str().ok())
            .map(|s| strip_port(s.trim().to_lowercase()));
    }
    let Some(host) = host else {
        return run_next(next, req).await;
    };
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
    // 公开 API 与环境信息原样放行
    let path = req.uri().path();
    if path.starts_with("/api/") || path == "/_env" {
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
    // M2.28：直接服务站点原始文件（三模式），不再重写路径
    let method = req.method().clone();
    let raw_path = req.uri().path().to_string();
    let query = req.uri().query().map(|s| s.to_string());
    let hdrs = headers.clone();
    let body = if *req.method() == axum::http::Method::POST {
        match axum::body::to_bytes(req.into_body(), 1024 * 1024).await {
            Ok(b) => Some(b.to_vec()),
            Err(e) => {
                tracing::warn!(error = %e, "站点请求体读取失败");
                None
            }
        }
    } else {
        None
    };
    vk_api::site::serve_site(&state, &w, &method, &hdrs, &raw_path, query, body).await
}

/// 去端口（`example.com:8090` → `example.com`）。
fn strip_port(s: String) -> String {
    s.split_once(':')
        .map(|(h, _)| h.to_string())
        .unwrap_or(s)
}
