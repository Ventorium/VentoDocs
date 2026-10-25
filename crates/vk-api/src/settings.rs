//! 用户设置 API：GET/PUT /api/v1/settings/desktop。
//!
//! 桌面设置以整对象存取（借鉴 VentoOS 模式）：PUT 全量对象，
//! 服务端与默认值合并后落库，避免旧客户端漏字段时抹掉新字段。

use axum::Json;
use axum::extract::{Extension, State};
use serde_json::{json, Value};
use vk_store::repo::settings::UserSettings;

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
