//! 权限位模型（需求 §8.2）。
//!
//! 授权只存在于目录上（grants 表），文件的权限沿祖先路径链对
//! user 与 team 两条链分别取并集；创建者恒等于 ALL；管理员旁路。
//! 10 个权限位与需求一一对应，AGENT_* 为 v2 预留（v1 界面不暴露、默认 0）。

use bitflags::bitflags;

bitflags! {
    /// 权限位集合。u16：10 位实际使用，预留扩展空间。
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
    pub struct Perm: u16 {
        /// 预览/在线阅读（不含原始文件下载）
        const READ_PREVIEW     = 1 << 0;
        /// 下载原始文件
        const DOWNLOAD         = 1 << 1;
        /// 上传/新建文件
        const CREATE_UPLOAD    = 1 << 2;
        /// 重命名、在线编辑保存
        const MODIFY_RENAME    = 1 << 3;
        /// 移动/复制
        const MOVE_COPY        = 1 << 4;
        /// 删除（进回收站）、恢复
        const DELETE_RESTORE   = 1 << 5;
        /// 创建/管理分享（M2.35 起不再可授权：仅资源创建者可操作）
        const SHARE            = 1 << 6;
        /// 开启/关闭目录网站发布（M2.35 起不再可授权：仅目录创建者可操作）
        const PUBLISH          = 1 << 7;
        /// Agent 读取文件内容（v2）
        const AGENT_READ       = 1 << 8;
        /// Agent 写入文件（v2，还需满足锁定/版本规则）
        const AGENT_WRITE      = 1 << 9;
    }
}

impl Perm {
    /// v1 界面可配置的 6 位（不含 AGENT_*；M2.35 起分享/发布不再可授权，
    /// 一律回归资源创建者本人）。
    pub fn user_configurable() -> Self {
        Self::READ_PREVIEW
            | Self::DOWNLOAD
            | Self::CREATE_UPLOAD
            | Self::MODIFY_RENAME
            | Self::MOVE_COPY
            | Self::DELETE_RESTORE
    }

    /// 校验 UI 提交值：只允许 user_configurable 子集（含任一不可授权位即拒绝）。
    /// M2.35：修复旧实现 `contains(complement)` 仅在全部保留位同时出现时才报错的缺陷。
    pub fn validate_ui_input(value: u16) -> Result<Self, PermError> {
        let set = Self::from_bits_retain(value);
        if set.intersects(Self::user_configurable().complement()) {
            return Err(PermError::ReservedBits(set));
        }
        Ok(set)
    }

    /// 目录树继承聚合：把当前目录 grants 解析出的权限位合并进累加器。
    pub fn fold(self, acc: &mut Perm) {
        *acc |= self;
    }
}

/// 目录树权限解析输入（由 store 层查询填充，core 做纯计算）。
#[derive(Debug, Clone, Default)]
pub struct DirChain {
    /// 根到当前目录（含）每一层：`((user 授权位), (team 授权位))` 的并集结果。
    pub layers: Vec<(Perm, Perm)>,
}

impl DirChain {
    /// 计算最终权限：user 链并集 ∪ team 链并集。
    ///
    /// 需求 §8.2 定案：个人与团队授权按位并集，无"拒绝"位。
    pub fn resolve(&self, is_admin: bool) -> Perm {
        if is_admin {
            return Perm::all();
        }
        let mut user_bits = Perm::empty();
        let mut team_bits = Perm::empty();
        for (u, t) in &self.layers {
            user_bits |= *u;
            team_bits |= *t;
        }
        user_bits | team_bits
    }
}

/// 创建者/管理员的目录链（无 grants 记录时也恒 ALL）。
pub fn creator_chain() -> DirChain {
    DirChain {
        layers: vec![(Perm::all(), Perm::all())],
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PermError {
    #[error("包含保留权限位（v2 未开放）：{0:?}")]
    ReservedBits(Perm),
}
