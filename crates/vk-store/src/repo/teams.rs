//! 团队持久化。

use super::{Result, StoreError};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;
use vk_core::model::Team;

#[derive(sqlx::FromRow)]
struct TeamRow {
    id: Uuid,
    name: String,
    created_at: DateTime<Utc>,
}

pub struct Teams;

impl Teams {
    pub async fn create(pool: &PgPool, name: &str) -> Result<Team> {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO teams (id, name) VALUES ($1, $2)")
            .bind(id)
            .bind(name)
            .execute(pool)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                    StoreError::NameConflict(format!("团队 {name} 已存在"))
                }
                other => other.into(),
            })?;
        Ok(Team {
            id,
            name: name.to_string(),
            created_at: chrono::Utc::now(),
        })
    }

    pub async fn list(pool: &PgPool) -> Result<Vec<Team>> {
        let rows: Vec<TeamRow> =
            sqlx::query_as("SELECT id, name, created_at FROM teams ORDER BY name")
                .fetch_all(pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|r| Team {
                id: r.id,
                name: r.name,
                created_at: r.created_at,
            })
            .collect())
    }

    pub async fn get(pool: &PgPool, id: Uuid) -> Result<Team> {
        let r =
            sqlx::query_as::<_, TeamRow>("SELECT id, name, created_at FROM teams WHERE id = $1")
                .bind(id)
                .fetch_optional(pool)
                .await?
                .ok_or_else(|| StoreError::NotFound(format!("团队 {id}")))?;
        Ok(Team {
            id: r.id,
            name: r.name,
            created_at: r.created_at,
        })
    }

    pub async fn add_member(pool: &PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
        // 先确认团队存在，避免挂到不存在的团队
        Self::get(pool, team_id).await?;
        sqlx::query(
            "INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(team_id)
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn remove_member(pool: &PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(team_id)
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// 用户所属团队 id 列表（权限继承用）。
    pub async fn team_ids_of_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<Uuid>> {
        let rows: Vec<(Uuid,)> =
            sqlx::query_as("SELECT team_id FROM team_members WHERE user_id = $1")
                .bind(user_id)
                .fetch_all(pool)
                .await?;
        Ok(rows.into_iter().map(|r| r.0).collect())
    }

    /// 团队改名（重名 → NameConflict）。
    pub async fn rename(pool: &PgPool, id: Uuid, new_name: &str) -> Result<Team> {
        sqlx::query("UPDATE teams SET name = $2 WHERE id = $1")
            .bind(id)
            .bind(new_name)
            .execute(pool)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
                    StoreError::NameConflict(format!("团队 {new_name} 已存在"))
                }
                other => other.into(),
            })?;
        Self::get(pool, id).await
    }

    /// 团队全部成员。
    pub async fn members(pool: &PgPool, team_id: Uuid) -> Result<Vec<vk_core::model::User>> {
        #[derive(sqlx::FromRow)]
        struct MemberRow {
            id: Uuid,
            username: String,
            display_name: String,
            password_hash: Option<String>,
            auth_provider: String,
            role: String,
            disabled: bool,
            created_at: DateTime<Utc>,
        }
        let rows: Vec<MemberRow> = sqlx::query_as(
            "SELECT u.id, u.username, u.display_name, u.password_hash, u.auth_provider, u.role,
                    u.disabled, u.created_at
             FROM team_members tm JOIN users u ON u.id = tm.user_id
             WHERE tm.team_id = $1 ORDER BY u.display_name",
        )
        .bind(team_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| vk_core::model::User {
                id: r.id,
                username: r.username,
                display_name: r.display_name,
                password_hash: r.password_hash,
                auth_provider: match r.auth_provider.as_str() {
                    "ldap" => vk_core::model::AuthProvider::Ldap,
                    _ => vk_core::model::AuthProvider::Local,
                },
                role: match r.role.as_str() {
                    "admin" => vk_core::model::Role::Admin,
                    _ => vk_core::model::Role::User,
                },
                disabled: r.disabled,
                created_at: r.created_at,
            })
            .collect())
    }

    /// 删除团队：仅允许删除空团队（成员已移除）。
    pub async fn delete(pool: &PgPool, id: Uuid) -> Result<()> {
        let n = sqlx::query("DELETE FROM teams WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = $1)")
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected();
        if n == 0 {
            return Err(StoreError::Internal("团队不存在或仍有成员".into()));
        }
        Ok(())
    }
}
