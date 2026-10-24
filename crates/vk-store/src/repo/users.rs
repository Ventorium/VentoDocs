//! 用户持久化。

use super::{Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
use vk_core::model::{AuthProvider, Role, User};

const USER_SELECT: &str =
    "id, username, display_name, password_hash, auth_provider, role, disabled, email, ldap_dn, last_login_at, created_at";

fn map_provider(s: &str) -> AuthProvider {
    match s {
        "ldap" => AuthProvider::Ldap,
        _ => AuthProvider::Local,
    }
}
fn map_role(s: &str) -> Role {
    match s {
        "admin" => Role::Admin,
        _ => Role::User,
    }
}
fn role_str(r: Role) -> &'static str {
    match r {
        Role::Admin => "admin",
        Role::User => "user",
    }
}

#[derive(FromRow)]
struct UserRow {
    id: Uuid,
    username: String,
    display_name: String,
    password_hash: Option<String>,
    auth_provider: String,
    role: String,
    disabled: bool,
    email: Option<String>,
    ldap_dn: Option<String>,
    last_login_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

fn to_user(r: UserRow) -> User {
    User {
        id: r.id,
        username: r.username,
        display_name: r.display_name,
        password_hash: r.password_hash,
        auth_provider: map_provider(&r.auth_provider),
        role: map_role(&r.role),
        disabled: r.disabled,
        email: r.email,
        ldap_dn: r.ldap_dn,
        last_login_at: r.last_login_at,
        created_at: r.created_at,
    }
}

pub struct Users;

impl Users {
    /// 当前用户总数（bootstrap 判定用）。
    pub async fn count(pool: &PgPool) -> Result<i64> {
        let row: (i64,) = sqlx::query_as("SELECT count(*) FROM users")
            .fetch_one(pool)
            .await?;
        Ok(row.0)
    }

    pub async fn get_by_id(pool: &PgPool, id: Uuid) -> Result<User> {
        let row =
            sqlx::query_as::<_, UserRow>(&format!("SELECT {USER_SELECT} FROM users WHERE id = $1"))
                .bind(id)
                .fetch_optional(pool)
                .await?
                .ok_or_else(|| StoreError::NotFound(format!("用户 {id}")))?;
        Ok(to_user(row))
    }

    pub async fn get_by_username(pool: &PgPool, username: &str) -> Result<Option<User>> {
        let row = sqlx::query_as::<_, UserRow>(&format!(
            "SELECT {USER_SELECT} FROM users WHERE username = $1"
        ))
        .bind(username)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(to_user))
    }

    pub async fn list(pool: &PgPool) -> Result<Vec<User>> {
        let rows = sqlx::query_as::<_, UserRow>(&format!(
            "SELECT {USER_SELECT} FROM users ORDER BY username"
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(to_user).collect())
    }

    /// 创建本地用户（argon2id 哈希密码）。email 可选。
    pub async fn create(
        pool: &PgPool,
        username: &str,
        display_name: &str,
        password: &str,
        role: Role,
        email: Option<&str>,
    ) -> Result<User> {
        let hash = hash_password(password)?;
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, password_hash, auth_provider, role, email)
             VALUES ($1, $2, $3, $4, 'local', $5, $6)",
        )
        .bind(id)
        .bind(username)
        .bind(display_name)
        .bind(&hash)
        .bind(role_str(role))
        .bind(email)
        .execute(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                StoreError::NameConflict(format!("用户名 {username} 已存在"))
            }
            other => other.into(),
        })?;
        Self::get_by_id(pool, id).await
    }

    /// 创建 LDAP 导入用户（无本地密码，不可本地登录；保存 email/ldap_dn 溯源）。
    pub async fn create_ldap(
        pool: &PgPool,
        username: &str,
        display_name: &str,
        email: Option<&str>,
        ldap_dn: Option<&str>,
    ) -> Result<User> {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, auth_provider, role, email, ldap_dn)
             VALUES ($1, $2, $3, 'ldap', 'user', $4, $5)",
        )
        .bind(id)
        .bind(username)
        .bind(display_name)
        .bind(email)
        .bind(ldap_dn)
        .execute(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                StoreError::NameConflict(format!("用户名 {username} 已存在"))
            }
            other => other.into(),
        })?;
        Self::get_by_id(pool, id).await
    }

    /// 重复导入 LDAP 时刷新展示字段（不改密码、不改角色、不改变 disabled，§15 单向同步）。
    pub async fn update_ldap_meta(
        pool: &PgPool,
        id: Uuid,
        display_name: Option<&str>,
        email: Option<&str>,
        ldap_dn: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE users SET display_name = COALESCE($2, display_name),
                                email = COALESCE($3, email),
                                ldap_dn = COALESCE($4, ldap_dn),
                                updated_at = now()
              WHERE id = $1",
        )
        .bind(id)
        .bind(display_name)
        .bind(email)
        .bind(ldap_dn)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 登录查找：按 username 或 email 匹配。
    pub async fn get_by_identifier(pool: &PgPool, identifier: &str) -> Result<Option<User>> {
        let row = sqlx::query_as::<_, UserRow>(&format!(
            "SELECT {USER_SELECT} FROM users WHERE username = $1 OR email = $1"
        ))
        .bind(identifier)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(to_user))
    }

    /// 登录成功后刷新 last_login_at。
    pub async fn touch_last_login(pool: &PgPool, id: Uuid) -> Result<()> {
        sqlx::query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn update_display_name(pool: &PgPool, id: Uuid, display_name: &str) -> Result<()> {
        let n = sqlx::query("UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(display_name)
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("用户 {id}")));
        }
        Ok(())
    }

    pub async fn set_role(pool: &PgPool, id: Uuid, role: Role) -> Result<()> {
        let n = sqlx::query("UPDATE users SET role = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(role_str(role))
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("用户 {id}")));
        }
        Ok(())
    }

    pub async fn set_disabled(pool: &PgPool, id: Uuid, disabled: bool) -> Result<()> {
        let n = sqlx::query("UPDATE users SET disabled = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(disabled)
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("用户 {id}")));
        }
        Ok(())
    }

    /// 本地用户重置密码。
    pub async fn set_password(pool: &PgPool, id: Uuid, password: &str) -> Result<()> {
        let hash = hash_password(password)?;
        let n = sqlx::query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND auth_provider = 'local'")
            .bind(id)
            .bind(&hash)
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("本地用户 {id}")));
        }
        Ok(())
    }
}

pub fn hash_password(password: &str) -> Result<String> {
    use argon2::Argon2;
    use argon2::password_hash::{PasswordHasher, SaltString, rand_core::OsRng};

    let salt = SaltString::generate(&mut OsRng);
    // 注意：password-hash 0.5 的 Output 上限为 64 字节，故取 32 字节摘要。
    let params = argon2::Params::new(65536, 3, 4, Some(32))
        .map_err(|e| StoreError::Internal(e.to_string()))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| StoreError::Internal(e.to_string()))?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    use argon2::Argon2;
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip() {
        let h = hash_password("s3cret").unwrap();
        assert!(verify_password("s3cret", &h));
        assert!(!verify_password("wrong", &h));
    }
}
