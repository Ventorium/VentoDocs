//! vk-store：数据访问层（sqlx + PostgreSQL + 本地对象存储）。

pub mod object_store;
pub mod repo;

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use thiserror::Error;
use uuid::Uuid;

/// 根目录 ID（常量，与迁移脚本中的固定 UUID 一致）。
pub const ROOT_DIR_ID: &str = "00000000-0000-0000-0000-000000000001";
pub const ROOT_DIR: Uuid = Uuid::from_u128(1);

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("数据库错误：{0}")]
    Sqlx(#[from] sqlx::Error),

    #[error("资源不存在：{0}")]
    NotFound(String),

    #[error("名称冲突：{0}")]
    NameConflict(String),

    #[error("父目录不存在或已删除：{0}")]
    ParentInvalid(Uuid),

    #[error("不能修改根目录或系统目录")]
    RootProtected,

    #[error("文件已被他人锁定")]
    FileLocked,

    #[error("版本冲突：基线版本 {expected}，当前版本 {actual}")]
    VersionConflict { expected: u32, actual: u32 },

    #[error("操作对象处于回收站")]
    InTrash,

    #[error("输入无效：{0}")]
    InvalidInput(String),

    #[error("内部错误：{0}")]
    Internal(String),

    #[error("数据库迁移失败：{0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// 数据库连接池封装。
#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

impl Db {
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .connect(url)
            .await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// 执行全部迁移（幂等）。
    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("./migrations").run(&self.pool).await?;
        Ok(())
    }
}
