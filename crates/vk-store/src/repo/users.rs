//! 用户持久化。

use super::{Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
use vk_core::model::{AuthProvider, Role, User};

const USER_SELECT: &str = "id, username, display_name, password_hash, auth_provider, role, disabled, email, ldap_dn, last_login_at, created_at, token_version, quota_bytes";

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
    token_version: i32,
    quota_bytes: Option<i64>,
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
        token_version: r.token_version,
        quota_bytes: r.quota_bytes,
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

    /// 启用/禁用：禁用即吊销该用户全部 token（避免"禁用后旧 token 还能用"）。
    pub async fn set_disabled(pool: &PgPool, id: Uuid, disabled: bool) -> Result<()> {
        let n = sqlx::query(
            "UPDATE users SET disabled = $2,
                                token_version = token_version + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
                                updated_at = now()
             WHERE id = $1",
        )
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

    /// 设置个人配额（`None` = 不限制）。
    pub async fn set_quota(pool: &PgPool, id: Uuid, quota_bytes: Option<i64>) -> Result<()> {
        let n = sqlx::query("UPDATE users SET quota_bytes = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(quota_bytes)
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("用户 {id}")));
        }
        Ok(())
    }

    /// 某用户当前占用字节数：其名下**未删除**文件的当前版本大小之和。
    pub async fn usage_bytes(pool: &PgPool, user_id: Uuid) -> Result<i64> {
        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(size), 0)::bigint FROM files
             WHERE created_by = $1 AND deleted_at IS NULL",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(row.0)
    }

    /// 批量占用统计（用户列表用，一次查询）。
    pub async fn usage_by_creator(pool: &PgPool) -> Result<std::collections::HashMap<Uuid, i64>> {
        let rows: Vec<(Uuid, i64)> = sqlx::query_as(
            "SELECT created_by, COALESCE(SUM(size), 0)::bigint
             FROM files WHERE deleted_at IS NULL AND created_by IS NOT NULL
             GROUP BY created_by",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().collect())
    }

    /// 主动登出/强制下线：自增 token_version，立刻吊销该用户全部未过期 token。
    pub async fn bump_token_version(pool: &PgPool, id: Uuid) -> Result<()> {
        let n = sqlx::query(
            "UPDATE users SET token_version = token_version + 1, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(StoreError::NotFound(format!("用户 {id}")));
        }
        Ok(())
    }

    /// 删除用户并清理关联（M2.41）。
    ///
    /// 外键 `created_by` 是 NO ACTION，直接 DELETE 会被拒；因此在同一事务里：
    /// 撤销该用户创建的分享/发布、删除其目录与文件授权、清掉其文件锁，
    /// 并把其名下目录/文件/版本的 created_by 转交给执行删除的管理员（保留可访问性），
    /// 最后删除用户（团队关系与个人设置由外键 CASCADE 自动清理，审计 actor 置空）。
    pub async fn delete(pool: &PgPool, id: Uuid, operator: Uuid) -> Result<()> {
        let mut tx = pool.begin().await.map_err(StoreError::Sqlx)?;
        // 行锁：与并发删除/登录互斥
        let exists: Option<(Uuid,)> =
            sqlx::query_as("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::Sqlx)?;
        if exists.is_none() {
            return Err(StoreError::NotFound(format!("用户 {id}")));
        }
        for sql in [
            "DELETE FROM grants WHERE principal_type = 'user' AND principal_id = $1",
            "DELETE FROM file_grants WHERE principal_type = 'user' AND principal_id = $1",
            "DELETE FROM file_locks WHERE locked_by = $1",
            "UPDATE directories SET created_by = $2 WHERE created_by = $1",
            "UPDATE files SET created_by = $2 WHERE created_by = $1",
            "UPDATE file_versions SET created_by = $2 WHERE created_by = $1",
            "UPDATE shares SET revoked = true, created_by = $2 WHERE created_by = $1",
            "UPDATE published_dirs SET enabled = false, created_by = $2 WHERE created_by = $1",
        ] {
            if sql.contains("$2") {
                sqlx::query(sql)
                    .bind(id)
                    .bind(operator)
                    .execute(&mut *tx)
                    .await
                    .map_err(StoreError::Sqlx)?;
            } else {
                sqlx::query(sql)
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(StoreError::Sqlx)?;
            }
        }
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::Sqlx)?;
        tx.commit().await.map_err(StoreError::Sqlx)?;
        Ok(())
    }

    /// 活跃管理员数量（删除/降级最后一个管理员前的守卫）。
    pub async fn active_admin_count(pool: &PgPool) -> Result<i64> {
        let row: (i64,) =
            sqlx::query_as("SELECT count(*) FROM users WHERE role = 'admin' AND disabled = false")
                .fetch_one(pool)
                .await?;
        Ok(row.0)
    }

    /// 本地用户重置密码：同时自增 token_version，吊销该用户已签发的全部 token。
    pub async fn set_password(pool: &PgPool, id: Uuid, password: &str) -> Result<()> {
        let hash = hash_password(password)?;
        let n = sqlx::query(
            "UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now()
             WHERE id = $1 AND auth_provider = 'local'",
        )
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
