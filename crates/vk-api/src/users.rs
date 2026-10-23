//! 用户管理（管理员）+ LDAP 单向导入。

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vk_core::model::{Role, User};
use vk_store::repo::audit::Audit;
use vk_store::repo::users::Users;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::ApiError;

/// 仅管理员可通过。
pub fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.is_admin {
        Ok(())
    } else {
        Err(ApiError::forbidden("需要管理员权限"))
    }
}

#[derive(Deserialize)]
pub struct CreateUserReq {
    pub username: String,
    pub display_name: Option<String>,
    pub password: String,
    #[serde(default)]
    pub role: Option<Role>,
}

#[derive(Serialize)]
pub struct UserOut {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub role: Role,
    pub disabled: bool,
    pub auth_provider: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

fn to_out(u: &User) -> UserOut {
    UserOut {
        id: u.id,
        username: u.username.clone(),
        display_name: u.display_name.clone(),
        role: u.role,
        disabled: u.disabled,
        auth_provider: match u.auth_provider {
            vk_core::model::AuthProvider::Local => "local".into(),
            vk_core::model::AuthProvider::Ldap => "ldap".into(),
        },
        created_at: u.created_at,
    }
}

pub async fn list(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<Vec<UserOut>>, ApiError> {
    require_admin(&user)?;
    let users = Users::list(state.db.pool()).await?;
    Ok(Json(users.iter().map(to_out).collect()))
}

pub async fn get(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<UserOut>, ApiError> {
    require_admin(&user)?;
    let u = Users::get_by_id(state.db.pool(), id).await?;
    Ok(Json(to_out(&u)))
}

pub async fn create(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Json(body): Json<CreateUserReq>,
) -> Result<Json<UserOut>, ApiError> {
    require_admin(&user)?;
    if body.username.trim().is_empty()
        || !body
            .username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
    {
        return Err(ApiError::bad_request(
            "用户名只能包含字母、数字、下划线、点",
        ));
    }
    if body.password.len() < 8 {
        return Err(ApiError::bad_request("密码至少 8 位"));
    }
    let role = body.role.unwrap_or(Role::User);
    let display = body.display_name.as_deref().unwrap_or(&body.username);
    let u = Users::create(
        state.db.pool(),
        &body.username,
        display,
        &body.password,
        role,
    )
    .await?;
    Audit::log(
        state.db.pool(),
        Some(user.id),
        "admin",
        "user_create",
        Some("user"),
        Some(&u.id.to_string()),
        serde_json::json!({ "role": role }),
        None,
    )
    .await?;
    Ok(Json(to_out(&u)))
}

#[derive(Deserialize)]
pub struct UpdateUserReq {
    pub display_name: Option<String>,
    pub role: Option<Role>,
    pub disabled: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateUserReq>,
) -> Result<Json<UserOut>, ApiError> {
    require_admin(&user)?;
    let pool = state.db.pool();
    if body.role.is_some() && id == user.id && body.role != Some(Role::Admin) {
        return Err(ApiError::bad_request("不能降低自己的管理员角色"));
    }
    if body.disabled == Some(true) && id == user.id {
        return Err(ApiError::bad_request("不能禁用自己"));
    }
    if let Some(name) = &body.display_name {
        Users::update_display_name(pool, id, name).await?;
    }
    if let Some(role) = body.role {
        Users::set_role(pool, id, role).await?;
    }
    if let Some(disabled) = body.disabled {
        Users::set_disabled(pool, id, disabled).await?;
    }
    let u = Users::get_by_id(pool, id).await?;
    Audit::log(
        pool,
        Some(user.id),
        "admin",
        "user_update",
        Some("user"),
        Some(&id.to_string()),
        serde_json::json!({ "display_name": body.display_name, "role": body.role, "disabled": body.disabled }),
        None,
    )
    .await?;
    Ok(Json(to_out(&u)))
}

#[derive(Deserialize)]
pub struct SetPasswordReq {
    pub password: String,
}

pub async fn set_password(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<SetPasswordReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    if body.password.len() < 8 {
        return Err(ApiError::bad_request("密码至少 8 位"));
    }
    Users::set_password(state.db.pool(), id, &body.password).await?;
    Audit::log(
        state.db.pool(),
        Some(user.id),
        "admin",
        "password_reset",
        Some("user"),
        Some(&id.to_string()),
        serde_json::json!({}),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// LDAP 单向导入：逐行创建/跳过，不写回密码、不可本地登录（需求 §用户管理）。
#[derive(Deserialize)]
pub struct LdapImportRow {
    pub username: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LdapImportReq {
    pub users: Vec<LdapImportRow>,
}

#[derive(Serialize)]
pub struct LdapImportResult {
    pub created: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

pub async fn import_ldap(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Json(body): Json<LdapImportReq>,
) -> Result<Json<LdapImportResult>, ApiError> {
    require_admin(&user)?;
    let pool = state.db.pool();
    let mut res = LdapImportResult {
        created: vec![],
        skipped: vec![],
        failed: vec![],
    };
    for row in &body.users {
        if row.username.trim().is_empty() {
            res.failed.push("<空用户名>".into());
            continue;
        }
        let exists = Users::get_by_username(pool, &row.username).await?.is_some();
        if exists {
            res.skipped.push(row.username.clone());
            continue;
        }
        let display = row.display_name.as_deref().unwrap_or(&row.username);
        match Users::create_ldap(pool, &row.username, display).await {
            Ok(u) => {
                Audit::log(
                    pool,
                    Some(user.id),
                    "admin",
                    "ldap_import",
                    Some("user"),
                    Some(&u.id.to_string()),
                    serde_json::json!({}),
                    None,
                )
                .await?;
                res.created.push(row.username.clone());
            }
            Err(e) => res.failed.push(format!("{}: {e}", row.username)),
        }
    }
    Ok(Json(res))
}

#[derive(Debug, Deserialize, Default)]
pub struct PageQuery {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[allow(dead_code)]
pub fn page_bounds(q: &PageQuery) -> (u32, u32) {
    let limit = q.limit.unwrap_or(50).min(200);
    (limit, q.offset.unwrap_or(0))
}
