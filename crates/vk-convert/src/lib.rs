//! vk-convert：Office / CSV 字节流 ↔ Univer 数据模型快照（纯同步）。
//!
//! - 正向（M2.1 只读预览）：[convert]，Office / CSV → Univer 快照；
//! - 反向（M2.2 在线编辑保存）：[univer_to_office]，Univer 快照 → xlsx / docx。
//!
//! 支持格式与保真度（详见 docs/poc/univer-matrix.md）：
//! - xlsx：值 / 公式 / 合并单元格 / 列宽行高 / 基础样式（粗斜体下划线、字体颜色、
//!   背景色、边框、对齐、换行）；图片、图表、条件格式、数据验证丢弃。
//! - xls：仅值与合并单元格（无样式、无公式）。
//! - csv / tsv：全部为文本。
//! - docx：正文段落 / 标题级别 / 有序无序列表 / 表格 / 页面尺寸 / 默认字体；
//!   图片、页眉页脚、脚注尾注、文本框丢弃。

pub mod doc;
pub mod formula;
pub mod sheet;
pub mod univer;
mod zipxml;

pub use univer::univer_to_office;

use serde::Serialize;
use serde_json::Value;

/// 单个工作簿单元格数上限（防超大文件打爆内存）。
pub const MAX_CELLS: u64 = 1_000_000;

#[derive(Debug, thiserror::Error)]
pub enum ConvertError {
    #[error("不支持的文件格式")]
    UnsupportedFormat,
    #[error("文件过大，请下载查看")]
    TooLarge,
    #[error("文件解析失败：{0}")]
    Parse(String),
}

/// 转换结果：Univer 单元类型 + 数据模型快照。
#[derive(Debug, Clone, Serialize)]
pub struct UniverSnapshot {
    /// "sheet" | "doc"
    pub unit_type: &'static str,
    pub snapshot: Value,
}

/// 将文件字节转换为 Univer 快照。`ext` 为不带点的小写扩展名
/// （xlsx / xlsm / xls / csv / tsv / docx）。
pub fn convert(bytes: &[u8], ext: &str, file_name: &str) -> Result<UniverSnapshot, ConvertError> {
    if bytes.is_empty() {
        return Err(ConvertError::Parse("空文件".into()));
    }
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "xlsx" | "xlsm" => sheet::xlsx_workbook(bytes, file_name).map(|snapshot| UniverSnapshot {
            unit_type: "sheet",
            snapshot,
        }),
        "xls" => sheet::xls_workbook(bytes, file_name).map(|snapshot| UniverSnapshot {
            unit_type: "sheet",
            snapshot,
        }),
        "csv" => sheet::csv_workbook(bytes, file_name, b',').map(|snapshot| UniverSnapshot {
            unit_type: "sheet",
            snapshot,
        }),
        "tsv" => sheet::csv_workbook(bytes, file_name, b'\t').map(|snapshot| UniverSnapshot {
            unit_type: "sheet",
            snapshot,
        }),
        "docx" => doc::document(bytes, file_name).map(|snapshot| UniverSnapshot {
            unit_type: "doc",
            snapshot,
        }),
        _ => Err(ConvertError::UnsupportedFormat),
    }
}

/// 该扩展名是否可转换为 Univer 快照。
pub fn is_supported(ext: &str) -> bool {
    matches!(
        ext.trim_start_matches('.').to_ascii_lowercase().as_str(),
        "xlsx" | "xlsm" | "xls" | "csv" | "tsv" | "docx"
    )
}
