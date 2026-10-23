//! 审计日志：与业务同事务写入。

use super::Result;
use chrono::{DateTime, Utc};
use sqlx::{PgExecutor, PgPool};
use uuid::Uuid;

pub struct Audit;

/// 审计日志行（列表查询用，含操作人名称）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub actor_id: Option<Uuid>,
    pub actor_name: Option<String>,
    pub category: String,
    pub action: String,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub detail: serde_json::Value,
    pub ip: Option<String>,
}

#[derive(Debug, Default, sqlx::FromRow)]
struct AuditRow {
    id: i64,
    ts: DateTime<Utc>,
    actor_id: Option<Uuid>,
    actor_name: Option<String>,
    category: String,
    action: String,
    resource_type: Option<String>,
    resource_id: Option<String>,
    detail: serde_json::Value,
    ip: Option<String>,
}

impl Audit {
    /// 在独立连接上写审计（调用方无事务时）。
    #[allow(clippy::too_many_arguments)]
    pub async fn log(
        pool: &PgPool,
        actor: Option<Uuid>,
        category: &str,
        action: &str,
        resource_type: Option<&str>,
        resource_id: Option<&str>,
        detail: serde_json::Value,
        ip: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO audit_logs (actor_id, category, action, resource_type, resource_id, detail, ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(actor)
        .bind(category)
        .bind(action)
        .bind(resource_type)
        .bind(resource_id)
        .bind(&detail)
        .bind(ip)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// 在事务内写审计（业务写入同事务，失败一起回滚）。
    #[allow(clippy::too_many_arguments)]
    pub async fn log_tx<'a, E: PgExecutor<'a>>(
        exec: E,
        actor: Option<Uuid>,
        category: &str,
        action: &str,
        resource_type: Option<&str>,
        resource_id: Option<&str>,
        detail: serde_json::Value,
        ip: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO audit_logs (actor_id, category, action, resource_type, resource_id, detail, ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(actor)
        .bind(category)
        .bind(action)
        .bind(resource_type)
        .bind(resource_id)
        .bind(&detail)
        .bind(ip)
        .execute(exec)
        .await?;
        Ok(())
    }

    /// 审计列表（管理员）：按类别/动作/操作人筛选，ts 倒序分页。
    pub async fn list(
        pool: &PgPool,
        category: Option<&str>,
        action: Option<&str>,
        actor_id: Option<Uuid>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<AuditEntry>> {
        let rows: Vec<AuditRow> = sqlx::query_as(
            r#"
            SELECT a.id, a.ts, a.actor_id, u.display_name AS actor_name, a.category, a.action,
                   a.resource_type, a.resource_id, a.detail, a.ip
              FROM audit_logs a
              LEFT JOIN users u ON u.id = a.actor_id
             WHERE ($1::text IS NULL OR a.category = $1)
               AND ($2::text IS NULL OR a.action = $2)
               AND ($3::uuid IS NULL OR a.actor_id = $3)
             ORDER BY a.id DESC
             LIMIT $4 OFFSET $5
            "#,
        )
        .bind(category)
        .bind(action)
        .bind(actor_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| AuditEntry {
                id: r.id,
                ts: r.ts,
                actor_id: r.actor_id,
                actor_name: r.actor_name,
                category: r.category,
                action: r.action,
                resource_type: r.resource_type,
                resource_id: r.resource_id,
                detail: r.detail,
                ip: r.ip,
            })
            .collect())
    }
}
