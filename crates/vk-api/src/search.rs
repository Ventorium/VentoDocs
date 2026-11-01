//! 文件名搜索 API（v1：PG = ILIKE + pg_trgm 相似度，无 Agent/向量，§9）。
//!
//! 可见性完全镜像 `Grants::resolve`（READ_PREVIEW 位）：
//! 管理员全量 ∪ 目录创建者旁路 ∪ user 授权链 ∪ team 授权链。
//! `directories.path` 为 id 基路径，展示名称路径在 Rust 侧拼装。

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use uuid::Uuid;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::ApiError;

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
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
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

    // 可见目录前缀集合（非管理员）：创建者旁路 ∪ user 授权 ∪ team 授权，
    // 先在库里取一次「可见目录路径」，去冗余后作为 LIKE 前缀数组下发，
    // 由 `d.path LIKE ANY($patterns)` 走 path 的 text_pattern_ops 索引，
    // 避免旧写法 `d.path LIKE a.path || '%'`（每行拼接，逐文件嵌套扫描）。
    let patterns: Vec<String> = if user.is_admin {
        Vec::new()
    } else {
        let mut paths: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT d.path FROM directories d
            WHERE d.created_by = $1
               OR EXISTS (
                    SELECT 1 FROM grants g
                    WHERE g.directory_id = d.id
                      AND (g.perms & 1) > 0
                      AND (
                        (g.principal_type = 'user' AND g.principal_id = $1)
                        OR (g.principal_type = 'team'
                            AND g.principal_id IN (SELECT team_id FROM team_members WHERE user_id = $1))
                      )
               )
            "#,
        )
        .bind(user.id)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
        // 去冗余：按长度升序（祖先在前），已被前面前缀覆盖的路径不再单列
        paths.sort_by_key(|p| p.len());
        let mut kept: Vec<String> = Vec::new();
        for p in paths {
            if !kept
                .iter()
                .any(|k| p == *k || p.starts_with(&format!("{}/", k.trim_end_matches('/'))))
            {
                kept.push(p);
            }
        }
        kept.into_iter().map(|p| format!("{p}%")).collect()
    };
    if !user.is_admin && patterns.is_empty() {
        return Ok(Json(Vec::new()));
    }

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

    // 可见性谓词：管理员直通；非管理员把「可见前缀」展开成 OR 连接的 LIKE
    // （`LIKE ANY(array)` 走不了 text_pattern_ops 索引，展开成常量 LIKE 才能命中
    // idx_directories_path_pattern）。前缀过多（>64）时退回 ANY（正确但可能全扫）。
    let use_any = patterns.len() > 64;
    let mut conds = String::from("$3::bool");
    if use_any {
        conds.push_str(" OR d.path LIKE ANY($4::text[])");
    } else {
        for i in 0..patterns.len() {
            conds.push_str(&format!(" OR d.path LIKE ${}", 4 + i));
        }
    }
    let limit_pos = 4 + if use_any { 1 } else { patterns.len() };
    let sql = format!(
        r#"
        SELECT f.id, f.name, f.size, f.mime, f.directory_id, f.updated_at,
               (f.name ILIKE $1 || '%') AS is_prefix,
               similarity(f.name, $2) AS sim
        FROM files f
        JOIN directories d ON d.id = f.directory_id
        WHERE f.deleted_at IS NULL
          AND (f.name ILIKE '%' || $1 || '%' ESCAPE '\' OR similarity(f.name, $2) > 0.1)
          AND ({conds})
        ORDER BY (f.name ILIKE $1 || '%') DESC, similarity(f.name, $2) DESC, f.updated_at DESC
        LIMIT ${limit_pos}
        "#
    );

    let mut query = sqlx::query_as::<_, Row>(&sql)
        .bind(like)
        .bind(raw)
        .bind(user.is_admin);
    if use_any {
        query = query.bind(&patterns);
    } else {
        for p in &patterns {
            query = query.bind(p);
        }
    }
    let rows: Vec<Row> = query.bind(limit).fetch_all(pool).await.map_err(db_err)?;

    // id 基路径 → 名称路径：批量取命中目录的 path，再批量取各段名称
    let dir_ids: Vec<Uuid> = rows.iter().map(|r| r.directory_id).collect();
    let mut dir_path_by_id: std::collections::HashMap<Uuid, String> =
        std::collections::HashMap::new();
    let mut name_of: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if !dir_ids.is_empty() {
        let dir_rows: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id, path FROM directories WHERE id = ANY($1)")
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
            let names: Vec<(String, String)> =
                sqlx::query_as("SELECT id::text, name FROM directories WHERE id::text = ANY($1)")
                    .bind(&segments)
                    .fetch_all(pool)
                    .await
                    .map_err(db_err)?;
            for (id, name) in names {
                name_of.insert(id, name);
            }
        }
    }

    let display_path =
        |dir_id: Uuid, name_of: &std::collections::HashMap<String, String>| -> String {
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
