//! M2.28：发布站点「原始文件服务」+ 站点密码门。
//!
//! 由 host 中间件（vk-app `host_publish_route`）在 Host 命中
//! `{publish_id}.{VIENTO_PUBLISH_DOMAIN}` 且站点启用时直接调用（不再重写进 SPA）：
//!
//! - `static`（纯静态）：命中文件 → 直接返回；目录 → 有 `index.html` 返回它，否则 404；
//!   未命中 → 404。
//! - `spa`（Vite try_files）：命中文件 → 直接返回；目录/未命中 → 回退根 `index.html`；
//!   根目录也没有 `index.html` → 404。
//! - `file_index`（文件列表）：目录无 `index.html` → 服务端生成的文件列表页；
//!   未命中路径 → 404。
//!
//! 目录请求若无尾斜杠 → 308 重定向到带尾斜杠形式（保证相对链接正确）。
//! `policy=login`：无有效站点 token（cookie `vd_site_{pid}` 或 `Authorization: Bearer`）
//! 时返回服务端渲染的密码门页面；POST 密码正确 → Set-Cookie + 302 回原路径。
//! `preview_only`：与 anon 相同地内联服务（“仅预览”语义 = 禁止下载附件）。

use axum::body::Body;
use axum::http::header::{self, HeaderMap, COOKIE, SET_COOKIE};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use vk_core::model::{EntryKind, FileEntry};
use vk_store::repo::directories::Directories;
use vk_store::repo::files::Files;
use vk_store::repo::publishes::PublishWithDir;
use vk_store::repo::users::verify_password;
use vk_store::StoreError;

use crate::auth::{sign_site_token, verify_site_token};
use crate::files::{deliver_current, guess_mime};
use crate::AppState;

/// 站点 token / 密码门 cookie 有效期（小时）。
const SITE_TOKEN_TTL_HOURS: u64 = 24;
const INDEX_NAME: &str = "index.html";

/// M2.29：主站 favicon（内嵌 SVG）。发布站点自身没有 favicon 时，
/// 其 /favicon.ico 请求回退为主站图标（站点自带 favicon 时优先用站点自己的）。
const MAIN_FAVICON: &[u8] = include_bytes!("../../../web/dist/favicon.svg");

fn favicon_response() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/svg+xml")
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(MAIN_FAVICON.to_vec()))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// M2.28：站点主机请求处理（中间件完成 host 匹配 + 启用检查后调用）。
///
/// `path` = URL 路径（如 `/`、`/a/b.html`，不含查询串）；`query` = 查询串（重定向保留用）；
/// `body` = 请求体（仅密码门 POST 使用）。
pub async fn serve_site(
    state: &AppState,
    w: &PublishWithDir,
    method: &Method,
    headers: &HeaderMap,
    path: &str,
    query: Option<String>,
    body: Option<Vec<u8>>,
) -> Response {
    // 1) login 策略 → 站点密码门
    if w.publish.policy == "login" {
        let cookie_name = format!("vd_site_{}", w.publish.publish_id);
        let secret = &state.cfg.jwt_secret;
        let authorized = bearer_token(headers)
            .as_deref()
            .map(|t| verify_site_token(secret, t, &w.publish.publish_id))
            .unwrap_or(false)
            || cookie_token(headers, &cookie_name)
                .as_deref()
                .map(|t| verify_site_token(secret, t, &w.publish.publish_id))
                .unwrap_or(false);
        if !authorized {
            return match method.as_str() {
                "POST" => password_post(state, w, path, query.as_deref(), body.as_deref()).await,
                _ => gate_page(None, path),
            };
        }
    }
    // 2) 仅 GET/HEAD 提供内容
    if method.as_str() != "GET" && method.as_str() != "HEAD" {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(Body::empty())
            .unwrap_or_default();
    }
    // 3) 路径解析 + 三模式服务
    serve_content(state, w, path, query).await
}

// ---------------------------------------------------------------------------
// 三模式内容服务
// ---------------------------------------------------------------------------

async fn serve_content(
    state: &AppState,
    w: &PublishWithDir,
    path: &str,
    query: Option<String>,
) -> Response {
    let pool = state.db.pool();
    let mode = w.publish.site_mode.as_str();
    let segs = match parse_segments(path) {
        Some(s) => s,
        None => return html_not_found(path),
    };
    // 逐段遍历目录树（每段 1 次查询）。cur = 当前目录，terminal_dir = 末段是目录。
    let mut cur = w.directory.id;
    let mut file: Option<FileEntry> = None;
    let mut terminal_dir = segs.is_empty();
    for (i, seg) in segs.iter().enumerate() {
        let last = i == segs.len() - 1;
        let (_, ch) = match Directories::list_children(pool, cur).await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(error = %e, "站点目录列表查询失败");
                return server_error();
            }
        };
        match find_by_name(&ch, seg) {
            Some(EntryKind::Directory { directory }) => {
                cur = directory.id;
                if last {
                    terminal_dir = true;
                }
            }
            Some(EntryKind::File(f)) => {
                if last {
                    file = Some(f.clone());
                } else {
                    // 中段命中文件 → 路径不成立
                    return html_not_found(path);
                }
            }
            None => {
                // 未命中。M2.29：favicon 请求（favicon.ico / favicon.svg）而站点没有
                // 对应文件时回退主站 favicon（站点自带 favicon 已在上面按名字命中，不受影响）。
                let want_favicon = segs
                    .last()
                    .is_some_and(|s| s == "favicon.ico" || s == "favicon.svg");
                if want_favicon {
                    return favicon_response();
                }
                return match mode {
                    "spa" => root_index(state, w).await,
                    _ => html_not_found(path),
                };
            }
        }
    }
    if let Some(f) = file {
        return serve_file(state, pool, &f).await;
    }
    // 目录终点（含根）→ 取该目录自身子项
    if !terminal_dir {
        return html_not_found(path);
    }
    // 目录若无尾斜杠 → 308 规范化（保证相对链接正确）
    if !path.ends_with('/') {
        let loc = match query {
            Some(q) if !q.is_empty() => format!("{path}/?{q}"),
            _ => format!("{path}/"),
        };
        return Response::builder()
            .status(StatusCode::PERMANENT_REDIRECT)
            .header(header::LOCATION, loc)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap_or_default();
    }
    let (_, ch) = match Directories::list_children(pool, cur).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, "站点目录列表查询失败");
            return server_error();
        }
    };
    let idx = ch
        .iter()
        .find(|e| matches!(e, EntryKind::File(f) if f.file.name == INDEX_NAME))
        .and_then(file_of);
    match (idx, mode) {
        (Some(f), _) => serve_file(state, pool, f).await,
        (None, "spa") => root_index(state, w).await,
        (None, "file_index") => listing_page(path, &ch),
        (None, _) => html_not_found(path),
    }
}

/// spa 模式回退：根目录 `index.html`；没有 → 404。
async fn root_index(state: &AppState, w: &PublishWithDir) -> Response {
    let pool = state.db.pool();
    let (_, ch) = match Directories::list_children(pool, w.directory.id).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, "站点根目录列表查询失败");
            return server_error();
        }
    };
    let Some(idx) = ch
        .iter()
        .find(|e| matches!(e, EntryKind::File(f) if f.file.name == INDEX_NAME))
        .and_then(file_of)
    else {
        return html_not_found("/index.html");
    };
    serve_file(state, pool, idx).await
}

/// `EntryKind::File` → `&FileEntry`；目录返回 None。
fn file_of(e: &EntryKind) -> Option<&FileEntry> {
    match e {
        EntryKind::File(f) => Some(f),
        _ => None,
    }
}

/// 文件命中 → 内联流式返回（复用 API 交付逻辑：mime / Content-Disposition / 流）。
/// M2.29：站点文件的 Content-Type 按扩展名重猜（修复 DB 中遗留的 `application/octet-stream`
/// 把 html 等当下载的问题）；HTML 文件去掉 Content-Disposition（inline 时部分浏览器会
/// 因此按下载处理）。
async fn serve_file(state: &AppState, pool: &sqlx::PgPool, f: &FileEntry) -> Response {
    let mut resp = match Files::get_meta(pool, f.file.id).await {
        Ok(meta) => match deliver_current(state, &meta, false).await {
            Ok(r) => r,
            Err(e) => return e.into_response(),
        },
        Err(StoreError::NotFound(_)) => return html_not_found(&f.file.name),
        Err(e) => {
            tracing::error!(error = %e, "站点文件元数据查询失败");
            return server_error();
        }
    };
    patch_site_headers(&mut resp, &f.file.name);
    resp
}

/// M2.29：站点文件交付后的响应头修正。
fn patch_site_headers(resp: &mut Response, name: &str) {
    let guessed = guess_mime(name);
    if guessed != "application/octet-stream" {
        if let Ok(ct) = guessed.parse() {
            resp.headers_mut().insert(header::CONTENT_TYPE, ct);
        }
    }
    let lower = name.to_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        resp.headers_mut().remove(header::CONTENT_DISPOSITION);
    }
}

// ---------------------------------------------------------------------------
// 密码门（login 策略）
// ---------------------------------------------------------------------------

async fn password_post(
    state: &AppState,
    w: &PublishWithDir,
    path: &str,
    query: Option<&str>,
    body: Option<&[u8]>,
) -> Response {
    let Some(hash) = w.publish.password_hash.clone() else {
        // 防御：login 策略必然有密码；没有则提示
        return gate_page(Some("站点尚未设置访问密码，请联系管理员"), path);
    };
    let ok = extract_password(body)
        .as_deref()
        .map(|p| !p.is_empty() && verify_password(p, &hash))
        .unwrap_or(false);
    if !ok {
        return gate_page(Some("站点密码错误"), path);
    }
    let token = match sign_site_token(&state.cfg.jwt_secret, &w.publish.publish_id, SITE_TOKEN_TTL_HOURS) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "站点令牌签发失败");
            return server_error();
        }
    };
    let cookie_name = format!("vd_site_{}", w.publish.publish_id);
    let location = match query {
        Some(q) if !q.is_empty() => format!("{path}?{q}"),
        _ => path.to_string(),
    };
    let cookie = format!(
        "{cookie_name}={token}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax",
        SITE_TOKEN_TTL_HOURS * 3600
    );
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .header(SET_COOKIE, cookie)
        .body(Body::empty())
        .unwrap_or_default()
}

/// 服务端渲染密码门（无 JS / 无 SPA 依赖）。
fn gate_page(err: Option<&str>, path: &str) -> Response {
    // 错误（密码错误 / 尚未设置密码）→ 401；正常门页面 → 200
    let status = if err.is_some() {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::OK
    };
    let action = html_escape(path);
    let err_html = err
        .map(|e| format!("<div class=\"err\">{}</div>", html_escape(e)))
        .unwrap_or_default();
    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>该站点需要访问密码</title>
<style>
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f7;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}}
.card{{background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.06);padding:32px 36px;width:340px;}}
h1{{font-size:17px;margin:0 0 6px;color:#111827;}}
p{{color:#6b7280;font-size:13px;margin:0 0 18px;}}
input{{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;}}
button{{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer;}}
button:disabled{{opacity:.7;cursor:default;}}
button.loading::after{{content:"";display:inline-block;width:12px;height:12px;margin-left:8px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:vdspin .8s linear infinite;vertical-align:-2px;}}
@keyframes vdspin{{to{{transform:rotate(360deg);}}}}
.err{{color:#dc2626;font-size:12px;margin-top:10px;}}
</style>
</head>
<body>
<div class="card">
<h1>🔒 该站点需要访问密码</h1>
<p>请输入站点密码后继续访问</p>
<form method="post" action="{action}">
<input type="password" name="password" placeholder="站点密码" autofocus autocomplete="current-password">
{err_html}
<button type="submit">进入站点</button>
</form>
</div>
<script>
// M2.29：提交时禁用按钮并显示校验中状态，避免双击重复提交与无反馈的卡顿感。
// JS 被禁用时表单仍按原生 POST 正常提交（无 JS 回退保留）。
document.querySelector('form').addEventListener('submit', function () {{
  var b = this.querySelector('button[type=submit]');
  if (b) {{ b.disabled = true; b.classList.add('loading'); b.textContent = '校验中…'; }}
}});
</script>
</body>
</html>"#
    );
    html_response(status, html)
}

/// 从 urlencoded 或 JSON 请求体里取密码字段。
fn extract_password(body: Option<&[u8]>) -> Option<String> {
    let b = body?;
    let s = std::str::from_utf8(b).ok()?.trim();
    if s.starts_with('{') {
        let v = serde_json::from_str::<serde_json::Value>(s).ok()?;
        return v.get("password").and_then(|p| p.as_str()).map(|p| p.to_string());
    }
    for kv in s.split('&') {
        let (k, v) = kv.split_once('=')?;
        if k == "password" && !v.is_empty() {
            return Some(percent_decode(v));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// file_index 列表页 / 404 页
// ---------------------------------------------------------------------------

fn listing_page(path: &str, children: &[EntryKind]) -> Response {
    let mut rows = String::new();
    if path != "/" {
        rows.push_str("<tr><td><a href=\"../\">../</a></td><td></td><td></td></tr>\n");
    }
    for e in children {
        match e {
            EntryKind::Directory { directory } => {
                let name = html_escape(&directory.name);
                rows.push_str(&format!(
                    "<tr><td><a href=\"{name}/\">{name}/</a></td><td></td><td>-</td></tr>\n"
                ));
            }
            EntryKind::File(f) => {
                let name = html_escape(&f.file.name);
                rows.push_str(&format!(
                    "<tr><td><a href=\"{name}\">{name}</a></td><td class=\"size\">{}</td><td>{}</td></tr>\n",
                    human_size(f.file.size),
                    fmt_dt(&f.file.updated_at)
                ));
            }
        }
    }
    let title = html_escape(path);
    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Index of {title}</title>
<style>
body{{margin:0;padding:24px 32px;background:#fafafa;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#111827;}}
h1{{font-size:16px;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0 0 16px;color:#374151;}}
table{{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:8px;}}
th,td{{text-align:left;padding:8px 14px;font-size:13px;border-bottom:1px solid #f3f4f6;}}
th{{background:#f9fafb;color:#6b7280;font-weight:600;}}
a{{color:#2563eb;text-decoration:none;}}
a:hover{{text-decoration:underline;}}
.size{{color:#9ca3af;}}
</style>
</head>
<body>
<h1>Index of {title}</h1>
<table>
<tr><th>名称</th><th>大小</th><th>更新时间</th></tr>
{rows}</table>
</body>
</html>"#
    );
    html_response(StatusCode::OK, html)
}

fn html_not_found(path: &str) -> Response {
    let p = html_escape(path);
    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>404 未找到</title>
<style>
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f9fafb;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#111827;}}
main{{text-align:center;}}
h1{{font-size:56px;margin:0;color:#111827;}}
p{{color:#6b7280;font-size:14px;margin:8px 0 0;}}
code{{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px;}}
</style>
</head>
<body>
<main>
<h1>404</h1>
<p>未找到 <code>{p}</code></p>
</main>
</body>
</html>"#
    );
    html_response(StatusCode::NOT_FOUND, html)
}

fn server_error() -> Response {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(Body::from("Internal Server Error"))
        .unwrap_or_default()
}

fn html_response(status: StatusCode, html: String) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(html))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/// URL 路径 → 段列表；含 `.`/`..`/空段（percent-decode 后）→ None（404）。
fn parse_segments(path: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in path.split('/') {
        if raw.is_empty() {
            continue;
        }
        let dec = percent_decode(raw);
        if dec.is_empty() || dec == "." || dec == ".." {
            return None;
        }
        out.push(dec);
    }
    Some(out)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hi = (b[i + 1] as char).to_digit(16);
            let lo = (b[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn find_by_name<'a>(children: &'a [EntryKind], name: &str) -> Option<&'a EntryKind> {
    children.iter().find(|e| match e {
        EntryKind::Directory { directory } => directory.name == name,
        EntryKind::File(f) => f.file.name == name,
    })
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let v = v.trim();
    let mut it = v.splitn(2, ' ');
    let scheme = it.next()?;
    let token = it.next()?.trim();
    if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() {
        Some(token.to_string())
    } else {
        None
    }
}

fn cookie_token(headers: &HeaderMap, name: &str) -> Option<String> {
    for raw in headers.get_all(COOKIE).iter() {
        let s = raw.to_str().ok()?;
        for kv in s.split(';') {
            let kv = kv.trim();
            let (k, v) = kv.split_once('=')?;
            if k == name && !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn fmt_dt(dt: &chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M").to_string()
}

fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.2} MB", b / MB)
    } else if b >= KB {
        format!("{:.2} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}
