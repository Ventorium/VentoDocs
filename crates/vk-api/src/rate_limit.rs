//! 敏感端点限流（进程内固定窗口计数器，防口令暴力破解）。
//!
//! 适用：登录 / 首次初始化 / 分享密码校验 / 发布站点密码校验 / 站点密码门。
//! 策略：**只统计失败**（401/403/400）——正常用户即使输错一两次也不会被锁；
//! 同一 IP 在同一端点 5 分钟内失败超过 [`MAX_FAILURES`] 次则返回 429 + `Retry-After`，
//! 成功一次即清零（避免把「偶尔手滑」累积成封锁）。
//!
//! 说明：多实例部署时该限制为单进程粒度（本项目单进程部署，够用）；
//! 若日后水平扩展，应换成 Redis（`.env.example` 已有 `VIENTO_REDIS_URL` 预留）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

/// 一个窗口内允许的失败次数上限。
const MAX_FAILURES: u32 = 10;
/// 计数窗口长度。
const WINDOW: Duration = Duration::from_secs(300);
/// 表内条目上限；超过时清理过期窗口，防止被随机 token 撑爆内存。
const MAX_ENTRIES: usize = 4096;

#[derive(Debug)]
struct Entry {
    window_start: Instant,
    failures: u32,
}

static TABLE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

fn table() -> &'static Mutex<HashMap<String, Entry>> {
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 清理过期窗口（惰性，仅在表过大时触发）。
fn sweep(map: &mut HashMap<String, Entry>, now: Instant) {
    map.retain(|_, e| now.duration_since(e.window_start) < WINDOW);
}

/// 是否已被限流；不产生副作用。
fn blocked(key: &str) -> Option<u64> {
    let mut map = table().lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let e = map.get(key)?;
    let elapsed = now.duration_since(e.window_start);
    if elapsed >= WINDOW {
        map.remove(key);
        return None;
    }
    if e.failures >= MAX_FAILURES {
        return Some((WINDOW - elapsed).as_secs().max(1));
    }
    None
}

/// 记一次失败；返回该窗口累计失败次数。
fn note_failure(key: &str) -> u32 {
    let mut map = table().lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    if map.len() > MAX_ENTRIES {
        sweep(&mut map, now);
    }
    let entry = map.entry(key.to_string()).or_insert(Entry {
        window_start: now,
        failures: 0,
    });
    if now.duration_since(entry.window_start) >= WINDOW {
        entry.window_start = now;
        entry.failures = 0;
    }
    entry.failures = entry.failures.saturating_add(1);
    entry.failures
}

/// 成功一次 → 清零（同一端点同一 IP）。
fn note_success(key: &str) {
    let mut map = table().lock().unwrap_or_else(|e| e.into_inner());
    map.remove(key);
}

/// 客户端标识：优先请求上下文里的真实 IP（`attach_client_ip` 写入），缺省 "unknown"。
fn client_key(name: &str) -> String {
    let ip = vk_store::repo::audit::client_ip().unwrap_or_else(|| "unknown".to_string());
    format!("{name}:{ip}")
}

fn rate_limited(retry_after: u64) -> Response {
    let body = serde_json::json!({
        "error": {
            "code": "RATE_LIMITED",
            "message": "尝试过于频繁，请稍后再试",
            "details": { "retry_after_seconds": retry_after },
        }
    })
    .to_string();
    (
        StatusCode::TOO_MANY_REQUESTS,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::RETRY_AFTER, "60"),
        ],
        body,
    )
        .into_response()
}

/// 通用守卫：失败计数 + 429 拦截 + 成功清零。
async fn guard(name: &'static str, req: Request, next: Next) -> Response {
    let key = client_key(name);
    if let Some(retry) = blocked(&key) {
        return rate_limited(retry);
    }
    let resp = next.run(req).await;
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED
        || status == StatusCode::FORBIDDEN
        || status == StatusCode::BAD_REQUEST
    {
        note_failure(&key);
    } else if status.is_success() {
        note_success(&key);
    }
    resp
}

/// 登录 / bootstrap 端点。
pub async fn login_guard(req: Request, next: Next) -> Response {
    guard("login", req, next).await
}

/// 分享密码校验与受密码保护的公开分享端点。
pub async fn share_guard(req: Request, next: Next) -> Response {
    guard("share", req, next).await
}

/// 发布站点密码校验端点。
pub async fn publish_guard(req: Request, next: Next) -> Response {
    guard("publish", req, next).await
}

/// 发布站点「密码门」表单 POST（Host 子域名路由里直接调用站点服务，不经过 axum 路由层）。
/// 返回 `Some(response)` = 已被限流，调用方直接返回；`None` = 放行，由调用方在拿到
/// 结果后调用 [`record_site_password_result`] 计数。
pub fn site_password_blocked() -> Option<Response> {
    blocked(&client_key("site")).map(rate_limited)
}

/// 记录站点密码门一次尝试结果（仅失败计数，成功清零）。
pub fn record_site_password_result(success: bool) {
    let key = client_key("site");
    if success {
        note_success(&key);
    } else {
        note_failure(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_counts_and_blocks() {
        let key = "test:window";
        note_success(key);
        assert!(blocked(key).is_none());
        // 前 MAX_FAILURES-1 次失败仍放行，累计到上限即封锁
        for _ in 0..MAX_FAILURES - 1 {
            note_failure(key);
            assert!(blocked(key).is_none());
        }
        note_failure(key);
        assert!(blocked(key).is_some());
        note_success(key);
        assert!(blocked(key).is_none());
    }
}
