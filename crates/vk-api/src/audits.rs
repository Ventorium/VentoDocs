//! 审计日志查询（仅管理员）。

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use uuid::Uuid;
use vk_store::repo::audit::{Audit, AuditEntry};

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::users::require_admin;

#[derive(Debug, Deserialize, Default)]
pub struct AuditListQuery {
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub actor_id: Option<Uuid>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

/// 审计日志列表（管理员），ts/id 倒序分页。
pub async fn list(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Query(q): Query<AuditListQuery>,
) -> Result<Json<Vec<AuditEntry>>, ApiError> {
    require_admin(&user)?;
    let pool = state.db.pool();
    let rows = Audit::list(
        pool,
        q.category.as_deref(),
        q.action.as_deref(),
        q.actor_id,
        q.limit.unwrap_or(100).min(500) as i64,
        q.offset.unwrap_or(0) as i64,
    )
    .await
    .map_err(ApiError::from)?;
    Ok(Json(rows))
}
