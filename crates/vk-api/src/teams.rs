//! 团队管理 API：团队 CRUD + 成员增删（管理员）。

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vk_core::model::{Team, User};
use vk_store::repo::teams::Teams;

use crate::AppState;
use crate::error::ApiError;
use crate::users::require_admin;

#[derive(Serialize)]
pub struct TeamOut {
    pub id: Uuid,
    pub name: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub member_count: i64,
}

#[derive(Serialize)]
pub struct TeamDetailOut {
    pub team: Team,
    pub members: Vec<UserOut>,
}

#[derive(Serialize)]
pub struct UserOut {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub role: vk_core::model::Role,
    pub disabled: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

fn user_out(u: &User) -> UserOut {
    UserOut {
        id: u.id,
        username: u.username.clone(),
        display_name: u.display_name.clone(),
        role: u.role,
        disabled: u.disabled,
        created_at: u.created_at,
    }
}

#[derive(Deserialize)]
pub struct CreateTeamReq {
    pub name: String,
}

pub async fn list(
    State(state): State<AppState>,
    _user: axum::extract::Extension<crate::auth::AuthUser>,
) -> Result<Json<Vec<TeamOut>>, ApiError> {
    let pool = state.db.pool();
    let teams = Teams::list(pool).await?;
    let out: Vec<TeamOut> = teams
        .iter()
        .map(|t| TeamOut {
            id: t.id,
            name: t.name.clone(),
            created_at: t.created_at,
            member_count: 0,
        })
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct GetTeamQuery {
    #[serde(default)]
    pub with_members: bool,
}

pub async fn get(
    State(state): State<AppState>,
    _user: axum::extract::Extension<crate::auth::AuthUser>,
    Path(id): Path<Uuid>,
    Query(q): Query<GetTeamQuery>,
) -> Result<Json<TeamDetailOut>, ApiError> {
    let pool = state.db.pool();
    let team = Teams::get(pool, id).await?;
    let members = if q.with_members {
        Teams::members(pool, id).await?
    } else {
        vec![]
    };
    Ok(Json(TeamDetailOut {
        team,
        members: members.iter().map(user_out).collect(),
    }))
}

pub async fn create(
    State(state): State<AppState>,
    user: axum::extract::Extension<crate::auth::AuthUser>,
    Json(body): Json<CreateTeamReq>,
) -> Result<Json<Team>, ApiError> {
    require_admin(&user)?;
    if body.name.trim().is_empty() {
        return Err(ApiError::bad_request("团队名称不能为空"));
    }
    let team = Teams::create(state.db.pool(), body.name.trim()).await?;
    vk_store::repo::audit::Audit::log(
        state.db.pool(),
        Some(user.id),
        "admin",
        "team_create",
        Some("team"),
        Some(&team.id.to_string()),
        serde_json::json!({ "name": team.name }),
        None,
    )
    .await?;
    Ok(Json(team))
}

#[derive(Deserialize)]
pub struct UpdateTeamReq {
    pub name: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    user: axum::extract::Extension<crate::auth::AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateTeamReq>,
) -> Result<Json<Team>, ApiError> {
    require_admin(&user)?;
    let pool = state.db.pool();
    if let Some(name) = &body.name {
        if name.trim().is_empty() {
            return Err(ApiError::bad_request("团队名称不能为空"));
        }
        let team = Teams::rename(pool, id, name.trim()).await?;
        vk_store::repo::audit::Audit::log(
            pool,
            Some(user.id),
            "admin",
            "team_rename",
            Some("team"),
            Some(&id.to_string()),
            serde_json::json!({ "new_name": name }),
            None,
        )
        .await?;
        Ok(Json(team))
    } else {
        Err(ApiError::bad_request("缺少 name 字段"))
    }
}

#[derive(Deserialize)]
pub struct MemberReq {
    pub user_id: Uuid,
}

pub async fn add_member(
    State(state): State<AppState>,
    user: axum::extract::Extension<crate::auth::AuthUser>,
    Path(team_id): Path<Uuid>,
    Json(body): Json<MemberReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    let pool = state.db.pool();
    // 确认成员存在
    vk_store::repo::users::Users::get_by_id(pool, body.user_id).await?;
    Teams::add_member(pool, team_id, body.user_id).await?;
    vk_store::repo::audit::Audit::log(
        pool,
        Some(user.id),
        "admin",
        "team_add_member",
        Some("team"),
        Some(&team_id.to_string()),
        serde_json::json!({ "user_id": body.user_id }),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn remove_member(
    State(state): State<AppState>,
    user: axum::extract::Extension<crate::auth::AuthUser>,
    Path((team_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    let pool = state.db.pool();
    Teams::remove_member(pool, team_id, user_id).await?;
    vk_store::repo::audit::Audit::log(
        pool,
        Some(user.id),
        "admin",
        "team_remove_member",
        Some("team"),
        Some(&team_id.to_string()),
        serde_json::json!({ "user_id": user_id }),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
