//! JWT 认证：签发、校验中间件、bootstrap / login / me 端点。

use axum::Json;
use axum::extract::{Request, State};
use axum::http::header;
use axum::middleware::Next;
use axum::response::Response;
use chrono::Utc;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vk_core::model::{AuthProvider, Role, User};
use vk_store::StoreError;
use vk_store::repo::audit::Audit;
use vk_store::repo::users::Users;

use crate::AppState;
use crate::error::ApiError;

/// 注入到请求扩展中的认证用户。
#[derive(Debug, Clone, Serialize)]
pub struct AuthUser {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub role: Role,
    pub is_admin: bool,
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    role: String,
    iat: i64,
    exp: i64,
}

fn role_str(role: &Role) -> &'static str {
    match role {
        Role::Admin => "admin",
        Role::User => "user",
    }
}

pub fn sign_token(secret: &str, user: &User, ttl_hours: u64) -> Result<String, ApiError> {
    let now = Utc::now().timestamp();
    let claims = Claims {
        sub: user.id.to_string(),
        role: role_str(&user.role).to_string(),
        iat: now,
        exp: now + (ttl_hours * 3600) as i64,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| ApiError::internal(format!("JWT 签发失败：{e}")))
}

pub fn parse_token(secret: &str, token: &str) -> Result<(Uuid, Role), ApiError> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(jsonwebtoken::Algorithm::HS256),
    )
    .map_err(|_| ApiError::unauthorized())?;
    let id = Uuid::parse_str(&data.claims.sub).map_err(|_| ApiError::unauthorized())?;
    let role = if data.claims.role == "admin" {
        Role::Admin
    } else {
        Role::User
    };
    Ok((id, role))
}

/// 认证中间件：校验 Bearer JWT 与账号状态，注入 AuthUser。
pub async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(ApiError::unauthorized)?;
    let (id, _role) = parse_token(&state.cfg.jwt_secret, token)?;
    let user = Users::get_by_id(state.db.pool(), id)
        .await
        .map_err(|e| match e {
            StoreError::NotFound(_) => ApiError::unauthorized(),
            other => other.into(),
        })?;
    if user.disabled {
        return Err(ApiError::forbidden("账号已被禁用"));
    }
    let auth = AuthUser {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        is_admin: user.role == Role::Admin,
    };
    req.extensions_mut().insert(auth);
    Ok(next.run(req).await)
}

#[derive(Deserialize)]
pub struct BootstrapReq {
    pub username: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub password: String,
}

/// 首次初始化：仅当系统无用户时可创建首个管理员。
pub async fn bootstrap(
    State(state): State<AppState>,
    Json(body): Json<BootstrapReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let count = Users::count(pool).await?;
    if count > 0 {
        return Err(ApiError::forbidden("系统已完成初始化，bootstrap 不可用"));
    }
    if body.username.trim().is_empty() {
        return Err(ApiError::bad_request("username 不能为空"));
    }
    if body.password.len() < 8 {
        return Err(ApiError::bad_request("密码至少 8 位"));
    }
    let display_name = body.display_name.as_deref().unwrap_or(&body.username);
    let user = Users::create(
        pool,
        &body.username,
        display_name,
        &body.password,
        Role::Admin,
        None,
    )
    .await?;
    Audit::log(
        pool,
        Some(user.id),
        "auth",
        "bootstrap",
        Some("user"),
        Some(&user.id.to_string()),
        serde_json::json!({}),
        None,
    )
    .await?;
    let token = sign_token(&state.cfg.jwt_secret, &user, state.cfg.jwt_ttl_hours)?;
    Ok(Json(serde_json::json!({
        "token": token,
        "expires_in": state.cfg.jwt_ttl_hours * 3600,
        "user": user.to_public(),
    })))
}

#[derive(Deserialize)]
pub struct LoginReq {
    pub username: String,
    pub password: String,
}

/// 本地账号登录（用户名或邮箱均可）；LDAP 导入账号 v1 不支持本地登录。
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let user = Users::get_by_identifier(pool, &body.username)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    if user.disabled {
        return Err(ApiError::forbidden("账号已被禁用，请联系管理员"));
    }
    if user.auth_provider == AuthProvider::Ldap {
        return Err(ApiError::forbidden("LDAP 导入账号暂不支持本地登录"));
    }
    let hash = user
        .password_hash
        .as_deref()
        .ok_or_else(ApiError::unauthorized)?;
    if !vk_store::repo::users::verify_password(&body.password, hash) {
        return Err(ApiError::unauthorized());
    }
    // best-effort 记录最后登录时间
    let _ = Users::touch_last_login(pool, user.id).await;
    let token = sign_token(&state.cfg.jwt_secret, &user, state.cfg.jwt_ttl_hours)?;
    Ok(Json(serde_json::json!({
        "token": token,
        "expires_in": state.cfg.jwt_ttl_hours * 3600,
        "user": user.to_public(),
    })))
}

/// 当前用户信息。
pub async fn me(
    axum::extract::Extension(auth): axum::extract::Extension<AuthUser>,
) -> Json<AuthUser> {
    Json(auth)
}
