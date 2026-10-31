//! 目录 API：浏览/创建/改名/移动/回收站 + 目录 ACL 管理。

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vk_core::model::{Directory, EntryKind, FileEntry, FileLock, FileMeta};
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
    // 根目录只是入口容器：任何登录用户可读（列表由 dir_page 按授权过滤），
    // 且可在根下创建自己的顶级条目（创建后默认仅创建者可见，不影响他人）；
    // 其余操作位仍走正常授权链。
    if dir_id == vk_store::ROOT_DIR && (need == Perm::READ_PREVIEW || need == Perm::CREATE_UPLOAD) {
        return Ok(());
    }
    let have = Grants::resolve(pool, user.id, dir_id, user.is_admin).await?;
    if have.contains(need) {
        Ok(())
    } else {
        Err(ApiError::forbidden("无权限执行该操作"))
    }
}

/// 目录页子项 = EntryKind 序列化形状 + 当前用户在该子项上的授权权限位（M2.36）。
/// my_perms 不含管理员旁路（目录创建者/文件创建者恒为 ALL）：前端据此
/// 对他人共享的条目按「实际授权」动态显隐菜单与操作按钮，而非按管理员 1023。
#[derive(Serialize)]
#[serde(untagged)]
pub enum PageEntry {
    Directory {
        kind: &'static str,
        directory: Directory,
        my_perms: u16,
    },
    File {
        kind: &'static str,
        file: FileMeta,
        lock: Option<FileLock>,
        my_perms: u16,
    },
}

/// 目录页 = 目录信息 + 子项（含逐子项授权位） + 当前用户有效权限位。
#[derive(Serialize)]
pub struct DirectoryPage {
    pub directory: Directory,
    pub children: Vec<PageEntry>,
    pub my_perms: u16,
    /// M2.36：当前目录的授权权限位（不含管理员旁路；根目录与 require_perm 一致补 RP|CU）——
    /// 前端按实际授权显隐「新建目录 / 上传文件」等列级操作。
    pub granted_perms: u16,
}

async fn dir_page(
    state: &AppState,
    user: &AuthUser,
    dir_id: Uuid,
    need: Perm,
) -> Result<DirectoryPage, ApiError> {
    let pool = state.db.pool();
    require_perm(pool, user, dir_id, need).await?;
    let (directory, mut children) = Directories::list_children(pool, dir_id).await?;
    // 个人根视图（M2.38：对管理员同样生效）：只列出自己创建的顶层目录与自己上传的根文件。
    // 他人上传的根文件无授权链、不可读，直接排除；
    // 被分享的目录/深层内容一律走「团队共享 / 分享给我」栏位，不混入「个人文件」。
    if dir_id == vk_store::ROOT_DIR {
        children.retain(|e| match e {
            EntryKind::Directory { directory } => directory.created_by == Some(user.id),
            EntryKind::File(FileEntry { file, .. }) => file.created_by == Some(user.id),
        });
    }
    let mut my_perms = Grants::resolve(pool, user.id, dir_id, user.is_admin).await?;
    // 根目录是入口容器：任何登录用户可读并可在根下创建自己的顶级条目（与 require_perm 一致），
    // 否则 UI 会隐藏「新建目录 / 上传文件」按钮，非管理员的个人视图将永远为空。
    if !user.is_admin && dir_id == vk_store::ROOT_DIR {
        my_perms.insert(Perm::READ_PREVIEW | Perm::CREATE_UPLOAD);
    }
    // M2.36：当前目录的授权权限位（不含管理员旁路）——根目录与 require_perm 一致补 RP|CU，
    // 供前端按「实际授权」显隐「新建目录 / 上传文件」等列级操作。
    let granted_perms = if dir_id == vk_store::ROOT_DIR {
        Grants::resolve(pool, user.id, dir_id, false)
            .await?
            .union(Perm::READ_PREVIEW | Perm::CREATE_UPLOAD)
    } else {
        Grants::resolve(pool, user.id, dir_id, false).await?
    };
    // M2.36：逐个计算子项的授权权限位（不含管理员旁路；创建者恒为 ALL），
    // 前端右键菜单 / 行内操作据此动态显隐。目录数通常较小，N+1 可接受。
    let mut children_out: Vec<PageEntry> = Vec::with_capacity(children.len());
    for entry in &children {
        let child_perms = match entry {
            EntryKind::Directory { directory } => {
                Grants::resolve(pool, user.id, directory.id, false)
                    .await?
                    .bits()
            }
            EntryKind::File(FileEntry { file, .. }) => {
                Grants::resolve_for_file(pool, user.id, file.id, false)
                    .await?
                    .bits()
            }
        };
        children_out.push(match entry {
            EntryKind::Directory { directory } => PageEntry::Directory {
                kind: "directory",
                directory: directory.clone(),
                my_perms: child_perms,
            },
            EntryKind::File(FileEntry { file, lock }) => PageEntry::File {
                kind: "file",
                file: file.clone(),
                lock: lock.clone(),
                my_perms: child_perms,
            },
        });
    }
    Ok(DirectoryPage {
        directory,
        children: children_out,
        my_perms: my_perms.bits(),
        granted_perms: granted_perms.bits(),
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

/// 授权管理入口：仅目录创建者（M2.35：管理员不再拥有管理他人目录授权的旁路，
/// 授权/分享等管理操作一律回归资源创建者本人；管理员的内容访问旁路不受影响）。
pub async fn can_manage_grants(user: &AuthUser, dir: &Directory) -> Result<(), ApiError> {
    if dir.created_by == Some(user.id) {
        Ok(())
    } else {
        Err(ApiError::forbidden("仅目录创建者可管理授权"))
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

/// 分享栏查询参数：scope=me 分享给我 / scope=team 团队共享。
#[derive(Deserialize)]
pub struct SharedQuery {
    pub scope: String,
}

#[derive(Serialize)]
pub struct SharedDirOut {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub parent_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub owner_name: Option<String>,
    pub team_name: Option<String>,
    pub perms: u16,
}

/// 分享给我的目录列表（文件管理器左侧「团队共享 / 分享给我」栏位数据源）。
pub async fn shared(
    State(state): State<AppState>,
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    axum::extract::Query(q): axum::extract::Query<SharedQuery>,
) -> Result<Json<Vec<SharedDirOut>>, ApiError> {
    if q.scope != "me" && q.scope != "team" {
        return Err(ApiError::bad_request("scope 必须是 me 或 team"));
    }
    let pool = state.db.pool();
    let dirs = Grants::list_shared(pool, user.id, &q.scope).await?;
    Ok(Json(
        dirs.iter()
            .map(|d| SharedDirOut {
                id: d.id,
                name: d.name.clone(),
                path: d.path.clone(),
                parent_id: d.parent_id,
                created_by: d.created_by,
                owner_name: d.owner_name.clone(),
                team_name: d.team_name.clone(),
                perms: d.perms,
            })
            .collect(),
    ))
}
