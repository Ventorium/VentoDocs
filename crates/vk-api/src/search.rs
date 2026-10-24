//! 文件名搜索 API（v1：PG = ILIKE + pg_trgm 相似度，无 Agent/向量，§9）。
//!
//! 可见性完全镜像 `Grants::resolve`（READ_PREVIEW 位）：
//! 管理员全量 ∪ 目录创建者旁路 ∪ user 授权链 ∪ team 授权链。
//! `directories.path` 为 id 基路径，展示名称路径在 Rust 侧拼装。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::AppState;

fn db_err(e: sqlx::Error) -> ApiError {
    tracing::error!(error = %e, "search SQL error");
    ApiError::internal("数据库操作失败，请稍后重试")
}

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 200;

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// 文件名 ILIKE 字面量转义（配合 `ESCAPE '\'`）。
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// `GET /api/v1/search?q=&limit=`
pub async fn search(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let pool = state.db.pool();
    let raw = q.q.trim();
    if raw.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let like = escape_like(raw);

    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        name: String,
        size: i64,
        mime: String,
        directory_id: Uuid,
        updated_at: chrono::DateTime<chrono::Utc>,
        is_prefix: bool,
        sim: f32,
    }

    let rows: Vec<Row> = sqlx::query_as(
        r#"
        SELECT f.id, f.name, f.size, f.mime, f.directory_id, f.updated_at,
               (f.name ILIKE $1 || '%') AS is_prefix,
               similarity(f.name, $2) AS sim
        FROM files f
        JOIN directories d ON d.id = f.directory_id
        WHERE f.deleted_at IS NULL
          AND (f.name ILIKE '%' || $1 || '%' ESCAPE '\' OR similarity(f.name, $2) > 0.1)
          AND (
            $3::bool
            OR EXISTS (
              SELECT 1 FROM directories a
              WHERE d.path LIKE a.path || '%' AND a.created_by = $4
            )
            OR EXISTS (
              SELECT 1 FROM grants g
              JOIN directories a ON a.id = g.directory_id
              WHERE g.principal_type = 'user'
                AND g.principal_id = $4
                AND (g.perms & 1) > 0
                AND d.path LIKE a.path || '%'
            )
            OR EXISTS (
              SELECT 1 FROM grants g
              JOIN directories a ON a.id = g.directory_id
              JOIN team_members tm ON tm.team_id = g.principal_id
              WHERE g.principal_type = 'team'
                AND (g.perms & 1) > 0
                AND tm.user_id = $4
                AND d.path LIKE a.path || '%'
            )
          )
        ORDER BY (f.name ILIKE $1 || '%') DESC, similarity(f.name, $2) DESC, f.updated_at DESC
        LIMIT $5
        "#,
    )
    .bind(like)
    .bind(raw)
    .bind(user.is_admin)
    .bind(user.id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;

    // id 基路径 → 名称路径：批量取命中目录的 path，再批量取各段名称
    let dir_ids: Vec<Uuid> = rows.iter().map(|r| r.directory_id).collect();
    let mut dir_path_by_id: std::collections::HashMap<Uuid, String> =
        std::collections::HashMap::new();
    let mut name_of: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if !dir_ids.is_empty() {
        let dir_rows: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id, path FROM directories WHERE id = ANY($1)",
        )
        .bind(&dir_ids)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
        for (id, path) in dir_rows {
            dir_path_by_id.insert(id, path);
        }
        let segments: Vec<String> = dir_path_by_id
            .values()
            .flat_map(|p| p.trim_matches('/').split('/'))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        if !segments.is_empty() {
            let names: Vec<(String, String)> = sqlx::query_as(
                "SELECT id::text, name FROM directories WHERE id::text = ANY($1)",
            )
            .bind(&segments)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
            for (id, name) in names {
                name_of.insert(id, name);
            }
        }
    }

    let display_path = |dir_id: Uuid,
                        name_of: &std::collections::HashMap<String, String>|
     -> String {
        let Some(path) = dir_path_by_id.get(&dir_id) else {
            return "根目录".to_string();
        };
        let segments: Vec<&str> = path
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        if segments.is_empty() {
            return "根目录".to_string();
        }
        let mut parts = vec!["根目录".to_string()];
        for s in &segments {
            parts.push(name_of.get(*s).cloned().unwrap_or_else(|| s.to_string()));
        }
        parts.join(" / ")
    };

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(serde_json::json!({
            "id": r.id,
            "name": r.name,
            "size": r.size,
            "mime": r.mime,
            "directoryPath": display_path(r.directory_id, &name_of),
            "isPrefixMatch": r.is_prefix,
            "similarity": (r.sim * 100.0).round() / 100.0,
            "updatedAt": r.updated_at,
        }));
    }
    Ok(Json(out))
}
