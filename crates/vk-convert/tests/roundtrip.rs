//! 往返测试（M2.2 writer）：Office → Univer 快照 → Office。
//!
//! 转换回写后由 python openpyxl / python-docx 复核关键内容
//! （公式 / 合并 / 工作表；标题 / 列表编号 / 表格）。
//! 依赖环境中装有 openpyxl / python-docx 的 python3，缺失时自动跳过。

use serde_json::Value;
use vk_convert::{convert, univer_to_office};

fn sample(name: &str) -> Vec<u8> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../poc/univer/samples/");
    let full = format!("{path}{name}");
    std::fs::read(&full).unwrap_or_else(|e| panic!("读取 {full} 失败：{e}"))
}

/// 运行 python 校验；解释器 / 依赖缺失时跳过，否则输出即结果。
fn run_python(code: &str, tag: &str) {
    let out = match std::process::Command::new("python3")
        .arg("-c")
        .arg(code)
        .output()
    {
        Ok(o) => o,
        Err(_) => {
            eprintln!("跳过 {tag}：python3 不可用");
            return;
        }
    };
    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        println!("{tag}:\n{stdout}");
        return;
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("ModuleNotFoundError") {
        eprintln!("跳过 {tag}：python 依赖缺失");
        return;
    }
    panic!("{tag} 校验失败：{stderr}");
}

#[test]
fn xlsx_roundtrip() {
    let bytes = sample("sample.xlsx");
    let snap: &Value = &convert(&bytes, "xlsx", "sample.xlsx").unwrap().snapshot;
    let out = univer_to_office(snap, "sheet", "sample.xlsx").expect("xlsx 回写失败");
    assert!(out.len() > 4 && out[0..2] == *b"PK", "输出不是 zip/xlsx");

    let tmp = std::env::temp_dir().join("vk-rt-sample.xlsx");
    std::fs::write(&tmp, &out).expect("写入临时文件失败");
    let tmp = tmp.to_string_lossy().into_owned();
    run_python(
        &format!(
            r#"
import openpyxl
wb = openpyxl.load_workbook(r"{tmp}")
assert "销售" in wb.sheetnames and "备注" in wb.sheetnames, wb.sheetnames
ws = wb["销售"]
formulas = [c.value for row in ws.iter_rows() for c in row
            if isinstance(c.value, str) and c.value.startswith("=")]
assert "=A1+B1" in formulas and "=E6*F6" in formulas, formulas
print("sheets:", wb.sheetnames)
print("公式 销售:", formulas)
print("合并 销售:", sorted(str(r) for r in ws.merged_cells.ranges))
ws2 = wb["备注"]
x = [c.value for row in ws2.iter_rows() for c in row
     if isinstance(c.value, str) and c.value.startswith("=")]
print("公式 备注:", x)
print("合并 备注:", sorted(str(r) for r in ws2.merged_cells.ranges))
print("XLSX ROUNDTRIP OK")
"#
        ),
        "xlsx 往返",
    );
}

#[test]
fn docx_roundtrip() {
    let bytes = sample("sample.docx");
    let snap: &Value = &convert(&bytes, "docx", "sample.docx").unwrap().snapshot;
    let out = univer_to_office(snap, "doc", "sample.docx").expect("docx 回写失败");
    assert!(out.len() > 4 && out[0..2] == *b"PK", "输出不是 zip/docx");

    let tmp = std::env::temp_dir().join("vk-rt-sample.docx");
    std::fs::write(&tmp, &out).expect("写入临时文件失败");
    let tmp = tmp.to_string_lossy().into_owned();
    run_python(
        &format!(
            r#"
import docx
from docx.oxml.ns import qn
d = docx.Document(r"{tmp}")
paras = d.paragraphs
headings = [p.text for p in paras if p.style.name.startswith("Heading")]
nums = [p for p in paras
        if p._p.pPr is not None and p._p.pPr.find(qn('w:numPr')) is not None]
tables = d.tables
assert headings, "缺少标题段落"
assert nums, "缺少列表编号段落"
assert tables, "缺少表格"
t = tables[0]
print("段落数:", len(paras))
print("标题:", headings[:6])
print("列表段落数:", len(nums))
print("表格数:", len(tables), "首表行数:", len(t.rows), "首行列数:", len(t.columns))
print("DOCX ROUNDTRIP OK")
"#
        ),
        "docx 往返",
    );
}
