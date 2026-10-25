//! 目录 API：浏览/创建/改名/移动/回收站 + 目录 ACL 管理。

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vk_core::model::{Directory, EntryKind};
use vk_core::perm::Perm;
use vk_store::repo::audit::Audit;
use vk_store::repo::directories::Directories;
use vk_store::repo::grants::Grants;
use vk_store::repo::users::Users;

use crate::AppState;
use crate::auth::AuthUser;
use crate::error::ApiError;

/// 检查用户对目录是否具有指定权限位。
async fn require_perm(
    pool: &sqlx::PgPool,
    user: &AuthUser,
    dir_id: Uuid,
    need: Perm,
) -> Result<(), ApiError> {
    let have = Grants::resolve(pool, user.id, dir_id, user.is_admin).await?;
    if have.contains(need) {
        Ok(())
    } else {
        Err(ApiError::forbidden("无权限执行该操作"))
    }
}

/// 目录页 = 目录信息 + 子项 + 当前用户有效权限位。
#[derive(Serialize)]
pub struct DirectoryPage {
    pub directory: Directory,
    pub children: Vec<EntryKind>,
    pub my_perms: u16,
}

async fn dir_page(
    state: &AppState,
    user: &AuthUser,
    dir_id: Uuid,
    need: Perm,
) -> Result<DirectoryPage, ApiError> {
    let pool = state.db.pool();
    require_perm(pool, user, dir_id, need).await?;
    let (directory, children) = Directories::list_children(pool, dir_id).await?;
    let my_perms = Grants::resolve(pool, user.id, dir_id, user.is_admin).await?;
    Ok(DirectoryPage {
        directory,
        children,
        my_perms: my_perms.bits(),
    })
}

pub async fn root(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<DirectoryPage>, ApiError> {
    let page = dir_page(&state, &user, vk_store::ROOT_DIR, Perm::READ_PREVIEW).await?;
    Ok(Json(page))
}

pub async fn get(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<DirectoryPage>, ApiError> {
    let page = dir_page(&state, &user, id, Perm::READ_PREVIEW).await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
pub struct CreateDirReq {
    pub parent_id: Uuid,
    pub name: String,
}

pub async fn create(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Json(body): Json<CreateDirReq>,
) -> Result<Json<Directory>, ApiError> {
    if body.name.trim().is_empty() {
        return Err(ApiError::bad_request("目录名不能为空"));
    }
    let pool = state.db.pool();
    require_perm(pool, &user, body.parent_id, Perm::CREATE_UPLOAD).await?;
    let dir = Directories::create(pool, body.parent_id, body.name.trim(), user.id).await?;
    Audit::log(
        pool,
        Some(user.id),
        "file",
        "dir_create",
        Some("directory"),
        Some(&dir.id.to_string()),
        serde_json::json!({ "parent_id": body.parent_id }),
        None,
    )
    .await?;
    Ok(Json(dir))
}

#[derive(Deserialize)]
pub struct RenameReq {
    pub name: String,
}

pub async fn rename(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<RenameReq>,
) -> Result<Json<Directory>, ApiError> {
    if body.name.trim().is_empty() {
        return Err(ApiError::bad_request("目录名不能为空"));
    }
    let pool = state.db.pool();
    require_perm(pool, &user, id, Perm::MODIFY_RENAME).await?;
    let dir = Directories::rename(pool, id, body.name.trim(), user.id, None).await?;
    Ok(Json(dir))
}

#[derive(Deserialize)]
pub struct MoveReq {
    pub target_parent_id: Uuid,
}

pub async fn move_dir(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<MoveReq>,
) -> Result<Json<Directory>, ApiError> {
    let pool = state.db.pool();
    // 源需 MOVE_COPY；目标需 CREATE_UPLOAD（在其下放入新项）
    require_perm(pool, &user, id, Perm::MOVE_COPY).await?;
    require_perm(pool, &user, body.target_parent_id, Perm::CREATE_UPLOAD).await?;
    let dir = Directories::move_to(pool, id, body.target_parent_id, user.id, None).await?;
    Ok(Json(dir))
}

pub async fn trash(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    require_perm(pool, &user, id, Perm::DELETE_RESTORE).await?;
    Directories::trash(pool, id, user.id, None).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn restore(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Directory>, ApiError> {
    let pool = state.db.pool();
    require_perm(pool, &user, id, Perm::DELETE_RESTORE).await?;
    let dir = Directories::restore(pool, id, user.id, None).await?;
    Ok(Json(dir))
}

/// 回收站目录项：目录信息 + 删除前的可读路径。
#[derive(Serialize)]
pub struct TrashedDirectory {
    #[serde(flatten)]
    pub directory: Directory,
    pub original_path: String,
}

pub async fn list_trashed(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
) -> Result<Json<Vec<TrashedDirectory>>, ApiError> {
    // 回收站仅展示当前用户可恢复（或管理员）的目录
    let pool = state.db.pool();
    let all = Directories::list_trashed(pool).await?;
    let mut out: Vec<Directory> = Vec::with_capacity(all.len());
    for d in all {
        let can = user.is_admin
            || d.created_by == Some(user.id)
            || Grants::resolve(pool, user.id, d.id, false)
                .await
                .is_ok_and(|p| p.contains(Perm::DELETE_RESTORE));
        if can {
            out.push(d);
        }
    }
    // 把 id 路径解析为可读名称路径
    let mut chain_ids: Vec<Uuid> = Vec::new();
    for d in &out {
        chain_ids.extend(Directories::parse_id_path(&d.path));
    }
    let names = Directories::names_by_ids(pool, &chain_ids).await?;
    let result: Vec<TrashedDirectory> = out
        .into_iter()
        .map(|d| {
            let ids = Directories::parse_id_path(&d.path);
            let parent_chain: Vec<Uuid> = ids.iter().take(ids.len().saturating_sub(1)).copied().collect();
            TrashedDirectory {
                original_path: Directories::render_id_path(&parent_chain, &names),
                directory: d,
            }
        })
        .collect();
    Ok(Json(result))
}

/// 授权管理入口：管理员或目录创建者。
async fn can_manage_grants(user: &AuthUser, dir: &Directory) -> Result<(), ApiError> {
    if user.is_admin || dir.created_by == Some(user.id) {
        Ok(())
    } else {
        Err(ApiError::forbidden("仅管理员或目录创建者可管理授权"))
    }
}

pub async fn list_grants(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let dir = Directories::get(pool, id).await?;
    can_manage_grants(&user, &dir).await?;
    let grants = Grants::list_for_directory(pool, id).await?;
    // 附带主体显示名，前端免二次请求
    let mut items: Vec<serde_json::Value> = Vec::with_capacity(grants.len());
    for g in grants.iter() {
        let name = if g.principal_type == "user" {
            Users::get_by_id(pool, g.principal_id)
                .await
                .ok()
                .map(|u| u.display_name)
                .unwrap_or_else(|| g.principal_id.to_string())
        } else {
            vk_store::repo::teams::Teams::get(pool, g.principal_id)
                .await
                .ok()
                .map(|t| t.name)
                .unwrap_or_else(|| g.principal_id.to_string())
        };
        items.push(serde_json::json!({
            "id": g.id,
            "directory_id": g.directory_id,
            "principal_type": g.principal_type,
            "principal_id": g.principal_id,
            "principal_name": name,
            "perms": g.perms,
            "created_at": g.created_at,
        }));
    }
    Ok(Json(serde_json::json!({ "grants": items })))
}

#[derive(Deserialize)]
pub struct SetGrantReq {
    pub principal_type: String,
    pub principal_id: Uuid,
    /// 权限位（前端仅发送用户可配置位；服务端校验保留位）
    pub perms: u16,
}

pub async fn set_grant(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<SetGrantReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    if body.principal_type != "user" && body.principal_type != "team" {
        return Err(ApiError::bad_request("principal_type 必须是 user 或 team"));
    }
    let perms = Perm::validate_ui_input(body.perms)?;
    let dir = Directories::get(pool, id).await?;
    can_manage_grants(&user, &dir).await?;
    // 主体必须存在
    match body.principal_type.as_str() {
        "user" => {
            Users::get_by_id(pool, body.principal_id).await?;
        }
        _ => {
            vk_store::repo::teams::Teams::get(pool, body.principal_id).await?;
        }
    }
    Grants::upsert(pool, id, &body.principal_type, body.principal_id, perms).await?;
    Audit::log(
        pool,
        Some(user.id),
        "admin",
        "grant_set",
        Some("directory"),
        Some(&id.to_string()),
        serde_json::json!({ "principal_type": body.principal_type, "principal_id": body.principal_id, "perms": body.perms }),
        None,
    )
    .await?;
    Ok(Json(
        serde_json::json!({ "ok": true, "perms": perms.bits() }),
    ))
}

pub async fn remove_grant(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    Path((id, ptype, pid)): Path<(Uuid, String, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pool = state.db.pool();
    let dir = Directories::get(pool, id).await?;
    can_manage_grants(&user, &dir).await?;
    Grants::remove(pool, id, &ptype, pid).await?;
    Audit::log(
        pool,
        Some(user.id),
        "admin",
        "grant_remove",
        Some("directory"),
        Some(&id.to_string()),
        serde_json::json!({ "principal_type": ptype, "principal_id": pid }),
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
