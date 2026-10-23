//! API 错误 → HTTP 响应映射。
//!
//! 响应体统一为 `{"error": {"code": "...", "message": "...", "details": {...}?}}`。
//! 码值见 docs/03-conventions.md「错误码」。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use vk_core::error::DomainError;
use vk_core::perm::PermError;
use vk_store::StoreError;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    details: Option<serde_json::Value>,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "未登录或登录已过期",
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "FORBIDDEN", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "CONFLICT", message)
    }

    /// 乐观锁版本冲突：details 携带 expected/actual 供前端提示「基于旧版本保存」。
    pub fn version_conflict(expected: u32, actual: u32) -> Self {
        let mut e = Self::new(
            StatusCode::CONFLICT,
            "VERSION_CONFLICT",
            "文件已被他人更新，请刷新后重试",
        );
        e.details = Some(json!({ "expected": expected, "actual": actual }));
        e
    }

    /// 持久锁冲突：details 携带锁定人信息。
    pub fn file_locked(details: Option<serde_json::Value>) -> Self {
        let mut e = Self::new(
            StatusCode::LOCKED,
            "FILE_LOCKED",
            "文件已被他人锁定，等待其解锁或联系管理员",
        );
        e.details = details;
        e
    }

    pub fn upload_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "UPLOAD_TOO_LARGE",
            "文件大小超过上传上限",
        )
    }

    /// 在线预览转换大小超限（20MB）。
    pub fn preview_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PREVIEW_TOO_LARGE",
            "文件过大，暂不支持在线预览，请下载后查看",
        )
    }

    pub fn publish_disabled() -> Self {
        Self::new(StatusCode::GONE, "PUBLISH_DISABLED", "发布站点已停用")
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", message)
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
            }
        });
        let text = body.to_string();
        (
            self.status,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )],
            text,
        )
            .into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound(msg) => ApiError::not_found(msg),
            StoreError::NameConflict(msg) => ApiError::conflict(msg),
            StoreError::ParentInvalid(id) => {
                ApiError::not_found(format!("目标目录 {id} 不存在或已被删除"))
            }
            StoreError::RootProtected => ApiError::bad_request("根目录不可执行该操作"),
            StoreError::FileLocked => ApiError::file_locked(None),
            StoreError::VersionConflict { expected, actual } => {
                ApiError::version_conflict(expected, actual)
            }
            StoreError::InTrash => ApiError::conflict("操作对象处于回收站，请先恢复"),
            StoreError::InvalidInput(msg) => ApiError::bad_request(msg),
            StoreError::Internal(msg) => {
                tracing::error!(error = %msg, "store 内部错误");
                ApiError::internal("服务器内部错误，请稍后重试")
            }
            StoreError::Migrate(msg) => {
                tracing::error!(error = %msg, "数据库迁移失败");
                ApiError::internal("数据库迁移失败，请检查服务配置")
            }
            StoreError::Sqlx(err) => {
                tracing::error!(error = %err, "SQL 错误");
                ApiError::internal("数据库操作失败，请稍后重试")
            }
        }
    }
}

impl From<DomainError> for ApiError {
    fn from(e: DomainError) -> Self {
        match e {
            DomainError::NotFound(msg) => ApiError::not_found(msg),
            DomainError::Forbidden => ApiError::forbidden("无权限执行该操作"),
            DomainError::FileLocked(name) => {
                ApiError::file_locked(Some(json!({ "locked_by_name": name })))
            }
            DomainError::VersionConflict { expected, actual } => {
                ApiError::version_conflict(expected as u32, actual as u32)
            }
            DomainError::UploadTooLarge(_) => ApiError::upload_too_large(),
            DomainError::ShareInvalid => ApiError::not_found("分享链接已失效"),
            DomainError::SharePasswordWrong => ApiError::new(
                StatusCode::UNAUTHORIZED,
                "SHARE_PASSWORD_WRONG",
                "分享密码错误",
            ),
            DomainError::PublishDisabled => ApiError::publish_disabled(),
            DomainError::NameConflict(msg) => ApiError::conflict(msg),
            DomainError::InTrash => ApiError::conflict("操作对象处于回收站，请先恢复"),
            DomainError::Internal(msg) => {
                tracing::error!(error = %msg, "领域内部错误");
                ApiError::internal("服务器内部错误，请稍后重试")
            }
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "未分类错误");
        ApiError::internal("服务器内部错误，请稍后重试")
    }
}

impl From<PermError> for ApiError {
    fn from(e: PermError) -> Self {
        match e {
            PermError::ReservedBits(bits) => {
                ApiError::bad_request(format!("权限位 {bits:?} 包含保留位，v1 不可设置"))
            }
        }
    }
}

impl From<jsonwebtoken::errors::Error> for ApiError {
    fn from(_e: jsonwebtoken::errors::Error) -> Self {
        ApiError::unauthorized()
    }
}

impl From<axum::extract::rejection::JsonRejection> for ApiError {
    fn from(_e: axum::extract::rejection::JsonRejection) -> Self {
        ApiError::bad_request("请求体不是合法 JSON 或缺少必填字段")
    }
}
