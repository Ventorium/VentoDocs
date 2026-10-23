//! 统一错误类型。vk-core 只定义错误骨架，store/api 层通过 From 转换。

use thiserror::Error;

/// 领域错误（vk-core 层，不含 HTTP 语义）。
#[derive(Debug, Error)]
pub enum DomainError {
    #[error("资源不存在：{0}")]
    NotFound(String),

    #[error("无权限执行该操作")]
    Forbidden,

    #[error("文件已被 {0} 锁定")]
    FileLocked(String),

    #[error("版本冲突：期望 {expected}，实际 {actual}")]
    VersionConflict { expected: u64, actual: u64 },

    #[error("上传超过大小上限 {0} 字节")]
    UploadTooLarge(u64),

    #[error("分享链接已失效（过期/已撤销/次数用尽）")]
    ShareInvalid,

    #[error("分享密码错误")]
    SharePasswordWrong,

    #[error("站点发布功能未启用")]
    PublishDisabled,

    #[error("目标名称已存在：{0}")]
    NameConflict(String),

    #[error("操作对象处于回收站，需先恢复")]
    InTrash,

    #[error("内部错误：{0}")]
    Internal(String),
}
