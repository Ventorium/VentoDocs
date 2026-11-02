//! WebDAV 挂载（M2.44）：把「个人 / 团队 / 分享给我」映射为三个顶级目录。
//!
//! 认证：HTTP Basic（用户名或邮箱 + 登录密码）；LDAP 用户走 LDAP bind 校验。
//! 权限：完全复用目录/文件授权（`Grants::resolve` / `resolve_for_file`），
//! 配额与在线 API 共用同一套限额。锁：进程内内存锁（单实例部署）。
//!
//! 支持：OPTIONS / PROPFIND / PROPPATCH / GET / HEAD / PUT / MKCOL /
//! DELETE / MOVE / COPY / LOCK / UNLOCK。Depth 仅支持 0/1（infinity 返回 403）。

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use bytes::BytesMut;
use chrono::{DateTime, Utc};
use futures_util::Stream;
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, ReadBuf, SeekFrom};
use uuid::Uuid;
use vk_core::model::{AuthProvider, EntryKind, FileMeta};
use vk_core::perm::Perm;
use vk_store::StoreError;
use vk_store::repo::audit::Audit;
use vk_store::repo::directories::Directories;
use vk_store::repo::files::Files;
use vk_store::repo::grants::Grants;
use vk_store::repo::ldap;
use vk_store::repo::users::{Users, verify_password as verify_password_hash};

use crate::AppState;
use vk_store::ROOT_DIR as ROOT;

const DAV_PREFIX: &str = "/dav";
const MAX_LOCK_SECS: u64 = 7 * 24 * 3600;
/// Basic 凭据校验结果缓存 TTL：Windows/macOS 每个请求都会带 Basic 头，
/// 每次都跑 Argon2/LDAP bind 会让挂载浏览慢到不可用。
const AUTH_CACHE_TTL: Duration = Duration::from_secs(300);

/// 路径段编码：保留 RFC3986 unreserved 字符，其余（含非 ASCII）逐字节百分号编码。
const SEG_ENCODE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'%')
    .add(b'/');

// ── 用户与作用域 ────────────────────────────────────────────────────────────

#[derive(Clone)]
struct DavUser {
    id: Uuid,
    display_name: String,
    is_admin: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Personal,
    Team,
    Shared,
}

impl Scope {
    fn label(self) -> &'static str {
        match self {
            Scope::Personal => "个人",
            Scope::Team => "团队",
            Scope::Shared => "分享给我",
        }
    }

    fn api(self) -> &'static str {
        match self {
            Scope::Personal => "personal",
            Scope::Team => "team",
            Scope::Shared => "me",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "个人" | "personal" => Some(Scope::Personal),
            "团队" | "team" => Some(Scope::Team),
            "分享给我" | "shared" | "me" => Some(Scope::Shared),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ResKind {
    Dir,
    File,
}

#[derive(Clone)]
struct DavRes {
    kind: ResKind,
    id: Uuid,
    scope: Scope,
    /// 展示路径（含作用域首段），例如 `["个人", "项目", "a.txt"]`。
    segs: Vec<String>,
}

enum Target {
    Root,
    ScopeRoot(Scope),
    Res(DavRes),
    /// 末级路径尚不存在（父级均已解析）：PUT/MKCOL/LOCK-null 用它落新建。
    Missing,
}

#[derive(Clone)]
struct TopEntry {
    display: String,
    kind: ResKind,
    id: Uuid,
}

// ── 错误 ────────────────────────────────────────────────────────────────────

struct DavError {
    status: StatusCode,
    msg: String,
}

impl DavError {
    fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self {
            status,
            msg: msg.into(),
        }
    }

    fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "资源不存在")
    }

    fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "权限不足")
    }

    fn into_response(self) -> Response {
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:error xmlns:d=\"DAV:\"><d:message>{}</d:message></d:error>",
            esc(&self.msg)
        );
        (
            self.status,
            [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
            body,
        )
            .into_response()
    }
}

impl From<StoreError> for DavError {
    fn from(e: StoreError) -> Self {
        let status = match e {
            StoreError::NotFound(_) => StatusCode::NOT_FOUND,
            StoreError::NameConflict(_) => StatusCode::CONFLICT,
            StoreError::ParentInvalid(_) => StatusCode::CONFLICT,
            StoreError::RootProtected => StatusCode::FORBIDDEN,
            StoreError::FileLocked => StatusCode::LOCKED,
            StoreError::VersionConflict { .. } => StatusCode::CONFLICT,
            StoreError::InTrash => StatusCode::GONE,
            StoreError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self::new(status, e.to_string())
    }
}

type DResult<T> = Result<T, DavError>;

// ── 入口 ────────────────────────────────────────────────────────────────────

pub async fn handle(State(state): State<AppState>, req: Request) -> Response {
    let method = req.method().clone();
    if method == Method::OPTIONS {
        return options_response();
    }
    let headers = req.headers().clone();
    let user = match authenticate(&state, &headers).await {
        Ok(u) => u,
        Err(resp) => return resp,
    };
    let segs = match path_segments(req.uri().path()) {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    let body = req.into_body();
    let out = match method.as_str() {
        "PROPFIND" => propfind(&state, &user, &segs, &headers).await,
        "PROPPATCH" => proppatch(&state, &user, &segs).await,
        "GET" => read_file(&state, &user, &segs, &headers, false).await,
        "HEAD" => read_file(&state, &user, &segs, &headers, true).await,
        "PUT" => put(&state, &user, &segs, &headers, body).await,
        "MKCOL" => mkcol(&state, &user, &segs).await,
        "DELETE" => delete(&state, &user, &segs, &headers).await,
        "MOVE" => move_or_copy(&state, &user, &segs, &headers, true).await,
        "COPY" => move_or_copy(&state, &user, &segs, &headers, false).await,
        "LOCK" => lock(&state, &user, &segs, &headers).await,
        "UNLOCK" => unlock(&state, &user, &segs, &headers).await,
        _ => Err(DavError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "该资源不支持此方法",
        )),
    };
    match out {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

fn options_response() -> Response {
    let allow =
        "OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, PROPFIND, PROPPATCH, LOCK, UNLOCK";
    (
        StatusCode::OK,
        [
            (header::ALLOW, allow),
            (header::CONTENT_LENGTH, "0"),
            (HeaderName::from_static("dav"), "1, 2"),
            (HeaderName::from_static("ms-author-via"), "DAV"),
        ],
    )
        .into_response()
}

// ── 认证 ────────────────────────────────────────────────────────────────────

fn unauthorized(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [
            (
                header::WWW_AUTHENTICATE,
                "Basic realm=\"VentoDocs WebDAV\", charset=\"UTF-8\"",
            ),
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
        ],
        msg.to_string(),
    )
        .into_response()
}

fn basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, encoded) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let (user, pass) = text.split_once(':')?;
    if user.is_empty() {
        return None;
    }
    Some((user.to_string(), pass.to_string()))
}

#[allow(clippy::result_large_err)] // 401 响应体很小，这里不为它额外 Box
async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<DavUser, Response> {
    let Some((ident, pass)) = basic_credentials(headers) else {
        return Err(unauthorized("需要 WebDAV 基本认证"));
    };
    let pool = state.db.pool();
    let user = match Users::get_by_identifier(pool, &ident).await {
        Ok(Some(u)) => u,
        _ => return Err(unauthorized("用户名或密码错误")),
    };
    if user.disabled {
        return Err(unauthorized("账号已被禁用"));
    }
    let cache_key = auth_cache_key(&user.username, &pass);
    let cached = auth_cache_get(&cache_key).is_some();
    let ok = if cached {
        true
    } else {
        let verified = match user.auth_provider {
            AuthProvider::Local => user
                .password_hash
                .as_deref()
                .map(|h| verify_password_hash(&pass, h))
                .unwrap_or(false),
            AuthProvider::Ldap => verify_ldap_password(state, &user, &pass).await,
        };
        if verified {
            auth_cache_put(&cache_key);
        }
        verified
    };
    if !ok {
        return Err(unauthorized("用户名或密码错误"));
    }
    Ok(DavUser {
        id: user.id,
        display_name: user.display_name,
        is_admin: user.role == vk_core::model::Role::Admin,
    })
}

// Basic 凭据缓存（仅内存；key = SHA-256(用户名:密码)，不保存明文密码）。
static AUTH_CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn auth_cache() -> &'static Mutex<HashMap<String, Instant>> {
    AUTH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn auth_cache_key(username: &str, pass: &str) -> String {
    let mut h = Sha256::new();
    h.update(username.as_bytes());
    h.update(b":");
    h.update(pass.as_bytes());
    format!("{:x}", h.finalize())
}

fn auth_cache_get(key: &str) -> Option<()> {
    let mut map = auth_cache().lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    if let Some(until) = map.get(key) {
        if *until > now {
            return Some(());
        }
        map.remove(key);
    }
    None
}

fn auth_cache_put(key: &str) {
    let mut map = auth_cache().lock().unwrap_or_else(|e| e.into_inner());
    if map.len() > 8192 {
        let now = Instant::now();
        map.retain(|_, until| *until > now);
    }
    map.insert(key.to_string(), Instant::now() + AUTH_CACHE_TTL);
}

async fn verify_ldap_password(state: &AppState, user: &vk_core::model::User, pass: &str) -> bool {
    let key = ldap::derive_key(&state.cfg.jwt_secret);
    let Ok(Some((cfg, _, _))) = ldap::resolve_ldap_config(state.db.pool(), &key).await else {
        return false;
    };
    ldap::verify_credentials(&cfg, &user.username, user.ldap_dn.as_deref(), pass)
        .await
        .unwrap_or(false)
}

// ── 路径 ────────────────────────────────────────────────────────────────────

fn path_segments(path: &str) -> DResult<Vec<String>> {
    let rel = path.strip_prefix(DAV_PREFIX).unwrap_or(path);
    decode_segments(rel)
}

fn decode_segments(rel: &str) -> DResult<Vec<String>> {
    let trimmed = rel.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    trimmed
        .split('/')
        .map(|raw| {
            let dec = percent_decode_str(raw)
                .decode_utf8()
                .map_err(|_| DavError::new(StatusCode::BAD_REQUEST, "路径编码非法"))?;
            let s = dec.into_owned();
            if s.is_empty() || s == "." || s == ".." || s.contains('/') || s.contains('\\') {
                return Err(DavError::new(StatusCode::BAD_REQUEST, "路径非法"));
            }
            Ok(s)
        })
        .collect()
}

fn encode_seg(s: &str) -> String {
    utf8_percent_encode(s, SEG_ENCODE).to_string()
}

fn href_for(segs: &[String], is_dir: bool) -> String {
    let mut out = String::from(DAV_PREFIX);
    for seg in segs {
        out.push('/');
        out.push_str(&encode_seg(seg));
    }
    if is_dir {
        out.push('/');
    }
    out
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 255
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
}

// ── 顶级目录与解析 ──────────────────────────────────────────────────────────

async fn top_entries(state: &AppState, user: &DavUser, scope: Scope) -> DResult<Vec<TopEntry>> {
    let pool = state.db.pool();
    match scope {
        Scope::Personal => {
            let (_root, children) = Directories::list_children(pool, ROOT).await?;
            let mut out = Vec::new();
            for e in children {
                match e {
                    EntryKind::Directory { directory } => {
                        if directory.created_by == Some(user.id) {
                            out.push(TopEntry {
                                display: directory.name.clone(),
                                kind: ResKind::Dir,
                                id: directory.id,
                            });
                        }
                    }
                    EntryKind::File(f) => {
                        if f.file.created_by == Some(user.id) {
                            out.push(TopEntry {
                                display: f.file.name.clone(),
                                kind: ResKind::File,
                                id: f.file.id,
                            });
                        }
                    }
                }
            }
            Ok(out)
        }
        Scope::Team | Scope::Shared => {
            let shared = Grants::list_shared(pool, user.id, scope.api()).await?;
            // 同名共享目录加序号，保证 WebDAV 路径唯一且稳定（按名称排序后顺序分配）；
            // 没有可读权限的授权（例如仅写位）不出现在挂载目录里。
            let mut counts: HashMap<String, usize> = HashMap::new();
            let mut out = Vec::new();
            for d in shared {
                if !Perm::from_bits_retain(d.perms).contains(Perm::READ_PREVIEW) {
                    continue;
                }
                let n = counts.entry(d.name.clone()).or_insert(0);
                *n += 1;
                let display = if *n == 1 {
                    d.name.clone()
                } else {
                    format!("{} ({})", d.name, n)
                };
                out.push(TopEntry {
                    display,
                    kind: ResKind::Dir,
                    id: d.id,
                });
            }
            Ok(out)
        }
    }
}

async fn resolve_target(state: &AppState, user: &DavUser, segs: &[String]) -> DResult<Target> {
    if segs.is_empty() {
        return Ok(Target::Root);
    }
    let scope = Scope::parse(&segs[0])
        .ok_or_else(|| DavError::new(StatusCode::NOT_FOUND, "未知的顶级目录"))?;
    if segs.len() == 1 {
        return Ok(Target::ScopeRoot(scope));
    }
    let tops = top_entries(state, user, scope).await?;
    let Some(first) = tops.iter().find(|t| t.display == segs[1]) else {
        if segs.len() == 2 {
            return Ok(Target::Missing);
        }
        return Err(DavError::not_found());
    };
    let mut kind = first.kind;
    let mut id = first.id;
    for (idx, seg) in segs[2..].iter().enumerate() {
        if kind == ResKind::File {
            return Err(DavError::not_found());
        }
        let (_dir, children) = Directories::list_children(state.db.pool(), id).await?;
        let Some(found) = children.iter().find(|e| entry_name(e) == *seg) else {
            if idx == segs[2..].len() - 1 {
                return Ok(Target::Missing);
            }
            return Err(DavError::not_found());
        };
        match found {
            EntryKind::Directory { directory } => {
                kind = ResKind::Dir;
                id = directory.id;
            }
            EntryKind::File(f) => {
                kind = ResKind::File;
                id = f.file.id;
            }
        }
    }
    Ok(Target::Res(DavRes {
        kind,
        id,
        scope,
        segs: segs.to_vec(),
    }))
}

fn entry_name(e: &EntryKind) -> &str {
    match e {
        EntryKind::Directory { directory } => &directory.name,
        EntryKind::File(f) => &f.file.name,
    }
}

async fn res_meta(state: &AppState, res: &DavRes) -> DResult<ResMeta> {
    let pool = state.db.pool();
    match res.kind {
        ResKind::Dir => {
            let d = Directories::get(pool, res.id).await?;
            Ok(ResMeta::Dir(d))
        }
        ResKind::File => {
            let f = Files::get_meta(pool, res.id).await?;
            Ok(ResMeta::File(f))
        }
    }
}

enum ResMeta {
    Dir(vk_core::model::Directory),
    File(FileMeta),
}

async fn perms_of(state: &AppState, user: &DavUser, res: &DavRes) -> DResult<Perm> {
    let pool = state.db.pool();
    let p = match res.kind {
        ResKind::Dir => Grants::resolve(pool, user.id, res.id, user.is_admin).await?,
        ResKind::File => Grants::resolve_for_file(pool, user.id, res.id, user.is_admin).await?,
    };
    Ok(p)
}

/// 解析写操作的父目录：返回（父目录 id、父目录权限）。
/// `/dav` 根不能写；`/个人` 根对应物理根目录 ROOT（与 REST API 一致，允许建顶级条目）。
async fn resolve_parent(
    state: &AppState,
    user: &DavUser,
    parent_segs: &[String],
) -> DResult<(Uuid, Perm)> {
    match resolve_target(state, user, parent_segs).await? {
        Target::Root => Err(DavError::new(
            StatusCode::FORBIDDEN,
            "不能在 WebDAV 根目录直接写入",
        )),
        Target::ScopeRoot(Scope::Personal) => Ok((ROOT, Perm::all())),
        Target::ScopeRoot(_) => Err(DavError::new(
            StatusCode::FORBIDDEN,
            "团队/分享给我的顶级目录不能直接新建条目",
        )),
        Target::Res(res) => {
            if res.kind != ResKind::Dir {
                return Err(DavError::new(StatusCode::CONFLICT, "父级不是目录"));
            }
            let perms = perms_of(state, user, &res).await?;
            Ok((res.id, perms))
        }
        Target::Missing => Err(DavError::not_found()),
    }
}

// ── XML 输出 ────────────────────────────────────────────────────────────────

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn http_date(t: DateTime<Utc>) -> String {
    t.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

struct DavNode {
    href: String,
    name: String,
    is_dir: bool,
    size: u64,
    mime: String,
    mtime: DateTime<Utc>,
    etag: Option<String>,
}

fn node_from_dir(d: &vk_core::model::Directory, segs: &[String]) -> DavNode {
    DavNode {
        href: href_for(segs, true),
        name: d.name.clone(),
        is_dir: true,
        size: 0,
        mime: "httpd/unix-directory".into(),
        mtime: d.created_at,
        etag: None,
    }
}

fn node_from_file(f: &FileMeta, segs: &[String]) -> DavNode {
    DavNode {
        href: href_for(segs, false),
        name: f.name.clone(),
        is_dir: false,
        size: f.size,
        mime: f.mime.clone(),
        mtime: f.updated_at,
        etag: Some(file_etag(f)),
    }
}

fn file_etag(f: &FileMeta) -> String {
    format!(
        "\"{}-{}-{}-{}\"",
        f.size,
        f.current_version,
        f.updated_at.timestamp_millis(),
        f.id
    )
}

fn node_xml(n: &DavNode) -> String {
    let resourcetype = if n.is_dir {
        "<d:resourcetype><d:collection/></d:resourcetype>"
    } else {
        "<d:resourcetype/>"
    };
    let etag = n
        .etag
        .as_deref()
        .map(|e| format!("<d:getetag>{}</d:getetag>", esc(e)))
        .unwrap_or_default();
    let content_length = if n.is_dir {
        String::new()
    } else {
        format!("<d:getcontentlength>{}</d:getcontentlength>", n.size)
    };
    format!(
        "<d:response><d:href>{}</d:href><d:propstat><d:prop>\
<d:displayname>{}</d:displayname>{}\
<d:getcontenttype>{}</d:getcontenttype>{}\
<d:getlastmodified>{}</d:getlastmodified>{}\
<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>\
{}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
        esc(&n.href),
        esc(&n.name),
        resourcetype,
        esc(&n.mime),
        content_length,
        esc(&http_date(n.mtime)),
        etag,
        lock_discovery_xml(&n.href),
    )
}

/// PROPFIND 的 `lockdiscovery`：把当前进程内仍有效的锁回给客户端。
/// Windows/Office 在 LOCK 后会重新 PROPFIND 校验，返回空会让它们误判未加锁。
fn lock_discovery_xml(href: &str) -> String {
    let now = Instant::now();
    let mut map = locks().lock().unwrap_or_else(|e| e.into_inner());
    let mut body = String::new();
    for (h, l) in map.iter() {
        if h != href {
            continue;
        }
        if l.expires <= now {
            continue;
        }
        let remaining = l.expires.saturating_duration_since(now).as_secs().max(1);
        body.push_str(&format!(
            "<d:activelock><d:locktype><d:write/></d:locktype>\
<d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth>\
<d:owner>{}</d:owner><d:timeout>Second-{}</d:timeout>\
<d:locktoken><d:href>{}</d:href></d:locktoken><d:lockroot><d:href>{}</d:href></d:lockroot></d:activelock>",
            esc(&l.owner),
            remaining,
            esc(&l.token),
            esc(h)
        ));
    }
    map.retain(|_, l| l.expires > now);
    format!("<d:lockdiscovery>{body}</d:lockdiscovery>")
}

fn multistatus(nodes: &[DavNode]) -> Response {
    let mut body =
        String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?><d:multistatus xmlns:d=\"DAV:\">");
    for n in nodes {
        body.push_str(&node_xml(n));
    }
    body.push_str("</d:multistatus>");
    (
        StatusCode::MULTI_STATUS,
        [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
        body,
    )
        .into_response()
}

// ── PROPFIND / PROPPATCH ────────────────────────────────────────────────────

async fn propfind(
    state: &AppState,
    user: &DavUser,
    segs: &[String],
    headers: &HeaderMap,
) -> DResult<Response> {
    let depth = headers
        .get("depth")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("infinity")
        .trim()
        .to_string();
    if depth == "infinity" {
        return Err(DavError::new(
            StatusCode::FORBIDDEN,
            "不支持 Depth: infinity（请使用 0/1）",
        ));
    }
    let deep = depth == "1";
    let target = resolve_target(state, user, segs).await?;
    let mut nodes: Vec<DavNode> = Vec::new();
    match target {
        Target::Missing => return Err(DavError::not_found()),
        Target::Root => {
            nodes.push(DavNode {
                href: href_for(&[], true),
                name: "WebDAV".into(),
                is_dir: true,
                size: 0,
                mime: "httpd/unix-directory".into(),
                mtime: Utc::now(),
                etag: None,
            });
            if deep {
                for scope in [Scope::Personal, Scope::Team, Scope::Shared] {
                    nodes.push(scope_node(scope));
                }
            }
        }
        Target::ScopeRoot(scope) => {
            nodes.push(scope_node(scope));
            if deep {
                for t in top_entries(state, user, scope).await? {
                    let tsegs = vec![scope.label().to_string(), t.display.clone()];
                    match t.kind {
                        ResKind::Dir => {
                            let d = Directories::get(state.db.pool(), t.id).await?;
                            nodes.push(node_from_dir(&d, &tsegs));
                        }
                        ResKind::File => {
                            let f = Files::get_meta(state.db.pool(), t.id).await?;
                            nodes.push(node_from_file(&f, &tsegs));
                        }
                    }
                }
            }
        }
        Target::Res(res) => {
            let meta = res_meta(state, &res).await?;
            match &meta {
                ResMeta::Dir(d) => {
                    nodes.push(node_from_dir(d, &res.segs));
                    if deep {
                        let (_d, children) =
                            Directories::list_children(state.db.pool(), res.id).await?;
                        for e in children {
                            let mut csegs = res.segs.clone();
                            match e {
                                EntryKind::Directory { directory } => {
                                    csegs.push(directory.name.clone());
                                    nodes.push(node_from_dir(&directory, &csegs));
                                }
                                EntryKind::File(f) => {
                                    csegs.push(f.file.name.clone());
                                    nodes.push(node_from_file(&f.file, &csegs));
                                }
                            }
                        }
                    }
                }
                ResMeta::File(f) => nodes.push(node_from_file(f, &res.segs)),
            }
        }
    }
    Ok(multistatus(&nodes))
}

fn scope_node(scope: Scope) -> DavNode {
    DavNode {
        href: href_for(&[scope.label().to_string()], true),
        name: scope.label().into(),
        is_dir: true,
        size: 0,
        mime: "httpd/unix-directory".into(),
        mtime: Utc::now(),
        etag: None,
    }
}

async fn proppatch(state: &AppState, user: &DavUser, segs: &[String]) -> DResult<Response> {
    let target = resolve_target(state, user, segs).await?;
    let href = match target {
        Target::Root => href_for(&[], true),
        Target::ScopeRoot(s) => href_for(&[s.label().to_string()], true),
        Target::Res(r) => href_for(&r.segs, r.kind == ResKind::Dir),
        Target::Missing => return Err(DavError::not_found()),
    };
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>",
        esc(&href)
    );
    Ok((
        StatusCode::MULTI_STATUS,
        [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
        body,
    )
        .into_response())
}

// ── 读取 ────────────────────────────────────────────────────────────────────

async fn read_file(
    state: &AppState,
    user: &DavUser,
    segs: &[String],
    headers: &HeaderMap,
    head_only: bool,
) -> DResult<Response> {
    let target = resolve_target(state, user, segs).await?;
    let res = match target {
        Target::Res(r) if r.kind == ResKind::File => r,
        Target::Missing => return Err(DavError::not_found()),
        Target::Res(_) => {
            return Err(DavError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "目录不支持 GET，请使用 PROPFIND",
            ));
        }
        _ => {
            return Err(DavError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "该路径不支持 GET",
            ));
        }
    };
    let perms = perms_of(state, user, &res).await?;
    if !perms.contains(Perm::DOWNLOAD) {
        return Err(DavError::forbidden());
    }
    let file = Files::get_meta(state.db.pool(), res.id).await?;
    deliver(state, &file, headers, head_only).await
}

async fn deliver(
    state: &AppState,
    file: &FileMeta,
    headers: &HeaderMap,
    head_only: bool,
) -> DResult<Response> {
    let pool = state.db.pool();
    let (sha, _encoding) = Files::current_ref(pool, file.id).await?;
    let mut obj = state
        .objects
        .open(&sha)
        .await
        .map_err(|_| DavError::new(StatusCode::NOT_FOUND, "文件对象不存在（存储损坏）"))?;
    let len = obj
        .metadata()
        .await
        .map_err(|e| DavError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .len();
    let etag = file_etag(file);
    let mtime = http_date(file.updated_at);
    let range = parse_range(headers, len);

    let (status, start, end) = match range {
        Some((a, b)) => (StatusCode::PARTIAL_CONTENT, a, b),
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
    };
    if len == 0 {
        return Ok((
            status,
            [
                (header::CONTENT_TYPE, file.mime.clone()),
                (header::CONTENT_LENGTH, "0".into()),
                (header::ETAG, etag),
                (header::LAST_MODIFIED, mtime),
                (header::ACCEPT_RANGES, "bytes".into()),
            ],
        )
            .into_response());
    }
    obj.seek(SeekFrom::Start(start))
        .await
        .map_err(|e| DavError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let take = obj.take(end - start + 1);
    let body = if head_only {
        Body::empty()
    } else {
        Body::from_stream(read_stream(take))
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, &file.mime)
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string())
        .header(header::ETAG, etag)
        .header(header::LAST_MODIFIED, mtime)
        .header(header::ACCEPT_RANGES, "bytes");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end, len),
        );
    }
    builder
        .body(body)
        .map_err(|e| DavError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

fn parse_range(headers: &HeaderMap, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let raw = headers.get(header::RANGE)?.to_str().ok()?.trim();
    let spec = raw.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        let start = len.saturating_sub(n);
        return Some((start, len - 1));
    }
    let start: u64 = a.parse().ok()?;
    let end = if b.is_empty() {
        len - 1
    } else {
        b.parse::<u64>().ok()?.min(len - 1)
    };
    if start > end || start >= len {
        return None;
    }
    Some((start, end))
}

fn read_stream<R>(r: R) -> impl Stream<Item = Result<Bytes, io::Error>> + Send + 'static
where
    R: AsyncRead + Unpin + Send + 'static,
{
    futures_util::stream::unfold(r, |mut r| async move {
        let mut buf = vec![0u8; 256 * 1024];
        match r.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), r))
            }
            Err(e) => Some((Err(e), r)),
        }
    })
}

// ── 上传请求体 → AsyncRead ─────────────────────────────────────────────────

struct BodyRead {
    stream: Pin<Box<dyn Stream<Item = Result<Bytes, axum::Error>> + Send>>,
    buf: BytesMut,
}

impl BodyRead {
    fn new(stream: impl Stream<Item = Result<Bytes, axum::Error>> + Send + 'static) -> Self {
        Self {
            stream: Box::pin(stream),
            buf: BytesMut::new(),
        }
    }
}

impl AsyncRead for BodyRead {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            if self.buf.is_empty() {
                match self.stream.as_mut().poll_next(cx) {
                    Poll::Ready(Some(Ok(chunk))) => {
                        self.buf.extend_from_slice(&chunk);
                        continue;
                    }
                    Poll::Ready(Some(Err(e))) => {
                        return Poll::Ready(Err(io::Error::other(format!("请求体读取中断：{e}"))));
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

// ── 写入：PUT / MKCOL / DELETE ─────────────────────────────────────────────

async fn put(
    state: &AppState,
    user: &DavUser,
    segs: &[String],
    headers: &HeaderMap,
    body: Body,
) -> DResult<Response> {
    if segs.len() < 2 {
        return Err(DavError::new(
            StatusCode::FORBIDDEN,
            "不能在根级目录直接上传文件",
        ));
    }
    let name = segs.last().cloned().unwrap_or_default();
    if !valid_name(&name) {
        return Err(DavError::new(StatusCode::BAD_REQUEST, "文件名非法"));
    }
    let href = href_for(segs, false);
    check_lock(&href, headers)?;
    let existing = resolve_target(state, user, segs).await?;
    let (existing_file, replacing) = match existing {
        Target::Res(r) if r.kind == ResKind::File => {
            let perms = perms_of(state, user, &r).await?;
            if !perms.contains(Perm::MODIFY_RENAME) {
                return Err(DavError::forbidden());
            }
            let f = Files::get_meta(state.db.pool(), r.id).await?;
            let size = f.size;
            (Some(f), size)
        }
        Target::Res(_) => {
            return Err(DavError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "目标已存在且是目录",
            ));
        }
        Target::Missing | Target::Root | Target::ScopeRoot(_) => (None, 0),
    };
    let (parent_id, parent_perms) = resolve_parent(state, user, &segs[..segs.len() - 1]).await?;
    if let Some(f) = &existing_file {
        check_preconditions(headers, Some(&file_etag(f)))?;
    } else {
        check_preconditions(headers, None)?;
        if !parent_perms.contains(Perm::CREATE_UPLOAD) {
            return Err(DavError::forbidden());
        }
    }
    let cap = quota_cap(state, user.id, replacing).await?;
    let limit = cap.unwrap_or(state.cfg.max_upload_bytes);
    let reader = BodyRead::new(body.into_data_stream());
    let obj = match state.objects.ingest(reader, limit).await {
        Ok(o) => o,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("超过上限") {
                return Err(if cap.is_some() {
                    DavError::new(StatusCode::INSUFFICIENT_STORAGE, "存储配额已用尽")
                } else {
                    DavError::new(StatusCode::PAYLOAD_TOO_LARGE, "文件超过单次上传上限")
                });
            }
            return Err(DavError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("文件写入失败：{msg}"),
            ));
        }
    };
    let existed = existing_file.is_some();
    let meta = if let Some(f) = existing_file {
        Files::save_version(
            state.db.pool(),
            f.id,
            f.current_version,
            &obj,
            Some("WebDAV 覆盖保存"),
            "office",
            user.id,
            None,
        )
        .await?
    } else {
        let m = Files::create(
            state.db.pool(),
            parent_id,
            &name,
            &crate::files::guess_mime(&name),
            &obj,
            user.id,
        )
        .await?;
        Audit::log(
            state.db.pool(),
            Some(user.id),
            "file",
            "upload",
            Some("file"),
            Some(&m.id.to_string()),
            serde_json::json!({ "name": name, "size": obj.size, "via": "webdav" }),
            None,
        )
        .await?;
        m
    };
    let etag = file_etag(&meta);
    let status = if existed {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::CREATED
    };
    Ok((status, [(header::ETAG, etag)]).into_response())
}

async fn mkcol(state: &AppState, user: &DavUser, segs: &[String]) -> DResult<Response> {
    if segs.len() < 2 {
        return Err(DavError::new(
            StatusCode::FORBIDDEN,
            "不能在根级目录直接新建目录",
        ));
    }
    let name = segs.last().cloned().unwrap_or_default();
    if !valid_name(&name) {
        return Err(DavError::new(StatusCode::BAD_REQUEST, "目录名非法"));
    }
    match resolve_target(state, user, segs).await {
        Ok(Target::Res(_)) => {
            return Err(DavError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "同名资源已存在",
            ));
        }
        Ok(Target::Missing) => {}
        Ok(_) => return Err(DavError::new(StatusCode::FORBIDDEN, "该路径不能新建目录")),
        Err(e) => return Err(e),
    }
    let (parent_id, perms) = resolve_parent(state, user, &segs[..segs.len() - 1]).await?;
    if !perms.contains(Perm::CREATE_UPLOAD) {
        return Err(DavError::forbidden());
    }
    Directories::create(state.db.pool(), parent_id, &name, user.id).await?;
    Ok(StatusCode::CREATED.into_response())
}

async fn delete(
    state: &AppState,
    user: &DavUser,
    segs: &[String],
    headers: &HeaderMap,
) -> DResult<Response> {
    let target = resolve_target(state, user, segs).await?;
    let res = match target {
        Target::Res(r) => r,
        Target::Missing => return Err(DavError::not_found()),
        _ => {
            return Err(DavError::new(StatusCode::FORBIDDEN, "顶级目录不能删除"));
        }
    };
    check_lock(&href_for(&res.segs, res.kind == ResKind::Dir), headers)?;
    let perms = perms_of(state, user, &res).await?;
    if !perms.contains(Perm::DELETE_RESTORE) {
        return Err(DavError::forbidden());
    }
    match res.kind {
        ResKind::File => Files::trash(state.db.pool(), res.id, user.id, None).await?,
        ResKind::Dir => Directories::trash(state.db.pool(), res.id, user.id, None).await?,
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ── MOVE / COPY ─────────────────────────────────────────────────────────────

async fn move_or_copy(
    state: &AppState,
    user: &DavUser,
    segs: &[String],
    headers: &HeaderMap,
    is_move: bool,
) -> DResult<Response> {
    let src_target = resolve_target(state, user, segs).await?;
    let src = match src_target {
        Target::Res(r) => r,
        Target::Missing => return Err(DavError::not_found()),
        _ => {
            return Err(DavError::new(
                StatusCode::FORBIDDEN,
                "顶级目录不能移动/复制",
            ));
        }
    };
    let dest_raw = headers
        .get("destination")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| DavError::new(StatusCode::BAD_REQUEST, "缺少 Destination 头"))?;
    let dest_segs = destination_segments(dest_raw)?;
    if dest_segs.is_empty() || dest_segs.len() < 2 {
        return Err(DavError::new(StatusCode::FORBIDDEN, "目标路径非法"));
    }
    if dest_segs == src.segs {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let dest_name = dest_segs.last().cloned().unwrap_or_default();
    if !valid_name(&dest_name) {
        return Err(DavError::new(StatusCode::BAD_REQUEST, "目标名称非法"));
    }
    if is_move
        && src.kind == ResKind::Dir
        && dest_segs.len() > src.segs.len()
        && dest_segs[..src.segs.len()] == src.segs[..]
    {
        return Err(DavError::new(
            StatusCode::CONFLICT,
            "不能把目录移动到自身或子目录",
        ));
    }
    let (dest_parent_id, dest_parent_perms) =
        resolve_parent(state, user, &dest_segs[..dest_segs.len() - 1]).await?;
    if !dest_parent_perms.contains(Perm::CREATE_UPLOAD) && dest_parent_id != ROOT {
        return Err(DavError::forbidden());
    }
    let src_perms = perms_of(state, user, &src).await?;
    if !src_perms.contains(Perm::MOVE_COPY) {
        return Err(DavError::forbidden());
    }
    let overwrite = headers
        .get("overwrite")
        .and_then(|v| v.to_str().ok())
        .map(|v| !v.eq_ignore_ascii_case("F"))
        .unwrap_or(true);
    let dest_existing = resolve_target(state, user, &dest_segs)
        .await
        .ok()
        .and_then(|t| match t {
            Target::Res(r) => Some(r),
            _ => None,
        });
    if dest_existing.is_some() && !overwrite {
        return Err(DavError::new(
            StatusCode::PRECONDITION_FAILED,
            "目标已存在且 Overwrite: F",
        ));
    }
    if let Some(ref d) = dest_existing {
        check_lock(&href_for(&d.segs, d.kind == ResKind::Dir), headers)?;
        let dp = perms_of(state, user, d).await?;
        if !dp.contains(Perm::DELETE_RESTORE) {
            return Err(DavError::forbidden());
        }
        match d.kind {
            ResKind::File => Files::trash(state.db.pool(), d.id, user.id, None).await?,
            ResKind::Dir => Directories::trash(state.db.pool(), d.id, user.id, None).await?,
        }
    }
    check_lock(&href_for(&src.segs, src.kind == ResKind::Dir), headers)?;

    if is_move {
        match src.kind {
            ResKind::File => {
                let same_parent = segs.len() >= 2
                    && dest_segs.len() == segs.len()
                    && segs[..segs.len() - 1] == dest_segs[..dest_segs.len() - 1];
                if same_parent {
                    Files::rename(state.db.pool(), src.id, &dest_name, user.id, None).await?;
                } else {
                    Files::move_to(
                        state.db.pool(),
                        src.id,
                        dest_parent_id,
                        Some(&dest_name),
                        user.id,
                        None,
                    )
                    .await?;
                }
            }
            ResKind::Dir => {
                if segs[..segs.len() - 1] == dest_segs[..dest_segs.len() - 1] {
                    Directories::rename(state.db.pool(), src.id, &dest_name, user.id, None).await?;
                } else {
                    Directories::move_to(state.db.pool(), src.id, dest_parent_id, user.id, None)
                        .await?;
                    if src.segs.last() != Some(&dest_name) {
                        Directories::rename(state.db.pool(), src.id, &dest_name, user.id, None)
                            .await?;
                    }
                }
            }
        }
    } else {
        match src.kind {
            ResKind::File => {
                let f = Files::get_meta(state.db.pool(), src.id).await?;
                ensure_quota(state, user.id, f.size).await?;
                Files::copy_to(
                    state.db.pool(),
                    src.id,
                    dest_parent_id,
                    &dest_name,
                    user.id,
                    None,
                )
                .await?;
            }
            ResKind::Dir => {
                copy_dir_recursive(state, user, &src, dest_parent_id, &dest_name, 0).await?;
            }
        }
    }
    let status = if dest_existing.is_some() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::CREATED
    };
    Ok(status.into_response())
}

async fn copy_dir_recursive(
    state: &AppState,
    user: &DavUser,
    src: &DavRes,
    dest_parent: Uuid,
    dest_name: &str,
    depth: u32,
) -> DResult<()> {
    if depth > 32 {
        return Err(DavError::new(StatusCode::FORBIDDEN, "目录层级过深"));
    }
    let (_d, children) = Directories::list_children(state.db.pool(), src.id).await?;
    let new_dir = Directories::create(state.db.pool(), dest_parent, dest_name, user.id).await?;
    for e in children {
        match e {
            EntryKind::Directory { directory } => {
                let sub = DavRes {
                    kind: ResKind::Dir,
                    id: directory.id,
                    scope: src.scope,
                    segs: {
                        let mut s = src.segs.clone();
                        s.push(directory.name.clone());
                        s
                    },
                };
                Box::pin(copy_dir_recursive(
                    state,
                    user,
                    &sub,
                    new_dir.id,
                    &directory.name,
                    depth + 1,
                ))
                .await?;
            }
            EntryKind::File(f) => {
                let perms =
                    Grants::resolve_for_file(state.db.pool(), user.id, f.file.id, user.is_admin)
                        .await?;
                if !perms.contains(Perm::MOVE_COPY) {
                    return Err(DavError::forbidden());
                }
                ensure_quota(state, user.id, f.file.size).await?;
                Files::copy_to(
                    state.db.pool(),
                    f.file.id,
                    new_dir.id,
                    &f.file.name,
                    user.id,
                    None,
                )
                .await?;
            }
        }
    }
    Ok(())
}

fn destination_segments(raw: &str) -> DResult<Vec<String>> {
    let mut s = raw.trim();
    if let Some(idx) = s.find("://") {
        let rest = &s[idx + 3..];
        match rest.find('/') {
            Some(p) => s = &rest[p..],
            None => return Err(DavError::new(StatusCode::BAD_REQUEST, "Destination 非法")),
        }
    }
    if let Some(q) = s.find('?') {
        s = &s[..q];
    }
    let path = s.strip_prefix(DAV_PREFIX).unwrap_or(s);
    if !s.starts_with(DAV_PREFIX) {
        return Err(DavError::new(
            StatusCode::BAD_REQUEST,
            "Destination 必须位于 /dav 下",
        ));
    }
    decode_segments(path)
}

// ── 锁 ──────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct DavLock {
    token: String,
    owner: String,
    expires: Instant,
    timeout_secs: u64,
}

static LOCKS: OnceLock<Mutex<HashMap<String, DavLock>>> = OnceLock::new();

fn locks() -> &'static Mutex<HashMap<String, DavLock>> {
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_get(href: &str) -> Option<DavLock> {
    let mut map = locks().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = map.get(href) {
        if l.expires > Instant::now() {
            return Some(l.clone());
        }
        map.remove(href);
    }
    None
}

fn check_lock(href: &str, headers: &HeaderMap) -> DResult<()> {
    let Some(l) = lock_get(href) else {
        return Ok(());
    };
    let supplied = headers
        .get("if")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .contains(&l.token);
    if supplied {
        Ok(())
    } else {
        Err(DavError::new(
            StatusCode::LOCKED,
            "资源已被锁定，请携带 If 锁令牌",
        ))
    }
}

fn parse_timeout(headers: &HeaderMap) -> u64 {
    headers
        .get("timeout")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| {
            raw.split(',')
                .map(str::trim)
                .find_map(|part| part.strip_prefix("Second-"))
                .and_then(|n| n.parse::<u64>().ok())
        })
        .map(|n| n.clamp(60, MAX_LOCK_SECS))
        .unwrap_or(3600)
}

async fn lock(
    state: &AppState,
    user: &DavUser,
    segs: &[String],
    headers: &HeaderMap,
) -> DResult<Response> {
    // Windows WebDAV 重定向器会对尚不存在的目标先发 LOCK（lock-null），
    // 再 PUT；这里允许在可写父目录下对不存在路径加锁。
    let href = match resolve_target(state, user, segs).await {
        Ok(Target::Res(r)) => {
            let perms = perms_of(state, user, &r).await?;
            if !perms.contains(Perm::MODIFY_RENAME) {
                return Err(DavError::forbidden());
            }
            href_for(&r.segs, r.kind == ResKind::Dir)
        }
        Ok(Target::Missing) => {
            if segs.len() < 2 {
                return Err(DavError::not_found());
            }
            let name = segs.last().cloned().unwrap_or_default();
            if !valid_name(&name) {
                return Err(DavError::new(StatusCode::BAD_REQUEST, "文件名非法"));
            }
            let (_parent, perms) = resolve_parent(state, user, &segs[..segs.len() - 1]).await?;
            if !perms.contains(Perm::CREATE_UPLOAD) {
                return Err(DavError::forbidden());
            }
            href_for(segs, false)
        }
        Ok(_) => {
            return Err(DavError::new(StatusCode::FORBIDDEN, "顶级目录不能锁定"));
        }
        Err(e) if e.status == StatusCode::NOT_FOUND => {
            if segs.len() < 2 {
                return Err(e);
            }
            let name = segs.last().cloned().unwrap_or_default();
            if !valid_name(&name) {
                return Err(DavError::new(StatusCode::BAD_REQUEST, "文件名非法"));
            }
            let (_parent, perms) = resolve_parent(state, user, &segs[..segs.len() - 1]).await?;
            if !perms.contains(Perm::CREATE_UPLOAD) {
                return Err(DavError::forbidden());
            }
            href_for(segs, false)
        }
        Err(e) => return Err(e),
    };
    let timeout_secs = parse_timeout(headers);
    if let Some(existing) = lock_get(&href) {
        let supplied = headers
            .get("if")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .contains(&existing.token);
        if supplied {
            let l = DavLock {
                expires: Instant::now() + Duration::from_secs(timeout_secs),
                timeout_secs,
                ..existing
            };
            locks()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(href.clone(), l.clone());
            return Ok(lock_response(&l, &href));
        }
        return Err(DavError::new(
            StatusCode::LOCKED,
            "资源已被锁定，无法重复加锁",
        ));
    }
    let token = format!("urn:uuid:{}", Uuid::now_v7());
    let l = DavLock {
        token: token.clone(),
        owner: user.display_name.clone(),
        expires: Instant::now() + Duration::from_secs(timeout_secs),
        timeout_secs,
    };
    locks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(href.clone(), l.clone());
    Ok(lock_response(&l, &href))
}

fn lock_response(l: &DavLock, href: &str) -> Response {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:prop xmlns:d=\"DAV:\"><d:lockdiscovery><d:activelock>\
<d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope>\
<d:depth>infinity</d:depth><d:owner>{}</d:owner><d:timeout>Second-{}</d:timeout>\
<d:locktoken><d:href>{}</d:href></d:locktoken><d:lockroot><d:href>{}</d:href></d:lockroot>\
</d:activelock></d:lockdiscovery></d:prop>",
        esc(&l.owner),
        l.timeout_secs,
        esc(&l.token),
        esc(href)
    );
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "application/xml; charset=utf-8".to_string(),
            ),
            (
                HeaderName::from_static("lock-token"),
                format!("<{}>", l.token),
            ),
        ],
        body,
    )
        .into_response()
}

async fn unlock(
    state: &AppState,
    user: &DavUser,
    segs: &[String],
    headers: &HeaderMap,
) -> DResult<Response> {
    let href = match resolve_target(state, user, segs).await {
        Ok(Target::Res(r)) => href_for(&r.segs, r.kind == ResKind::Dir),
        Ok(Target::Missing) => href_for(segs, false),
        Ok(_) => {
            return Err(DavError::new(StatusCode::FORBIDDEN, "顶级目录不能解锁"));
        }
        // lock-null：文件可能在加锁后尚未创建，按路径解开。
        Err(e) if e.status == StatusCode::NOT_FOUND => href_for(segs, false),
        Err(e) => return Err(e),
    };
    let raw = headers
        .get("lock-token")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| DavError::new(StatusCode::BAD_REQUEST, "缺少 Lock-Token 头"))?;
    let token = raw.trim().trim_start_matches('<').trim_end_matches('>');
    let mut map = locks().lock().unwrap_or_else(|e| e.into_inner());
    let Some(l) = map.get(&href).cloned() else {
        return Err(DavError::new(StatusCode::CONFLICT, "资源未被锁定"));
    };
    if l.token != token {
        return Err(DavError::new(
            StatusCode::PRECONDITION_FAILED,
            "锁令牌不匹配",
        ));
    }
    map.remove(&href);
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ── 条件请求 / 配额 ─────────────────────────────────────────────────────────

fn check_preconditions(headers: &HeaderMap, existing_etag: Option<&str>) -> DResult<()> {
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    if if_none_match == Some("*") && existing_etag.is_some() {
        return Err(DavError::new(
            StatusCode::PRECONDITION_FAILED,
            "目标已存在（If-None-Match: *）",
        ));
    }
    let if_match = headers
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    if let Some(tag) = if_match
        && tag != "*"
    {
        match existing_etag {
            Some(e) if e == tag || tag.contains(e) => {}
            _ => {
                return Err(DavError::new(
                    StatusCode::PRECONDITION_FAILED,
                    "ETag 不匹配",
                ));
            }
        }
    }
    Ok(())
}

async fn quota_cap(state: &AppState, owner: Uuid, replacing: u64) -> DResult<Option<u64>> {
    let pool = state.db.pool();
    let user = Users::get_by_id(pool, owner).await?;
    let Some(quota) = user.quota_bytes else {
        return Ok(None);
    };
    let used = Users::usage_bytes(pool, owner)
        .await?
        .saturating_sub(replacing as i64);
    if used >= quota {
        return Err(DavError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "存储配额已用尽",
        ));
    }
    Ok(Some(
        ((quota - used) as u64).min(state.cfg.max_upload_bytes),
    ))
}

async fn ensure_quota(state: &AppState, owner: Uuid, incoming: u64) -> DResult<()> {
    if let Some(remaining) = quota_cap(state, owner, 0).await?
        && incoming > remaining
    {
        return Err(DavError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "存储配额不足",
        ));
    }
    Ok(())
}
