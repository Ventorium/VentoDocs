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
    /// 凭证版本号（M2.41）：与 `users.token_version` 不一致即视为已吊销。
    /// 老 token 无此字段 → 默认 0，与迁移后的初始值一致，升级不打断在线会话。
    #[serde(default)]
    ver: i64,
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
        ver: user.token_version as i64,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| ApiError::internal(format!("JWT 签发失败：{e}")))
}

/// M2.26：签发站点 token（sub=publish:{publish_id}，role=site），用于发布站点密码门。
/// 与系统账号 token 同源（同一 jwt_secret），但 sub 前缀不同，parse_token 会拒绝它。
pub fn sign_site_token(secret: &str, publish_id: &str, ttl_hours: u64) -> Result<String, ApiError> {
    let now = Utc::now().timestamp();
    let claims = Claims {
        sub: format!("publish:{publish_id}"),
        ver: 0,
        role: "site".to_string(),
        iat: now,
        exp: now + (ttl_hours * 3600) as i64,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| ApiError::internal(format!("站点令牌签发失败：{e}")))
}

/// M2.26：校验站点 token —— 签名有效且 sub 精确等于 publish:{publish_id}（防跨站点复用）。
pub fn verify_site_token(secret: &str, token: &str, publish_id: &str) -> bool {
    let Ok(data) = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(jsonwebtoken::Algorithm::HS256),
    ) else {
        return false;
    };
    data.claims.sub == format!("publish:{publish_id}")
}

/// 解析系统账号 token → `(用户 id, 角色, 凭证版本号)`。
pub fn parse_token(secret: &str, token: &str) -> Result<(Uuid, Role, i64), ApiError> {
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
    Ok((id, role, data.claims.ver))
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
    let (id, _role, ver) = parse_token(&state.cfg.jwt_secret, token)?;
    let user = Users::get_by_id(state.db.pool(), id)
        .await
        .map_err(|e| match e {
            StoreError::NotFound(_) => ApiError::unauthorized(),
            other => other.into(),
        })?;
    if user.disabled {
        return Err(ApiError::forbidden("账号已被禁用"));
    }
    // 凭证版本不一致 = 改密/禁用/登出后已吊销：旧 token 立即失效
    if ver != user.token_version as i64 {
        return Err(ApiError::unauthorized_with("登录状态已失效，请重新登录"));
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

/// bootstrap 并发互斥用的 advisory lock key（任意常量，进程无关）。
const BOOTSTRAP_LOCK: i64 = 0x0076_656e_746f;

/// 首次初始化：仅当系统无用户时可创建首个管理员。
pub async fn bootstrap(
    State(state): State<AppState>,
    Json(body): Json<BootstrapReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    // 并发竞态防护：两个同时到达的 bootstrap 都可能读到 count=0 而各自建管理员。
    // 用事务级 advisory lock 串行化「检查 → 建号」窗口（锁随事务/提前返回自动释放）。
    let mut tx = pool.begin().await.map_err(StoreError::Sqlx)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(BOOTSTRAP_LOCK)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::Sqlx)?;
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
    // 建号成功后才提交（提前返回时事务回滚、锁自动释放）
    tx.commit().await.map_err(StoreError::Sqlx)?;
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

/// 登出（M2.41）：自增 token_version，使该用户**所有**已签发 token 立即失效。
/// 说明：本系统无服务端会话表，故登出是"该账号全端下线"，而非仅当前设备。
pub async fn logout(
    State(state): State<AppState>,
    axum::extract::Extension(auth): axum::extract::Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Users::bump_token_version(state.db.pool(), auth.id).await?;
    Audit::log(
        state.db.pool(),
        Some(auth.id),
        "auth",
        "logout",
        Some("user"),
        Some(&auth.id.to_string()),
        serde_json::json!({}),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 当前用户信息。
/// 当前用户信息 + 个人配额（M2.43）。配额字段供前端做上传前预检；
/// 真正的准入仍以写接口的服务端校验为准。
pub async fn me(
    State(state): State<AppState>,
    axum::extract::Extension(auth): axum::extract::Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let user = Users::get_by_id(pool, auth.id).await?;
    let used = Users::usage_bytes(pool, auth.id).await?;
    Ok(Json(serde_json::json!({
        "id": auth.id,
        "username": auth.username,
        "display_name": auth.display_name,
        "role": auth.role,
        "is_admin": auth.is_admin,
        "quota_bytes": user.quota_bytes,
        "used_bytes": used,
    })))
}
