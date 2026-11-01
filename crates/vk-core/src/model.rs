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
    /// 凭证版本号（M2.41）：签发 JWT 时写入 claims.ver，认证时比对；
    /// 改密/禁用/删除/登出自增即可吊销该用户所有未过期 token。不对外序列化。
    #[serde(default, skip_serializing)]
    pub token_version: i32,
    /// 个人存储配额（字节）。`None` = 不限制（默认）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ldap_dn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_login_at: Option<DateTime<Utc>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
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
            email: self.email.clone(),
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub member_count: u32,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<DateTime<Utc>>,
}

/// 文件列表项：元数据 + 当前锁（未锁定为 None）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub file: FileMeta,
    pub lock: Option<FileLock>,
}

/// 目录列表项：子目录或文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EntryKind {
    /// 命名字段使 serde 序列化为 `{"kind":"directory","directory":{...}}`（与前端 Entry 类型一致）。
    Directory {
        directory: Directory,
    },
    File(FileEntry),
}

/// 锁定状态快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileLock {
    pub locked_by: Uuid,
    pub locked_by_name: String,
    pub locked_at: DateTime<Utc>,
}

/// 分享记录（文件或目录）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Share {
    pub id: Uuid,
    pub token: String,
    /// "file" | "directory"
    pub resource_type: String,
    pub resource_id: Uuid,
    pub password_hash: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    /// None = 不限
    pub max_downloads: Option<i32>,
    pub download_count: i32,
    pub access_count: i32,
    pub preview_only: bool,
    pub revoked: bool,
    /// "internal" | "external"（M2.24：内网 / 外网链接范围）
    pub scope: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

/// 目录网站发布记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedDir {
    pub id: Uuid,
    pub directory_id: Uuid,
    pub publish_id: String,
    pub enabled: bool,
    /// "anon" | "login" | "preview_only"
    pub policy: String,
    /// M2.26：站点访问密码 argon2 哈希（login 策略专用；不出前端）。
    #[serde(skip, default)]
    pub password_hash: Option<String>,
    /// M2.26：是否已设置站点密码（前端展示用，不暴露哈希）。
    #[serde(default)]
    pub has_password: bool,
    /// M2.28：站点模式 static（纯静态）| spa（try_files）| file_index（文件列表），默认 static。
    #[serde(default = "default_site_mode")]
    pub site_mode: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// M2.28：站点模式默认值（纯静态）。
pub fn default_site_mode() -> String {
    "static".into()
}
