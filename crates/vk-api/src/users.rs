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
    #[serde(default)]
    pub email: Option<String>,
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

/// M2.18：列出所有用户放开为「任意登录用户」——
/// 非管理员需要在权限管理弹窗里选择要授权的用户/团队。
pub async fn list(State(state): State<AppState>) -> Result<Json<Vec<UserOut>>, ApiError> {
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
        body.email.as_deref(),
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

/// 当前生效的 LDAP 配置（管理员）：数据库行优先，回退环境变量；不返回密码明文（§15 在线配置）。
pub async fn ldap_config(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(ldap_config_response(&state).await?))
}

async fn ldap_config_response(state: &AppState) -> Result<serde_json::Value, ApiError> {
    let key = vk_store::repo::ldap::derive_key(&state.cfg.jwt_secret);
    match vk_store::repo::ldap::resolve_ldap_config(state.db.pool(), &key)
        .await
        .map_err(ApiError::bad_request)?
    {
        Some((cfg, source, password_set)) => {
            let mut info = cfg.public_info();
            if let Some(obj) = info.as_object_mut() {
                obj.insert("source".to_string(), serde_json::json!(source));
                obj.insert("passwordSet".to_string(), serde_json::json!(password_set));
                obj.insert("bindDnSet".to_string(), serde_json::json!(!cfg.bind_dn.is_empty()));
            }
            Ok(info)
        }
        None => Err(ApiError::bad_request(
            "LDAP 未配置（数据库无配置且未设置 VIENTO_LDAP_* 环境变量）",
        )),
    }
}

/// 保存/测试 LDAP 配置的请求体。
#[derive(Debug, Deserialize)]
pub struct LdapConfigReq {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub start_tls: bool,
    #[serde(default)]
    pub base_dn: String,
    #[serde(default)]
    pub bind_dn: String,
    /// 空/缺省 = 沿用已有密码（库中或环境变量）；非空 = 覆盖。
    #[serde(default)]
    pub bind_password: Option<String>,
    #[serde(default = "default_ldap_filter")]
    pub user_filter: String,
    #[serde(default = "default_ldap_username_attr")]
    pub attr_username: String,
    #[serde(default = "default_ldap_name_attr")]
    pub attr_name: String,
    #[serde(default = "default_ldap_email_attr")]
    pub attr_email: String,
}

fn default_ldap_filter() -> String {
    "(objectClass=inetOrgPerson)".to_string()
}
fn default_ldap_username_attr() -> String {
    "uid".to_string()
}
fn default_ldap_name_attr() -> String {
    "cn".to_string()
}
fn default_ldap_email_attr() -> String {
    "mail".to_string()
}

impl LdapConfigReq {
    fn to_config(&self, bind_password: String) -> vk_store::repo::ldap::LdapConfig {
        vk_store::repo::ldap::LdapConfig {
            host: self.host.trim().to_string(),
            port: self.port,
            start_tls: self.start_tls,
            base_dn: self.base_dn.trim().to_string(),
            bind_dn: self.bind_dn.trim().to_string(),
            bind_password,
            user_filter: self.user_filter.trim().to_string(),
            attr_username: self.attr_username.trim().to_string(),
            attr_name: self.attr_name.trim().to_string(),
            attr_email: self.attr_email.trim().to_string(),
        }
    }
}

/// 保存 LDAP 配置（管理员）：覆盖数据库单行；bind_password 留空表示沿用旧值（§15 在线配置）。
pub async fn save_ldap_config(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Json(body): Json<LdapConfigReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    if body.host.trim().is_empty() {
        return Err(ApiError::bad_request("LDAP 主机不能为空"));
    }
    let pool = state.db.pool();
    let key = vk_store::repo::ldap::derive_key(&state.cfg.jwt_secret);
    let current = vk_store::repo::ldap::load_ldap_config_row(pool)
        .await
        .map_err(ApiError::bad_request)?;
    let password_changed = body
        .bind_password
        .as_deref()
        .is_some_and(|p| !p.trim().is_empty());
    let password_hex = if password_changed {
        let plain = body.bind_password.as_deref().unwrap().trim();
        Some(
            vk_store::repo::ldap::encrypt_secret(&key, plain)
                .map_err(ApiError::bad_request)?,
        )
    } else {
        // 留空 = 沿用已有密码：库中值优先，无库行时回退环境变量（与测试端一致）。
        current.and_then(|r| r.bind_password).or_else(|| {
            vk_store::repo::ldap::LdapConfig::from_env()
                .map(|c| c.bind_password)
                .filter(|p| !p.is_empty())
                .and_then(|p| vk_store::repo::ldap::encrypt_secret(&key, &p).ok())
        })
    };
    let cfg = body.to_config(String::new());
    vk_store::repo::ldap::save_ldap_config(pool, &cfg, password_hex.as_deref())
        .await
        .map_err(ApiError::bad_request)?;
    Audit::log(
        pool,
        Some(user.id),
        "admin",
        "ldap_config_save",
        None,
        None,
        serde_json::json!({
            "host": cfg.host,
            "port": cfg.port,
            "baseDn": cfg.base_dn,
            "bindDnSet": !cfg.bind_dn.is_empty(),
            "passwordChanged": password_changed,
        }),
        None,
    )
    .await?;
    Ok(Json(ldap_config_response(&state).await?))
}

/// 删除数据库中的 LDAP 配置（管理员）：恢复回退到 VIENTO_LDAP_* 环境变量。
pub async fn delete_ldap_config(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    let deleted = vk_store::repo::ldap::delete_ldap_config(state.db.pool())
        .await
        .map_err(ApiError::bad_request)?;
    Audit::log(
        state.db.pool(),
        Some(user.id),
        "admin",
        "ldap_config_delete",
        None,
        None,
        serde_json::json!({ "deleted": deleted }),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true, "deleted": deleted })))
}

/// 测试 LDAP 连接（管理员）：`host` 有值 = 用表单值测试（保存前测试）；
/// 省略 `host`（如 `{}`）= 测试当前生效配置。
/// 始终返回 200 + `{ok, entries?, sample?, error?}`，由前端展示。
#[derive(Debug, Deserialize, Default)]
pub struct LdapTestReq {
    /// 省略 = 测试当前生效配置。
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub start_tls: Option<bool>,
    #[serde(default)]
    pub base_dn: Option<String>,
    #[serde(default)]
    pub bind_dn: Option<String>,
    /// 留空 = 沿用已有密码（库中或环境变量）。
    #[serde(default)]
    pub bind_password: Option<String>,
    #[serde(default)]
    pub user_filter: Option<String>,
    #[serde(default)]
    pub attr_username: Option<String>,
    #[serde(default)]
    pub attr_name: Option<String>,
    #[serde(default)]
    pub attr_email: Option<String>,
}

pub async fn test_ldap(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Json(req): Json<LdapTestReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&user)?;
    let key = vk_store::repo::ldap::derive_key(&state.cfg.jwt_secret);
    let cfg = match req.host.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(host) => {
            // 表单值测试：字段缺省回退到 LdapConfig 默认值
            let defaults = vk_store::repo::ldap::LdapConfig {
                host: String::new(),
                port: 389,
                start_tls: false,
                base_dn: String::new(),
                bind_dn: String::new(),
                bind_password: String::new(),
                user_filter: default_ldap_filter(),
                attr_username: default_ldap_username_attr(),
                attr_name: default_ldap_name_attr(),
                attr_email: default_ldap_email_attr(),
            };
            let stored = vk_store::repo::ldap::load_ldap_config_row(state.db.pool())
                .await
                .map_err(ApiError::bad_request)?
                .and_then(|r| r.bind_password)
                .and_then(|hex| vk_store::repo::ldap::decrypt_secret(&key, &hex).ok());
            let env_pwd = vk_store::repo::ldap::LdapConfig::from_env()
                .map(|c| c.bind_password)
                .filter(|p| !p.is_empty());
            let password = req
                .bind_password
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or(stored)
                .or(env_pwd)
                .unwrap_or_default();
            vk_store::repo::ldap::LdapConfig {
                host: host.to_string(),
                port: req.port.unwrap_or(defaults.port),
                start_tls: req.start_tls.unwrap_or(defaults.start_tls),
                base_dn: req.base_dn.unwrap_or_default().trim().to_string(),
                bind_dn: req.bind_dn.unwrap_or_default().trim().to_string(),
                bind_password: password,
                user_filter: req
                    .user_filter
                    .unwrap_or(defaults.user_filter)
                    .trim()
                    .to_string(),
                attr_username: req
                    .attr_username
                    .unwrap_or(defaults.attr_username)
                    .trim()
                    .to_string(),
                attr_name: req.attr_name.unwrap_or(defaults.attr_name).trim().to_string(),
                attr_email: req.attr_email.unwrap_or(defaults.attr_email).trim().to_string(),
            }
        }
        None => {
            let Some((cfg, _, _)) =
                vk_store::repo::ldap::resolve_ldap_config(state.db.pool(), &key)
                    .await
                    .map_err(ApiError::bad_request)?
            else {
                return Err(ApiError::bad_request(
                    "LDAP 未配置（数据库无配置且未设置 VIENTO_LDAP_* 环境变量）",
                ));
            };
            cfg
        }
    };
    let pool = state.db.pool();
    let result = vk_store::repo::ldap::search_users(&cfg).await;
    match result {
        Ok(entries) => {
            let n = entries.len();
            let sample: Vec<String> = entries.iter().take(5).map(|e| e.username.clone()).collect();
            Audit::log(
                pool,
                Some(user.id),
                "admin",
                "ldap_config_test",
                None,
                None,
                serde_json::json!({ "ok": true, "entries": n }),
                None,
            )
            .await?;
            Ok(Json(serde_json::json!({ "ok": true, "entries": n, "sample": sample })))
        }
        Err(err) => {
            // 测试失败不中断请求，仅记录（error 可能很长，截断）
            let short = if err.len() > 200 {
                format!("{}…", &err[..err.floor_char_boundary(200)])
            } else {
                err.clone()
            };
            let _ = Audit::log(
                pool,
                Some(user.id),
                "admin",
                "ldap_config_test",
                None,
                None,
                serde_json::json!({ "ok": false, "error": short }),
                None,
            )
            .await;
            Ok(Json(serde_json::json!({ "ok": false, "error": err })))
        }
    }
}

/// LDAP 单向导入：管理员触发，直连 LDAP 搜索用户并写入本地（需求 §15）。
/// 已存在用户名 → 跳过（仅同步显示名/邮箱/DN，不碰密码/角色/禁用）；
/// 新用户名 → 创建 ldap 账号（不可本地登录）；失败逐条记入 failed。
#[derive(Serialize)]
pub struct LdapImportResult {
    pub created: u32,
    pub skipped: u32,
    pub failed: Vec<String>,
}

pub async fn import_ldap(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<LdapImportResult>, ApiError> {
    require_admin(&user)?;
    let key = vk_store::repo::ldap::derive_key(&state.cfg.jwt_secret);
    let Some((cfg, _, _)) = vk_store::repo::ldap::resolve_ldap_config(state.db.pool(), &key)
        .await
        .map_err(ApiError::bad_request)?
    else {
        return Err(ApiError::bad_request(
            "LDAP 未配置（数据库无配置且未设置 VIENTO_LDAP_* 环境变量）",
        ));
    };
    let res = vk_store::repo::ldap::import_to_db(&state.db, &cfg)
        .await
        .map_err(ApiError::bad_request)?;
    let out = LdapImportResult {
        created: res.imported,
        skipped: res.skipped,
        failed: res.failed,
    };
    Audit::log(
        state.db.pool(),
        Some(user.id),
        "admin",
        "ldap_import",
        None,
        None,
        serde_json::json!({
            "created": out.created,
            "skipped": out.skipped,
            "failed": out.failed.len(),
        }),
        None,
    )
    .await?;
    Ok(Json(out))
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
