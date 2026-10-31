//! 用户设置 API：GET/PUT /api/v1/settings/desktop。
//!
//! 桌面设置以整对象存取（借鉴 VentoOS 模式）：PUT 全量对象，
//! 服务端与默认值合并后落库，避免旧客户端漏字段时抹掉新字段。

use axum::Json;
use axum::extract::{Extension, State};
use serde::Serialize;
use serde_json::{json, Value};
use vk_store::repo::settings::{SystemSettings, UserSettings};

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::ApiError;

const DESKTOP_KEY: &str = "desktop";

/// 桌面设置默认值（用户从未保存时返回；字段与前端 useSettings store 对齐）。
pub fn desktop_defaults() -> Value {
    json!({
        "theme_mode": "light",
        "wallpaper": "",
        "accent_color": null
    })
}

/// 用用户保存的对象覆盖默认值（只合并顶层字段）。
fn merge_defaults(defaults: Value, saved: &Value) -> Value {
    match saved.as_object() {
        Some(obj) => {
            let mut merged = defaults;
            if let Some(m) = merged.as_object_mut() {
                for (k, v) in obj {
                    m.insert(k.clone(), v.clone());
                }
            }
            merged
        }
        None => defaults,
    }
}

pub async fn get_desktop(
    State(state): State<AppState>,
    user: Extension<AuthUser>,
) -> Result<Json<Value>, ApiError> {
    let saved = UserSettings::get(state.db.pool(), user.id, DESKTOP_KEY).await;
    let value = match saved {
        Some(v) => merge_defaults(desktop_defaults(), &v),
        None => desktop_defaults(),
    };
    Ok(Json(value))
}

pub async fn put_desktop(
    State(state): State<AppState>,
    user: Extension<AuthUser>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !body.is_object() {
        return Err(ApiError::bad_request("设置必须是 JSON 对象"));
    }
    let merged = merge_defaults(desktop_defaults(), &body);
    UserSettings::put(state.db.pool(), user.id, DESKTOP_KEY, &merged).await?;
    Ok(Json(merged))
}

// ---------------------------------------------------------------------------
// M2.24：分享链接系统设置（分享端口 / 外网域名开关）
//
// key='share' 存 `{"port": 8090, "external_enabled": false, "external_domain": ""}`。
// - port：分享端口，启动时由 main.rs 读取并绑定第二监听；改动需重启服务生效。
// - external_enabled + external_domain：启用后分享链接额外生成外网地址
//   `https://{external_domain}/s/{token}`；关闭时仅内网链接
//   `http://{访问主机}:{port}/s/{token}`。
// ---------------------------------------------------------------------------

pub const SHARE_KEY: &str = "share";
pub const DEFAULT_SHARE_PORT: u16 = 8090;

#[derive(Serialize)]
pub struct ShareSettingsView {
    pub port: u16,
    pub external_enabled: bool,
    pub external_domain: String,
    /// M2.24：本进程启动时实际绑定的分享端口（设置页改端口需重启后生效，
    /// 该字段保证前端展示/生成的链接端口始终是真实可用的端口）。
    pub active_port: u16,
}

#[derive(serde::Deserialize, Default)]
pub struct ShareSettingsReq {
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub external_enabled: Option<bool>,
    #[serde(default)]
    pub external_domain: Option<String>,
}

fn share_view(saved: Option<&Value>) -> ShareSettingsView {
    ShareSettingsView {
        port: saved
            .and_then(|v| v.get("port"))
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(DEFAULT_SHARE_PORT),
        external_enabled: saved
            .and_then(|v| v.get("external_enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        external_domain: saved
            .and_then(|v| v.get("external_domain"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // 占位；由各 handler 用 state.share_port（实际绑定端口）覆盖
        active_port: 0,
    }
}

/// 读取分享设置（任何登录用户可读：分享弹窗需据此展示内网/外网选项）。
pub async fn get_share_settings(
    State(state): State<AppState>,
    _user: Extension<AuthUser>,
) -> Result<Json<ShareSettingsView>, ApiError> {
    let saved = SystemSettings::get(state.db.pool(), SHARE_KEY).await;
    let mut view = share_view(saved.as_ref());
    view.active_port = state.share_port;
    Ok(Json(view))
}

/// 更新分享设置（仅管理员）。
pub async fn put_share_settings(
    State(state): State<AppState>,
    user: Extension<AuthUser>,
    Json(body): Json<ShareSettingsReq>,
) -> Result<Json<ShareSettingsView>, ApiError> {
    if !user.is_admin {
        return Err(ApiError::forbidden("仅管理员可修改分享设置"));
    }
    let current = share_view(SystemSettings::get(state.db.pool(), SHARE_KEY).await.as_ref());
    let port = body.port.unwrap_or(current.port);
    if port == 0 {
        return Err(ApiError::bad_request("分享端口需在 1–65535 之间"));
    }
    let external_enabled = body.external_enabled.unwrap_or(current.external_enabled);
    let external_domain = body
        .external_domain
        .unwrap_or_else(|| current.external_domain.clone())
        .trim()
        .trim_end_matches('/')
        .to_string();
    if external_enabled && external_domain.is_empty() {
        return Err(ApiError::bad_request("启用外网域名时，外网域名不能为空"));
    }
    let value = json!({
        "port": port,
        "external_enabled": external_enabled,
        "external_domain": external_domain,
    });
    SystemSettings::put(state.db.pool(), SHARE_KEY, &value).await?;
    Ok(Json(ShareSettingsView {
        port,
        external_enabled,
        external_domain,
        active_port: state.share_port,
    }))
}

// ---------------------------------------------------------------------------
// M2.27：发布域名只读展示（不再在管理页面填写）
//
// 发布域名唯一来源 = 服务器环境变量 VIENTO_PUBLISH_DOMAIN（.env），
// 修改后需重启服务生效。此处仅提供只读查询供设置页展示 + 泛解析提示。
// 发布后站点地址 = https://{publish_id}.{domain}/（泛子域名）；
// 发布前需在 DNS 配置泛解析 *.domain → 服务器 IP，否则站点无法解析访问。
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PublishSettingsView {
    /// 当前生效的发布域名（来自环境变量；空串 = 未配置）
    pub domain: String,
    /// 当前实际生效的域名（环境变量非空；null = 未配置，发布功能不可用）
    pub effective_domain: Option<String>,
    /// 环境变量 VIENTO_PUBLISH_DOMAIN 当前值（null = 未设置）
    pub env_domain: Option<String>,
}

/// 只读查询发布域名（仅管理员：设置页仅管理员可进入）。
pub async fn get_publish_settings(
    State(state): State<AppState>,
    user: Extension<AuthUser>,
) -> Result<Json<PublishSettingsView>, ApiError> {
    if !user.is_admin {
        return Err(ApiError::forbidden("仅管理员可查看发布设置"));
    }
    let effective_domain = crate::publishes::effective_publish_domain(&state);
    Ok(Json(PublishSettingsView {
        domain: effective_domain.clone().unwrap_or_default(),
        effective_domain,
        env_domain: state.cfg.publish_domain.clone(),
    }))
}
