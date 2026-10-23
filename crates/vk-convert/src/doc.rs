//! docx → Univer IDocumentData（M2.1 只读）。
//!
//! 保真：正文段落 / 运行（含制表符、换行、修订插入文本）/ 标题级别 /
//! 有序无序列表 / 表格 / 页面尺寸 / 默认字体。
//! 丢弃：图片、页眉页脚、脚注尾注、文本框、删除修订文本。
//!
//! dataStream 控制符约定（与 poc/univer/samples/univer/doc-sample.json 一致）：
//! - 段落以 `\r` 结束，段落 `startIndex` = 其终止 `\r` 的索引；
//!   紧邻表格之后的段落，`startIndex` = 表格终止符 `\x1f` 的索引（Univer 约定）；
//! - 表格以 `\x1a` 开始、`\x1f` 结束，行 `\x1b..\x1e`，单元格 `\x1c..\x1d`；
//! - 文档以 `\0` 结束。

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::{Map, Value, json};

use crate::ConvertError;

/// Univer ListGlyphType 枚举值（@univerjs/core 1.2.0，i-document-data.d.ts）。
const GT_DECIMAL: u8 = 2;
const GT_DECIMAL_ZERO: u8 = 3;
const GT_UPPER_LETTER: u8 = 4;
const GT_LOWER_LETTER: u8 = 5;
const GT_UPPER_ROMAN: u8 = 6;
const GT_LOWER_ROMAN: u8 = 7;

/// 将 docx 字节转换为 Univer 文档数据模型。
pub fn document(bytes: &[u8], file_name: &str) -> Result<Value, ConvertError> {
    let docx =
        docx_rs::read_docx(bytes).map_err(|e| ConvertError::Parse(e.to_string()))?;
    let model: Value = serde_json::from_str(&docx.json())
        .map_err(|e| ConvertError::Parse(format!("docx 数据解析失败：{e}")))?;

    let children = model
        .pointer("/document/children")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    // ---- 页面尺寸（twips ÷ 20 = pt，取整为 px）----
    let (page_w, page_h) = model
        .pointer("/document/sectionProperty/pageSize")
        .and_then(|p| {
            p.get("w")
                .and_then(|v| v.as_f64())
                .zip(p.get("h").and_then(|v| v.as_f64()))
        })
        .map(|(w, h)| ((w / 20.0).round() as u32, (h / 20.0).round() as u32))
        .unwrap_or((595, 842));

    // ---- 默认字体（docDefaults）----
    let dd = model.pointer("/styles/docDefaults/runPropertyDefault/runProperty");
    let default_sz = dd
        .and_then(|d| d.get("sz"))
        .and_then(|v| v.as_f64())
        .map(|v| (v / 2.0).round())
        .unwrap_or(12.0);
    let default_font = dd
        .and_then(|d| d.get("fonts"))
        .and_then(|f| f.get("ascii"))
        .and_then(|v| v.as_str())
        .unwrap_or("Calibri")
        .to_string();

    // ---- 样式表：标题级别 → 实际字号 ----
    let mut heading_sz: BTreeMap<usize, f64> = BTreeMap::new();
    if let Some(styles) = model.pointer("/styles/styles").and_then(|v| v.as_array()) {
        for s in styles {
            let id = s.get("styleId").and_then(|v| v.as_str()).unwrap_or("");
            let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let sz = s
                .pointer("/runProperty/sz")
                .and_then(|v| v.as_f64())
                .map(|v| v / 2.0);
            if let (Some(lvl), Some(sz)) = (heading_level(id, name), sz) {
                heading_sz.insert(lvl, sz);
            }
        }
    }

    // ---- 编号定义：(numId, level) → (glyphType 或 None=项目符号, glyphFormat, startNumber) ----
    let mut num_info: BTreeMap<(u32, u32), (Option<u8>, String, u32)> = BTreeMap::new();
    if let Some(numberings) = model.pointer("/numberings") {
        let abs = numberings
            .get("abstractNums")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if let Some(nums) = numberings.get("numberings").and_then(|v| v.as_array()) {
            for num in nums {
                let num_id = num.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let abs_id = num.get("abstractNumId").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                if let Some(abs_num) = abs
                    .iter()
                    .find(|a| a.get("id").and_then(|v| v.as_u64()) == Some(abs_id as u64))
                {
                    let levels = abs_num
                        .get("levels")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    for level in 0..9u32 {
                        if let Some(lv) = levels
                            .iter()
                            .find(|l| l.get("level").and_then(|v| v.as_u64()) == Some(level as u64))
                        {
                            let format = lv
                                .get("format")
                                .and_then(|v| v.as_str())
                                .unwrap_or("bullet");
                            let (gt, default_glyph) = match format {
                                "decimal" => (Some(GT_DECIMAL), "%1.".to_string()),
                                "decimalZero" => (Some(GT_DECIMAL_ZERO), "0%1.".to_string()),
                                "upperLetter" => (Some(GT_UPPER_LETTER), "%1.".to_string()),
                                "lowerLetter" => (Some(GT_LOWER_LETTER), "%1.".to_string()),
                                "upperRoman" => (Some(GT_UPPER_ROMAN), "%1.".to_string()),
                                "lowerRoman" => (Some(GT_LOWER_ROMAN), "%1.".to_string()),
                                _ => (None, "●".to_string()),
                            };
                            // 优先使用文档实际定义的符号（如 "●" / "\u{f0b7}" / "%1."）
                            // PUA 区字符（Wingdings/Symbol 字体私有区）浏览器字体无法渲染，归一为 "●"
                            let glyph = lv
                                .get("text")
                                .and_then(|v| v.as_str())
                                .filter(|t| !t.is_empty())
                                .map(normalize_glyph)
                                .unwrap_or(default_glyph);
                            let start = lv
                                .get("start")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(1) as u32;
                            num_info.insert((num_id, level), (gt, glyph, start));
                        }
                    }
                }
            }
        }
    }

        // ---- 样式关联编号：styleId → (numId, ilvl)（docx-rs 不解析样式级 numPr）----
    let style_num = style_numbering_map(bytes);

    // ---- 遍历正文 ----
    let mut ds = String::new();
    let mut ds_len = 0usize; // dataStream 的 UTF-16 码元数（Univer 索引基准）
    let mut paragraphs: Vec<Value> = Vec::new();
    let mut tables: Vec<Value> = Vec::new();
    let mut table_source: Map<String, Value> = Map::new();
    let mut lists_acc: BTreeMap<String, BTreeMap<u32, Value>> = BTreeMap::new();
    let mut para_seq: u32 = 0;
    let mut table_seq: u32 = 0;
    let mut last_para_idx: Option<usize> = None;

    for child in &children {
        match child.get("type").and_then(|t| t.as_str()) {
            Some("paragraph") => {
                let text = para_text(child);
                let para_id = format!("para-{:012x}", para_seq);
                para_seq += 1;

                let mut entry = Map::new();
                ds.push_str(&text);
                ds_len += utf16_len(&text);
                // Univer 约定：段落 startIndex = 其终止 \r 的索引
                let style_idx = ds_len;
                ds.push('\r');
                ds_len += 1;
                entry.insert("startIndex".into(), json!(style_idx));
                entry.insert("paragraphId".into(), json!(para_id));

                if let Some(ps) = para_style(child) {
                    entry.insert("paragraphStyle".into(), ps);
                }
                if let Some((bullet, gt, glyph, start, num_id, level)) =
                    para_bullet(child, &num_info, &style_num)
                {
                    entry.insert("bullet".into(), bullet);
                    // Univer 1.2.0 INestingLevel：bulletAlignment/glyphFormat/startNumber 必填；
                    // 项目符号用 glyphSymbol（字面字符），有序列表用 glyphType(ListGlyphType)。
                    let cfg = match gt {
                        Some(gt) => json!({
                            "bulletAlignment": 0,
                            "glyphFormat": glyph,
                            "glyphType": gt,
                            "startNumber": start,
                        }),
                        None => json!({
                            "bulletAlignment": 0,
                            "glyphFormat": glyph,
                            "glyphSymbol": glyph,
                            "startNumber": start,
                            "textStyle": { "bl": 0 },
                        }),
                    };
                    lists_acc
                        .entry(format!("list-{num_id}"))
                        .or_default()
                        .insert(level, cfg);
                }

                let idx = paragraphs.len();
                paragraphs.push(Value::Object(entry));
                last_para_idx = Some(idx);
            }
            Some("table") => {
                let (rows_text, col_count) = table_rows_text(child);
                table_seq += 1;
                let table_id = format!("tbl-{:02}", table_seq);

                let start = ds_len;
                ds.push('\x1a');
                ds_len += 1;
                for row in &rows_text {
                    ds.push('\x1b');
                    ds_len += 1;
                    for cell in row {
                        ds.push('\x1c');
                        ds_len += 1;
                        ds.push_str(cell);
                        ds_len += utf16_len(cell);
                        ds.push('\x1d');
                        ds_len += 1;
                    }
                    ds.push('\x1e');
                    ds_len += 1;
                }
                ds.push('\x1f');
                ds_len += 1;
                let end = ds_len; // 独占，位于 \x1f 之后一位

                // Univer 约定：紧邻表格的前一段，其 startIndex 指向 \x1f
                if let Some(pi) = last_para_idx
                    && let Value::Object(o) = &mut paragraphs[pi] {
                        o.insert("startIndex".into(), json!(end - 1));
                    }

                tables.push(json!({
                    "startIndex": start,
                    "endIndex": end,
                    "tableId": table_id,
                }));

                let cols = col_count.max(1);
                table_source.insert(
                    table_id.clone(),
                    json!({
                        "tableId": table_id,
                        "tableRows": rows_text.iter().map(|r| json!({
                            "tableCells": r.iter().map(|_| json!({})).collect::<Vec<_>>(),
                            "trHeight": { "val": { "v": 32, "u": 3 }, "hRule": 0 },
                        })).collect::<Vec<_>>(),
                        "tableColumns": (0..cols).map(|_| json!({
                            "size": { "type": 1, "width": { "v": 96, "u": 3 } }
                        })).collect::<Vec<_>>(),
                        "align": 0,
                        "indent": { "v": 0, "u": 3 },
                        "textWrap": 1,
                        "position": {
                            "positionH": { "relativeFrom": 1 },
                            "positionV": { "relativeFrom": 1 },
                        },
                        "dist": { "distT": 0, "distB": 0, "distL": 0, "distR": 0 },
                        "size": { "type": 1, "width": { "v": 96 * cols, "u": 3 } },
                    }),
                );
                last_para_idx = None;
            }
            _ => {}
        }
    }

    ds.push('\0');

    // ---- 汇总列表定义 ----
    let mut lists: Map<String, Value> = Map::new();
    for (list_type, mut levels) in lists_acc {
        let max_level = levels.keys().copied().max().unwrap_or(0);
        let nesting: Vec<Value> = (0..=max_level)
            .map(|i| {
                levels
                    .remove(&i)
                    .unwrap_or_else(|| json!({
                        "bulletAlignment": 0,
                        "glyphFormat": "●",
                        "glyphSymbol": "●",
                        "startNumber": 1,
                        "textStyle": { "bl": 0 },
                    }))
            })
            .collect();
        lists.insert(
            list_type.clone(),
            json!({ "listType": list_type, "nestingLevel": nesting }),
        );
    }

    Ok(json!({
        "id": "vento-doc",
        "title": file_name,
        "documentStyle": {
            "defaultNumFormat": {},
            "defaultPageSize": { "width": page_w, "height": page_h },
            "defaultParagraphStyle": {
                "spacing": { "before": 0, "after": 120, "line": 360, "lineRule": 0 },
                "horizontalAlign": 0,
                "textStyle": { "sz": sz_value(default_sz), "ff": default_font, "cl": "#000000" },
            },
        },
        "styles": {
            "h1": heading_style_def(1, &heading_sz),
            "h2": heading_style_def(2, &heading_sz),
            "h3": heading_style_def(3, &heading_sz),
        },
        "lists": lists,
        "body": {
            "dataStream": ds,
            "paragraphs": paragraphs,
            "tables": tables,
        },
        "tableSource": table_source,
    }))
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// UTF-16 码元数（JS 字符串 / Univer dataStream 索引基准）。
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 字号 JSON 输出：整数值输出为整数（与参考样本一致，如 sz: 14）。
fn sz_value(sz: f64) -> Value {
    if sz.fract() == 0.0 && sz.abs() <= i64::MAX as f64 {
        json!(sz as i64)
    } else {
        json!(sz)
    }
}

/// 项目符号归一：Wingdings/Symbol 私有区（PUA）字符浏览器字体无法渲染，
/// 统一替换为 "●"，与 POC 参考样本一致。
fn normalize_glyph(g: &str) -> String {
    if g.chars().any(|c| ('\u{e000}'..='\u{f8ff}').contains(&c)) {
        "●".to_string()
    } else {
        g.to_string()
    }
}

/// 段落文本（含修订插入文本、制表符、换行）。
fn para_text(p: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = p.pointer("/data/children").and_then(|c| c.as_array()) {
        for item in items {
            match item.get("type").and_then(|t| t.as_str()) {
                Some("run") => {
                    if let Some(kids) = item.pointer("/data/children").and_then(|c| c.as_array()) {
                        out.push_str(&run_children_to_text(kids));
                    }
                }
                Some("insert") => {
                    if let Some(kids) = item.pointer("/data/children").and_then(|c| c.as_array()) {
                        out.push_str(&run_children_to_text(kids));
                    }
                }
                Some("paragraph") => {
                    // 罕见嵌套段落，按子段落处理
                    out.push_str(&para_text(item));
                }
                _ => {}
            }
        }
    }
    out
}

/// 运行子节点 → 文本。
fn run_children_to_text(children: &[Value]) -> String {
    let mut out = String::new();
    for c in children {
        match c.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = c.pointer("/data/text").and_then(|v| v.as_str()) {
                    out.push_str(t);
                }
            }
            Some("tab") => out.push('\t'),
            Some("break") => out.push('\n'),
            Some("insert") => {
                if let Some(kids) = c.pointer("/data/children").and_then(|v| v.as_array()) {
                    out.push_str(&run_children_to_text(kids));
                }
            }
            _ => {}
        }
    }
    out
}

/// 段落样式：标题级别。
fn para_style(p: &Value) -> Option<Value> {
    let style_id = p
        .pointer("/data/property/style")
        .and_then(|v| v.as_str())?;
    let name = style_id;
    let lvl = heading_level(style_id, name)?;
    Some(json!({ "headingId": format!("h{}", lvl.min(3)) }))
}

/// 由 styleId / 样式名判断标题级别（1-based）。
/// 支持 "Heading1" / "heading 1" / "标题 1" / styleId "1" 等形式。
fn heading_level(style_id: &str, style_name: &str) -> Option<usize> {
    let parse = |s: &str| -> Option<usize> {
        let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        let rest = cleaned
            .strip_prefix("heading")
            .or_else(|| cleaned.strip_prefix("Heading"))
            .or_else(|| cleaned.strip_prefix("标题"))?;
        let n: usize = rest.parse().ok()?;
        (1..=9).contains(&n).then_some(n)
    };
    parse(style_name).or_else(|| parse(style_id))
}

/// 段落列表信息：bullet 对象 + (glyphType 或 None=项目符号, glyph, start, numId, level)。
/// 优先取显式 numberingProperty；否则回退到段落样式关联的编号（styleId → numId）。
fn para_bullet(
    p: &Value,
    num_info: &BTreeMap<(u32, u32), (Option<u8>, String, u32)>,
    style_num: &BTreeMap<String, (u32, u32)>,
) -> Option<(Value, Option<u8>, String, u32, u32, u32)> {
    let (num_id, level) = if let Some(num) = p.pointer("/data/property/numberingProperty") {
        let num_id = num.get("id").and_then(|v| v.as_u64())? as u32;
        let level = num.get("level").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        (num_id, level)
    } else {
        let style_id = p.pointer("/data/property/style").and_then(|v| v.as_str())?;
        *style_num.get(style_id)?
    };
    let (lt, glyph, start) = num_info.get(&(num_id, level))?;
    let bullet = json!({
        "listType": format!("list-{num_id}"),
        "listId": num_id,
        "nestingLevel": level,
    });
    Some((bullet, *lt, glyph.clone(), *start, num_id, level))
}

/// 表格 → 各行各单元格文本（单元格内多段以换行连接）。
fn table_rows_text(t: &Value) -> (Vec<Vec<String>>, usize) {
    let rows = t
        .pointer("/data/rows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<Vec<String>> = Vec::new();
    for r in &rows {
        let cells = r
            .pointer("/data/cells")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut row_text = Vec::new();
        for c in &cells {
            let mut text = String::new();
            if let Some(kids) = c.pointer("/data/children").and_then(|v| v.as_array()) {
                let mut first = true;
                for item in kids {
                    if item.get("type").and_then(|t| t.as_str()) == Some("paragraph") {
                        if !first {
                            text.push('\n');
                        }
                        text.push_str(&para_text(item));
                        first = false;
                    }
                }
            }
            row_text.push(text);
        }
        out.push(row_text);
    }
    let cols = out.iter().map(|r| r.len()).max().unwrap_or(1);
    (out, cols)
}

/// 解析 word/styles.xml 中样式关联的编号：styleId → (numId, ilvl)。
/// 直接读 zip 原始 XML（docx-rs 的 JSON 不含该链接），失败返回空表。
fn style_numbering_map(bytes: &[u8]) -> BTreeMap<String, (u32, u32)> {
    /// 从事件属性中读取 `w:val` 数值。
    fn val_attr(e: &quick_xml::events::BytesStart) -> Option<u32> {
        e.attributes().into_iter().find_map(|a| {
            a.ok().and_then(|a| {
                (a.key.local_name().into_inner() == "val")
                    .then(|| a.value.parse::<u32>().ok())
            })
        }).flatten()
    }

    let mut out = BTreeMap::new();
    let mut zip = match zip::ZipArchive::new(Cursor::new(bytes)) {
        Ok(z) => z,
        Err(_) => return out,
    };
    let mut f = match zip.by_name("word/styles.xml") {
        Ok(f) => f,
        Err(_) => return out,
    };
    let mut xml = Vec::new();
    if f.read_to_end(&mut xml).is_err() {
        return out;
    }
    let mut reader = Reader::from_reader(&xml[..]);
    let mut buf = Vec::new();
    let mut style_id: Option<String> = None;
    let mut num_id: Option<u32> = None;
    let mut ilvl: u32 = 0;
    while let Ok(event) = reader.read_event_into(&mut buf) {
        match event {
            // 自闭合标签（如 <w:numId w:val="5"/>）也是 BytesStart，必须一并处理
            Event::Start(e) | Event::Empty(e) => {
                let name = e.local_name().into_inner();
                if name == "style" {
                    style_id = e.attributes().into_iter().find_map(|a| {
                        a.ok().and_then(|a| {
                            (a.key.local_name().into_inner() == "styleId")
                                .then(|| a.value.to_string())
                        })
                    });
                    num_id = None;
                    ilvl = 0;
                } else if (name == "numId" || name == "ilvl")
                    && let Some(val) = val_attr(&e)
                {
                    if name == "numId" {
                        num_id = Some(val);
                    } else {
                        ilvl = val;
                    }
                }
            }
            Event::End(e) if e.local_name().into_inner() == "style" => {
                if let (Some(sid), Some(num)) = (style_id.take(), num_id) {
                    out.insert(sid, (num, ilvl));
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// 标题样式定义（字号取文档实际值，缺省回退 22/20/18）。
fn heading_style_def(lvl: usize, heading_sz: &BTreeMap<usize, f64>) -> Value {
    let fallback = (24.0 - 2.0 * lvl as f64).max(14.0);
    let sz = heading_sz.get(&lvl).copied().unwrap_or(fallback);
    json!({
        "name": format!("Heading {lvl}"),
        "type": 1,
        "paragraphStyle": { "headingId": format!("h{lvl}"), "namedStyleType": 1 },
        "textStyle": { "bl": 1, "sz": sz_value(sz) },
    })
}
