//! 集成测试：与 poc/univer/samples/univer/*.json 对齐验证。
//!
//! 对比策略（POC 生成器做了风格化归一化，Rust 侧解析真实文档值）：
//! - 结构必须一致：工作表顺序、单元格值/公式/类型、合并区域、段落 startIndex、
//!   标题、表格哨兵、dataStream 长度与文本；
//! - 风格值不对比：单元格样式 s、文档默认样式、标题字号、列表 listType 的具体形态
//!   （POC 对列表硬编码了 list-1，Rust 侧解析真实 numId）。

use serde_json::{Value, json};
use vk_convert::convert;

fn sample(name: &str) -> Vec<u8> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../poc/univer/samples/");
    let full = format!("{path}{name}");
    std::fs::read(&full).unwrap_or_else(|e| panic!("读取 {full} 失败：{e}"))
}

fn univer_sample(name: &str) -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../poc/univer/samples/univer/");
    let full = format!("{path}{name}");
    let s = std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("读取 {full} 失败：{e}"));
    serde_json::from_str(&s).unwrap()
}

/// 按工作表显示名索引 sheets（双方 key 都是随机 ID，不可直接对比）。
fn sheets_by_name(wb: &Value) -> std::collections::BTreeMap<String, &Value> {
    let mut out = std::collections::BTreeMap::new();
    for s in wb["sheets"].as_object().unwrap().values() {
        out.insert(s["name"].as_str().unwrap().to_string(), s);
    }
    out
}

#[test]
fn xlsx_matches_sample_shape() {
    let bytes = sample("sample.xlsx");
    let snap = convert(&bytes, "xlsx", "sample.xlsx").unwrap();
    assert_eq!(snap.unit_type, "sheet");

    let ref_sheet = univer_sample("sheet-sample.json");
    let wb = &snap.snapshot;

    // 顶层字段
    for key in ["id", "name", "appVersion", "locale", "styles", "sheetOrder", "sheets"] {
        assert!(wb.get(key).is_some(), "缺少顶层字段 {key}");
    }
    assert_eq!(wb["locale"], "zhCN");
    assert_eq!(wb["name"], "sample.xlsx");

    let ref_by_name = sheets_by_name(&ref_sheet);
    let my_by_name = sheets_by_name(wb);

    // 工作表名称与顺序（ref 的 sheets 以随机 ID 为键，sheetOrder 存 ID）
    let ref_order: Vec<String> = ref_sheet["sheetOrder"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            ref_sheet["sheets"][id.as_str().unwrap()]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    // 与 ref 一致：sheets 以 sheet id 为键，sheetOrder 存 id，按 name 解析后比较
    let my_order: Vec<String> = wb["sheetOrder"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            wb["sheets"][id.as_str().unwrap()]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(my_order, vec!["销售".to_string(), "备注".to_string()]);
    assert_eq!(my_order, ref_order, "工作表顺序不一致");

    for name in &my_order {
        let ref_s = &ref_by_name[name];
        let my_s = &my_by_name[name];

        // 表级字段
        assert_eq!(my_s["name"], name.as_str());
        assert_eq!(my_s["rowCount"], ref_s["rowCount"], "{name} rowCount 不一致");
        assert_eq!(
            my_s["columnCount"], ref_s["columnCount"],
            "{name} columnCount 不一致"
        );
        assert_eq!(
            my_s["defaultColumnWidth"], ref_s["defaultColumnWidth"],
            "{name} defaultColumnWidth 不一致"
        );
        assert_eq!(
            my_s["defaultRowHeight"], ref_s["defaultRowHeight"],
            "{name} defaultRowHeight 不一致"
        );

        let ref_cells = &ref_s["cellData"];
        let my_cells = &my_s["cellData"];

        // ref 中每个单元格必须存在且值/类型一致（数值容差：f64 相等）
        for (r, ref_row) in ref_cells.as_object().unwrap() {
            for (c, ref_cell) in ref_row.as_object().unwrap() {
                let my_cell = &my_cells[r][c];
                assert!(!my_cell.is_null(), "缺少单元格 {name} [{r},{c}]");
                let rt = ref_cell["t"].as_u64();
                let mt = my_cell["t"].as_u64();
                assert_eq!(mt, rt, "单元格类型不一致 {name} [{r},{c}]");
                match rt {
                    Some(2) => {
                        let rv = ref_cell["v"].as_f64();
                        let mv = my_cell["v"].as_f64();
                        assert!(
                            rv.is_some() && mv.is_some() && rv.unwrap() == mv.unwrap(),
                            "数值不一致 {name} [{r},{c}] ref={:?} my={:?}",
                            ref_cell["v"],
                            my_cell["v"]
                        );
                    }
                    Some(1) | Some(3) => {
                        assert_eq!(
                            my_cell["v"], ref_cell["v"],
                            "值不一致 {name} [{r},{c}]"
                        );
                    }
                    _ => {
                        assert_eq!(my_cell["v"], ref_cell["v"], "值不一致 {name} [{r},{c}]");
                    }
                }
                // 公式一致且带前导 =
                if let Some(f) = ref_cell.get("f") {
                    assert_eq!(my_cell["f"], *f, "公式不一致 {name} [{r},{c}]");
                }
            }
        }

        // 我方不得多出带值/公式的单元格
        for (r, my_row) in my_cells.as_object().unwrap() {
            for (c, my_cell) in my_row.as_object().unwrap() {
                if ref_cells[r][c].is_null() {
                    let has_value = my_cell.get("v").is_some();
                    let has_formula = my_cell.get("f").is_some();
                    assert!(
                        !has_value && !has_formula,
                        "多余单元格 {name} [{r},{c}]: {my_cell}"
                    );
                }
            }
        }

        // 我方所有公式必须带前导 =
        for (r, my_row) in my_cells.as_object().unwrap() {
            for (c, my_cell) in my_row.as_object().unwrap() {
                if let Some(f) = my_cell.get("f").and_then(|v| v.as_str()) {
                    assert!(f.starts_with('='), "公式缺少前导 = : {name} [{r},{c}] {f}");
                }
            }
        }

        // 合并区域（集合比较，顺序无关）
        let mut ref_merges: Vec<Value> = ref_s["mergeData"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                json!([m["startRow"], m["startColumn"], m["endRow"], m["endColumn"]])
            })
            .collect();
        let mut my_merges: Vec<Value> = my_s["mergeData"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                json!([m["startRow"], m["startColumn"], m["endRow"], m["endColumn"]])
            })
            .collect();
        ref_merges.sort_by_key(|v| v.to_string());
        my_merges.sort_by_key(|v| v.to_string());
        assert_eq!(my_merges, ref_merges, "合并区域不一致 {name}");
    }

    // 抽查公式
    let s1 = &my_by_name["销售"];
    assert_eq!(s1["cellData"]["1"]["0"]["f"], "=A1+B1");
    assert_eq!(s1["cellData"]["5"]["6"]["f"], "=E6*F6");
    let s2 = &my_by_name["备注"];
    assert_eq!(s2["cellData"]["1"]["1"]["f"], "=销售!A2+销售!G6+销售!G7");
    assert_eq!(s2["cellData"]["1"]["1"]["v"], json!(1002));
    assert_eq!(s2["cellData"]["2"]["1"]["f"], "=销售!A2*2");
    assert_eq!(s2["cellData"]["2"]["1"]["v"], json!(84));
}

#[test]
fn docx_matches_sample_shape() {
    let bytes = sample("sample.docx");
    let snap = convert(&bytes, "docx", "sample.docx").unwrap();
    assert_eq!(snap.unit_type, "doc");
    let doc = &snap.snapshot;

    let ref_doc = univer_sample("doc-sample.json");

    // 顶层字段
    for key in ["id", "title", "documentStyle", "styles", "lists", "body", "tableSource"] {
        assert!(doc.get(key).is_some(), "缺少顶层字段 {key}");
    }
    assert_eq!(doc["title"], "sample.docx");

    let ds = doc["body"]["dataStream"].as_str().unwrap().to_string();
    let ref_ds = ref_doc["body"]["dataStream"].as_str().unwrap().to_string();
    assert!(
        ds.ends_with('\0'),
        "dataStream 必须以 \\0 结尾"
    );
    assert_eq!(
        ds.len(),
        ref_ds.len(),
        "dataStream 长度不一致（ref {} vs my {}）\nref: {ref_ds:#?}\nmy:  {ds:#?}",
        ref_ds.len(),
        ds.len()
    );

    // 表格哨兵
    let ref_tables = ref_doc["body"]["tables"].as_array().unwrap();
    let my_tables = doc["body"]["tables"].as_array().unwrap();
    assert_eq!(my_tables.len(), ref_tables.len(), "表格数量不一致");
    for (i, t) in ref_tables.iter().enumerate() {
        let my = &my_tables[i];
        assert_eq!(my["startIndex"], t["startIndex"], "表格 {i} startIndex 不一致");
        assert_eq!(my["endIndex"], t["endIndex"], "表格 {i} endIndex 不一致");
        let tid = t["tableId"].as_str().unwrap();
        assert_eq!(my["tableId"], tid);
        assert!(doc["tableSource"].get(tid).is_some(), "缺少 tableSource[{tid}]");
    }
    // 哨兵字符
    assert_eq!(ds.chars().nth(156), Some('\r'), "表格前段落结束应为 \\r");
    assert_eq!(ds.chars().nth(157), Some('\x1a'), "表格起始哨兵应为 \\x1a");
    assert_eq!(ds.chars().nth(202), Some('\x1f'), "表格结束哨兵应为 \\x1f");

    // 段落
    let ref_paras = ref_doc["body"]["paragraphs"].as_array().unwrap();
    let my_paras = doc["body"]["paragraphs"].as_array().unwrap();
    assert_eq!(
        my_paras.len(),
        18,
        "段落数量应为 18，实际 {}",
        my_paras.len()
    );
    assert_eq!(
        my_paras.len(),
        ref_paras.len(),
        "段落数量与 ref 不一致"
    );
    for (i, (rp, mp)) in ref_paras.iter().zip(my_paras.iter()).enumerate() {
        assert_eq!(
            mp["startIndex"], rp["startIndex"],
            "段落 {i} startIndex 不一致（ref {} vs my {}）",
            rp["startIndex"], mp["startIndex"]
        );
        if let Some(h) = rp.pointer("/paragraphStyle/headingId") {
            assert_eq!(
                mp.pointer("/paragraphStyle/headingId"),
                Some(h),
                "段落 {i} headingId 不一致"
            );
        } else {
            assert!(
                mp.get("paragraphStyle").and_then(|p| p.get("headingId")).is_none(),
                "段落 {i} 不应有 headingId"
            );
        }
        if let Some(rb) = rp.get("bullet") {
            let mb = mp
                .get("bullet")
                .unwrap_or_else(|| panic!("段落 {i} 缺少 bullet"));
            assert_eq!(mb["nestingLevel"], rb["nestingLevel"], "段落 {i} nestingLevel");
            // POC 对列表硬编码 list-1；Rust 侧解析真实 numId（ListNumber→5, ListBullet→1）。
            // 只要求 listType 存在于 lists 声明中且 listId 非 0。
            let lt = mb["listType"].as_str().unwrap();
            assert!(
                doc["lists"].get(lt).is_some(),
                "段落 {i} 的 listType {lt} 未在 lists 中声明"
            );
            assert!(
                mb["listId"].as_u64().unwrap_or(0) > 0,
                "段落 {i} listId 异常"
            );
            // 样例中的期望：条目一/二 是 ListNumber 样式（numId 5），条目三是 ListBullet（numId 1）
            let expected_num_id = if i == 10 { 1 } else { 5 };
            assert_eq!(
                mb["listId"],
                json!(expected_num_id),
                "段落 {i} listId 应为 {expected_num_id}"
            );
        } else {
            assert!(mp.get("bullet").is_none(), "段落 {i} 不应有 bullet");
        }
        // 段落终止字符：普通段落 \r，表格后段落 \x1f
        let idx = mp["startIndex"].as_u64().unwrap() as usize;
        let ch = ds.chars().nth(idx).unwrap();
        assert!(
            ch == '\r' || ch == '\x1f',
            "段落 {i} startIndex 位置字符异常: {ch:?}"
        );
    }

    // 各段主要文本按出现顺序存在
    let texts = [
        "Univer POC 样例文档",
        "（目录将在打开文档时更新）",
        "第一章 概述",
        "这是第一级段落，用于验证普通正文样式。",
        "第一节 背景",
        "这是二级标题下的段落。",
        "1.1 小节",
        "这是三级标题下的段落，带一个脚注。",
        "编号列表条目一",
        "编号列表条目二",
        "项目符号条目",
        "这是一个带尾注的段落。",
        "第二章 表格",
        "下面是一个 3x3 表格：",
        "姓名",
        "单价",
        "120",
        "3.5",
        "第三章 图片",
        "下面是一张示例图片：",
        "图片之后的段落。",
    ];
    let mut last = 0usize;
    for t in texts {
        let pos = ds
            .find(t)
            .unwrap_or_else(|| panic!("dataStream 缺少文本 {t:?}"));
        assert!(pos >= last, "文本顺序异常: {t:?}");
        last = pos;
    }

    // 标题样式声明
    for h in ["h1", "h2", "h3"] {
        assert!(doc["styles"].get(h).is_some(), "缺少样式 {h}");
        assert_eq!(doc["styles"][h]["paragraphStyle"]["headingId"], h);
    }

    // Univer 1.2.0 INestingLevel 契约（i-document-data.d.ts）：
    // - 项目符号列表（ListBullet → numId 1）：glyphSymbol 字面字符；
    //   样例 lvlText 为 Wingdings PUA \u{f0b7}，归一为 "●"。
    // - 有序列表（ListNumber → numId 5）：glyphType = ListGlyphType::DECIMAL (2) + startNumber。
    let list1 = &doc["lists"]["list-1"]["nestingLevel"][0];
    assert_eq!(list1["glyphSymbol"], json!("●"), "list-1 应为 glyphSymbol 项目符号");
    assert!(
        list1.get("glyphType").is_none(),
        "项目符号列表不应携带 glyphType"
    );
    let list5 = &doc["lists"]["list-5"]["nestingLevel"][0];
    assert_eq!(
        list5["glyphType"],
        json!(2),
        "decimal 应为 ListGlyphType::DECIMAL(2)"
    );
    assert!(
        list5.get("glyphSymbol").is_none(),
        "有序列表不应携带 glyphSymbol"
    );
    for nesting in [list1, list5] {
        assert_eq!(nesting["bulletAlignment"], json!(0));
        assert_eq!(nesting["startNumber"], json!(1));
        assert!(
            nesting.get("glyphFormat").is_some(),
            "glyphFormat 为必填字段"
        );
    }
}

#[test]
fn csv_basic() {
    let bytes = "姓名,年龄,备注\n张三,30,\"含,逗号\"\n李四,25,普通\n"
        .as_bytes();
    let snap = convert(bytes, "csv", "数据.csv").unwrap();
    let wb = &snap.snapshot;
    let sheet = &wb["sheets"][wb["sheetOrder"][0].as_str().unwrap()];
    assert_eq!(sheet["name"], "数据");
    assert_eq!(sheet["cellData"]["0"]["0"]["v"], "姓名");
    assert_eq!(sheet["cellData"]["0"]["0"]["t"], json!(1));
    assert_eq!(sheet["cellData"]["1"]["0"]["v"], "张三");
    assert_eq!(sheet["cellData"]["1"]["2"]["v"], "含,逗号");
    assert_eq!(sheet["cellData"]["2"]["1"]["v"], "25");
    // 空字段不产生单元格
    assert!(sheet["cellData"].as_object().unwrap().len() == 3);
    for row in sheet["cellData"].as_object().unwrap().values() {
        assert!(row.get("1").is_none() || row["1"]["v"] != "");
    }
}

#[test]
fn csv_bom_and_gbk() {
    // UTF-8 BOM
    let bytes = vec![0xEF, 0xBB, 0xBF, b'a', b',', b'b', b'\n', b'1', b',', b'2'];
    let snap = convert(&bytes, "csv", "bom.csv").unwrap();
    let cells = &snap.snapshot["sheets"][snap.snapshot["sheetOrder"][0]
        .as_str()
        .unwrap()]["cellData"];
    assert_eq!(cells["0"]["0"]["v"], "a");

    // GB18030：中文「中文」= D6 D0 CE C4
    let bytes: Vec<u8> = [b'x', b',', 0xD6, 0xD0, 0xCE, 0xC4, b'\n'].to_vec();
    let snap = convert(&bytes, "csv", "gbk.csv").unwrap();
    let cells = &snap.snapshot["sheets"][snap.snapshot["sheetOrder"][0]
        .as_str()
        .unwrap()]["cellData"];
    assert_eq!(cells["0"]["0"]["v"], "x");
    assert_eq!(cells["0"]["1"]["v"], "中文");
}

#[test]
fn unsupported_ext() {
    let bytes = b"whatever";
    let e = convert(bytes, "pptx", "a.pptx").unwrap_err();
    assert!(matches!(e, vk_convert::ConvertError::UnsupportedFormat));
    let e = convert(bytes, "doc", "a.doc").unwrap_err();
    assert!(matches!(e, vk_convert::ConvertError::UnsupportedFormat));
}

#[test]
fn empty_bytes() {
    let e = convert(b"", "xlsx", "a.xlsx").unwrap_err();
    assert!(matches!(e, vk_convert::ConvertError::Parse(_)));
}

#[test]
fn is_supported_matrix() {
    for ext in ["xlsx", "xlsm", "xls", "csv", "tsv", "docx"] {
        assert!(vk_convert::is_supported(ext), "应支持 {ext}");
    }
    for ext in ["pptx", "doc", "pdf", "txt", "PNG"] {
        assert!(!vk_convert::is_supported(ext), "不应支持 {ext}");
    }
}
