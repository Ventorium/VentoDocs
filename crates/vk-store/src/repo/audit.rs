//! 审计日志：与业务同事务写入。

use super::Result;
use sqlx::{PgExecutor, PgPool};
use uuid::Uuid;

pub struct Audit;

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
}
