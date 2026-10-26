//! 通知中心（M4）：最近活动查询，复用 audit_logs 表（不新增存储）。
//! 管理员看全部；普通用户只看 actor_id = 本人 的条目（"与我相关"）。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use vk_store::repo::audit::{Audit, AuditEntry};

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::AppState;

#[derive(Debug, Deserialize, Default)]
pub struct NotificationQuery {
    #[serde(default)]
    pub limit: Option<u32>,
}

/// 最近活动列表（任何已登录用户），ts 倒序。
pub async fn list(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Query(q): Query<NotificationQuery>,
) -> Result<Json<Vec<AuditEntry>>, ApiError> {
    let pool = state.db.pool();
    let actor_id = if user.is_admin { None } else { Some(user.id) };
    let rows = Audit::list(pool, None, None, actor_id, q.limit.unwrap_or(30).min(100) as i64, 0)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(rows))
}
