//! 领域实体（纯数据，无 I/O）。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthProvider {
    Local,
    Ldap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub password_hash: Option<String>,
    pub auth_provider: AuthProvider,
    pub role: Role,
    pub disabled: bool,
    pub created_at: DateTime<Utc>,
}

/// 对外公开的用户视图（不含密码哈希，供 API 序列化）。
#[derive(Debug, Clone, Serialize)]
pub struct UserPublic {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub auth_provider: AuthProvider,
    pub role: Role,
    pub disabled: bool,
    pub created_at: DateTime<Utc>,
}

impl User {
    pub fn to_public(&self) -> UserPublic {
        UserPublic {
            id: self.id,
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            auth_provider: self.auth_provider,
            role: self.role,
            disabled: self.disabled,
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directory {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub path: String,
    pub is_trash: bool,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub id: Uuid,
    pub directory_id: Uuid,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub current_version: u32,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 目录列表项：子目录或文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EntryKind {
    Directory(Directory),
    File(FileMeta),
}

/// 锁定状态快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileLock {
    pub locked_by: Uuid,
    pub locked_by_name: String,
    pub locked_at: DateTime<Utc>,
}
