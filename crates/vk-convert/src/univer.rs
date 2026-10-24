//! Univer 快照 → Office（xlsx / docx）反向转换（M2.2 在线编辑保存）。
//!
//! 正向（office → univer）由 [crate::sheet] / [crate::doc] 实现；本模块是其逆过程：
//! 把编辑器 `save()` 产出的 Univer 1.2.0 数据模型快照（IWorkbookData / IDocumentData）
//! 写回 xlsx（rust_xlsxwriter）或 docx（docx-rs）字节流。
//!
//! 保真边界（与 POC-1 格式矩阵一致）：
//! - xlsx：值 / 公式（含缓存值）/ 样式 / 合并单元格 / 行高列宽 / 隐藏行列与工作表无损；
//!   合并区域仅左上格有值（Univer 约定），按左上格样式整体合并写回；
//! - docx：段落 / 标题 / 列表编号 / 表格 / 页面设置 / 默认段落样式无损；
//!   run 级内联样式与单元格底纹在正向转换中已丢弃，反向无法恢复。

use std::collections::{BTreeMap, HashMap, HashSet};

use docx_rs::{Level, Paragraph};
use rust_xlsxwriter::{Format, FormatBorder, Workbook, Worksheet};
use serde_json::{Map, Value};

use crate::ConvertError;

/// 将 Univer 快照反向转换为 Office 文件字节流。
///
/// - `unit_type`：`"sheet"` → xlsx；`"doc"` → docx；
/// - `file_name`：写入文档属性（xlsx 标题）。
///
/// 返回完整的 Office 文件字节流。
pub fn univer_to_office(
    snapshot: &Value,
    unit_type: &str,
    file_name: &str,
) -> Result<Vec<u8>, ConvertError> {
    match unit_type {
        "sheet" => to_xlsx(snapshot, file_name),
        "doc" => to_docx(snapshot),
        other => Err(ConvertError::Parse(format!("未知的单元类型: {other}"))),
    }
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

fn to_xlsx(snapshot: &Value, file_name: &str) -> Result<Vec<u8>, ConvertError> {
    use rust_xlsxwriter::DocProperties;

    let sheet_order = snapshot
        .get("sheetOrder")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let sheets = snapshot
        .get("sheets")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let styles = snapshot
        .get("styles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut wb = Workbook::new();
    let props = DocProperties::new().set_title(file_name);
    wb.set_properties(&props);

    let mut written = 0u32;
    for sheet_id in &sheet_order {
        let Some(sid) = sheet_id.as_str() else {
            continue;
        };
        let Some(sheet) = sheets.get(sid) else {
            continue;
        };
        write_sheet(&mut wb, sheet, &styles)?;
        written += 1;
    }
    if written == 0 {
        return Err(ConvertError::Parse("工作簿没有可导出的工作表".into()));
    }
    wb.save_to_buffer()
        .map_err(|e| ConvertError::Parse(format!("写入 xlsx 失败: {e}")))
}

fn write_sheet(
    wb: &mut Workbook,
    sheet: &Value,
    styles: &Map<String, Value>,
) -> Result<(), ConvertError> {
    let ws = wb.add_worksheet();
    let name = sheet
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Sheet")
        .to_string();
    ws.set_name(&name)
        .map_err(|e| ConvertError::Parse(format!("无效的工作表名称: {e}")))?;

    match sheet.get("hidden").and_then(Value::as_u64) {
        Some(2) => {
            let _ = ws.set_very_hidden(true);
        }
        Some(1) => {
            let _ = ws.set_hidden(true);
        }
        _ => {}
    }
    let tab_color = sheet.get("tabColor").and_then(|v| {
        v.as_str().map(str::to_string).or_else(|| {
            v.pointer("/rgb")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    });
    if let Some(tc) = tab_color
        .as_deref()
        .filter(|c| !c.is_empty() && *c != "#000000")
    {
        ws.set_tab_color(tc);
    }

    let col_count = sheet
        .get("columnCount")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(16384) as u16;
    let dcw = sheet
        .get("defaultColumnWidth")
        .and_then(Value::as_f64)
        .unwrap_or(88.0);
    let drh = sheet
        .get("defaultRowHeight")
        .and_then(Value::as_f64)
        .unwrap_or(24.0);
    if col_count > 0 && dcw > 0.0 {
        ws.set_column_range_width_pixels(0, col_count.saturating_sub(1), dcw.round() as u32)
            .map_err(|e| ConvertError::Parse(format!("设置默认列宽失败: {e}")))?;
    }
    if drh > 0.0 {
        ws.set_default_row_height_pixels(drh.round() as u32);
    }

    let cell_data = sheet
        .get("cellData")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let row_data = sheet
        .get("rowData")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let col_data = sheet
        .get("columnData")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // 合并单元格：非左上格跳过逐格写入，循环结束后整体 merge_range 写回。
    let mut merge_skip: HashSet<(u32, u16)> = HashSet::new();
    let mut merges: Vec<(u32, u16, u32, u16)> = Vec::new();
    if let Some(arr) = sheet.get("mergeData").and_then(Value::as_array) {
        for m in arr {
            let (Some(sr), Some(sc), Some(er), Some(ec)) = (
                m.get("startRow").and_then(Value::as_u64),
                m.get("startColumn").and_then(Value::as_u64),
                m.get("endRow").and_then(Value::as_u64),
                m.get("endColumn").and_then(Value::as_u64),
            ) else {
                continue;
            };
            let (sr, sc, er, ec) = (sr as u32, sc as u16, er as u32, ec as u16);
            if sr == er && sc == ec {
                continue;
            }
            merges.push((sr, sc, er, ec));
            for r in sr..=er {
                for c in sc..=ec {
                    if (r, c) != (sr, sc) {
                        merge_skip.insert((r, c));
                    }
                }
            }
        }
    }

    let mut fmt_cache: HashMap<String, Format> = HashMap::new();
    for (r_key, row) in &cell_data {
        let Some(r) = r_key.parse::<u32>().ok() else {
            continue;
        };
        if let Some(rh) = row_data
            .get(r_key)
            .and_then(|v| v.get("h"))
            .and_then(Value::as_f64)
            && rh > 0.0
        {
            ws.set_row_height_pixels(r, rh.round() as u32)
                .map_err(|e| ConvertError::Parse(format!("设置行高失败: {e}")))?;
        }
        if row_data
            .get(r_key)
            .and_then(|v| v.get("hd"))
            .and_then(Value::as_u64)
            == Some(1)
        {
            ws.set_row_hidden(r)
                .map_err(|e| ConvertError::Parse(format!("隐藏行失败: {e}")))?;
        }
        let Some(row_map) = row.as_object() else {
            continue;
        };
        for (c_key, entry) in row_map {
            let Some(c) = c_key.parse::<u16>().ok() else {
                continue;
            };
            if merge_skip.contains(&(r, c)) {
                continue;
            }
            let Some(entry_map) = entry.as_object() else {
                continue;
            };
            let fmt = resolve_format(entry_map.get("s"), styles, &mut fmt_cache);
            write_cell(ws, r, c, entry_map, fmt.as_ref())?;
        }
    }

    for (c_key, col) in &col_data {
        let Some(c) = c_key.parse::<u16>().ok() else {
            continue;
        };
        if let Some(w) = col.get("w").and_then(Value::as_f64).filter(|w| *w > 0.0) {
            ws.set_column_width_pixels(c, w.round() as u32)
                .map_err(|e| ConvertError::Parse(format!("设置列宽失败: {e}")))?;
        }
        if col.get("hd").and_then(Value::as_u64) == Some(1) {
            ws.set_column_hidden(c)
                .map_err(|e| ConvertError::Parse(format!("隐藏列失败: {e}")))?;
        }
    }

    for &(sr, sc, er, ec) in &merges {
        let top_left = cell_data
            .get(&sr.to_string())
            .and_then(|row| row.get(sc.to_string()))
            .and_then(|e| e.as_object());
        let text = match top_left {
            Some(e) => e
                .get("v")
                .filter(|v| !v.is_null())
                .map(plain_text)
                .or_else(|| e.get("p").map(plain_text))
                .unwrap_or_default(),
            None => String::new(),
        };
        let style = top_left.and_then(|e| e.get("s")).cloned();
        let fmt = resolve_format(style.as_ref(), styles, &mut fmt_cache).unwrap_or_default();
        ws.merge_range(sr, sc, er, ec, &text, &fmt)
            .map_err(|e| ConvertError::Parse(format!("合并单元格失败: {e}")))?;
    }
    Ok(())
}

#[derive(Debug)]
enum CellContent {
    /// 公式（含 `=` 前缀原文）与可选缓存结果。
    Formula(String, Option<String>),
    Number(f64),
    Bool(bool),
    /// 文本，及是否强制文本（t == FORCE_STRING → 加引用前缀）。
    Text(String, bool),
}

fn write_cell(
    ws: &mut Worksheet,
    r: u32,
    c: u16,
    entry: &Map<String, Value>,
    fmt: Option<&Format>,
) -> Result<(), ConvertError> {
    use rust_xlsxwriter::Formula;

    let content = extract_cell(entry);
    match content {
        None => {
            if let Some(f) = fmt {
                ws.write_blank(r, c, f)
                    .map_err(|e| ConvertError::Parse(format!("写入空白单元格失败: {e}")))?;
            }
        }
        Some(CellContent::Formula(f, cached)) => {
            let mut formula = Formula::new(f.as_str());
            if let Some(res) = cached {
                formula = formula.set_result(res);
            }
            match fmt {
                Some(f) => {
                    ws.write_formula_with_format(r, c, formula, f)
                        .map_err(|e| ConvertError::Parse(format!("写入公式失败: {e}")))?;
                }
                None => {
                    ws.write_formula(r, c, formula)
                        .map_err(|e| ConvertError::Parse(format!("写入公式失败: {e}")))?;
                }
            }
        }
        Some(CellContent::Number(n)) => match fmt {
            Some(f) => {
                ws.write_number_with_format(r, c, n, f)
                    .map_err(|e| ConvertError::Parse(format!("写入数值失败: {e}")))?;
            }
            None => {
                ws.write_number(r, c, n)
                    .map_err(|e| ConvertError::Parse(format!("写入数值失败: {e}")))?;
            }
        },
        Some(CellContent::Bool(b)) => match fmt {
            Some(f) => {
                ws.write_boolean_with_format(r, c, b, f)
                    .map_err(|e| ConvertError::Parse(format!("写入布尔值失败: {e}")))?;
            }
            None => {
                ws.write_boolean(r, c, b)
                    .map_err(|e| ConvertError::Parse(format!("写入布尔值失败: {e}")))?;
            }
        },
        Some(CellContent::Text(s, force)) => {
            if force {
                let f = match fmt {
                    Some(f) => f.clone().set_quote_prefix(),
                    None => Format::new().set_quote_prefix(),
                };
                ws.write_string_with_format(r, c, s, &f)
                    .map_err(|e| ConvertError::Parse(format!("写入文本失败: {e}")))?;
            } else {
                match fmt {
                    Some(f) => {
                        ws.write_string_with_format(r, c, s, f)
                            .map_err(|e| ConvertError::Parse(format!("写入文本失败: {e}")))?;
                    }
                    None => {
                        ws.write_string(r, c, s)
                            .map_err(|e| ConvertError::Parse(format!("写入文本失败: {e}")))?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// 从单元格条目提取内容；仅含样式（或空）返回 `None`（由调用方写空白格）。
fn extract_cell(entry: &Map<String, Value>) -> Option<CellContent> {
    if let Some(f) = entry.get("f").and_then(Value::as_str) {
        let cached = entry
            .get("v")
            .filter(|v| !v.is_null())
            .map(|v| cached_result(v, entry.get("t").and_then(Value::as_u64)));
        return Some(CellContent::Formula(f.to_string(), cached));
    }
    if let Some(v) = entry.get("v").filter(|v| !v.is_null()) {
        let t = entry.get("t").and_then(Value::as_u64);
        return Some(match t {
            Some(2) => match v.as_f64() {
                Some(n) => CellContent::Number(n),
                None => CellContent::Text(plain_text(v), false),
            },
            Some(3) => match v.as_bool() {
                Some(b) => CellContent::Bool(b),
                None => CellContent::Text(plain_text(v), false),
            },
            Some(4) => CellContent::Text(plain_text(v), true),
            Some(1) | None => match v {
                Value::Bool(_) => match v.as_bool() {
                    Some(b) => CellContent::Bool(b),
                    None => unreachable!("布尔值不可能为空"),
                },
                Value::Number(_) => match v.as_f64() {
                    Some(n) => CellContent::Number(n),
                    None => CellContent::Text(plain_text(v), false),
                },
                _ => CellContent::Text(plain_text(v), false),
            },
            _ => CellContent::Text(plain_text(v), false),
        });
    }
    if let Some(p) = entry.get("p") {
        let text = plain_text(p);
        if !text.is_empty() {
            return Some(CellContent::Text(text, false));
        }
    }
    None
}

/// 缓存公式结果 → 字符串（数值用十进制、布尔用 TRUE/FALSE，与 Excel 存储格式一致）。
fn cached_result(v: &Value, t: Option<u64>) -> String {
    match t {
        Some(3) => match v.as_bool() {
            Some(true) => "TRUE".to_string(),
            Some(false) => "FALSE".to_string(),
            None => v.to_string(),
        },
        Some(2) | None => match v.as_f64() {
            Some(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
            Some(n) => format!("{n}"),
            None => v.to_string(),
        },
        _ => v
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| v.to_string()),
    }
}

/// 值 → 纯文本；富文本取 `body.dataStream` 并清理控制字符（有损，文档已说明）。
fn plain_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(_) => v
            .pointer("/body/dataStream")
            .and_then(Value::as_str)
            .map(datastream_to_text)
            .filter(|t| !t.is_empty())
            .unwrap_or_default(),
        other => other.to_string(),
    }
}

fn datastream_to_text(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\r' => '\n',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect()
}

/// 解析单元格样式：内联对象或 styles 表 id 引用；按规范化 JSON 缓存 Format。
fn resolve_format(
    style: Option<&Value>,
    styles: &Map<String, Value>,
    cache: &mut HashMap<String, Format>,
) -> Option<Format> {
    let obj: &Map<String, Value> = match style? {
        Value::Object(o) => o,
        Value::String(id) => styles.get(id.as_str()).and_then(Value::as_object)?,
        _ => return None,
    };
    let key = serde_json::to_string(obj).unwrap_or_default();
    if let Some(f) = cache.get(&key) {
        return Some(f.clone());
    }
    let f = build_format(obj)?;
    cache.insert(key, f.clone());
    Some(f)
}

/// 边框写入：`{key: {s: 样式枚举, cl: {rgb}}}` → 对应边的 border + border color。
macro_rules! border {
    ($f:expr, $o:expr, $key:expr, $style:ident, $color:ident) => {{
        if let Some(style) = $o
            .get($key)
            .and_then(|b| b.get("s"))
            .and_then(Value::as_u64)
            .and_then(border_style)
        {
            $f = $f.$style(style);
            if let Some(rgb) = $o
                .get($key)
                .and_then(|b| b.get("cl"))
                .and_then(|c| c.get("rgb"))
                .and_then(Value::as_str)
            {
                $f = $f.$color(rgb);
            }
        }
    }};
}

/// Univer IStyleData → rust_xlsxwriter Format；无可映射属性返回 `None`。
fn build_format(o: &Map<String, Value>) -> Option<Format> {
    use rust_xlsxwriter::{FormatAlign, FormatPattern, FormatScript, FormatUnderline};

    let mut f = Format::new();
    let mut any = false;

    if o.get("b").and_then(Value::as_u64) == Some(1) {
        f = f.set_bold();
        any = true;
    }
    if o.get("i").and_then(Value::as_u64) == Some(1) {
        f = f.set_italic();
        any = true;
    }
    match o.get("u").and_then(|v| v.get("s")).and_then(Value::as_u64) {
        Some(1) => {
            f = f.set_underline(FormatUnderline::Single);
            any = true;
        }
        Some(2) => {
            f = f.set_underline(FormatUnderline::Double);
            any = true;
        }
        _ => {}
    }
    if o.get("st").and_then(|v| v.get("s")).and_then(Value::as_u64) == Some(1) {
        f = f.set_font_strikethrough();
        any = true;
    }
    if let Some(ff) = o.get("ff").and_then(Value::as_str) {
        f = f.set_font_name(ff);
        any = true;
    }
    if let Some(sz) = o.get("sz").and_then(Value::as_f64)
        && sz > 0.0
    {
        f = f.set_font_size(sz);
        any = true;
    }
    if let Some(n) = o.get("n").and_then(|v| v.get("v")).and_then(Value::as_str) {
        f = f.set_num_format(n);
        any = true;
    }
    if let Some(in_indent) = o.get("in").and_then(Value::as_u64) {
        f = f.set_indent(in_indent as u8);
        any = true;
    }
    if let Some(rot) = o.get("ro").and_then(Value::as_i64) {
        f = f.set_rotation(rot as i16);
        any = true;
    }
    if let Some(cl) = o
        .get("cl")
        .and_then(|v| v.get("rgb"))
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    {
        f = f.set_font_color(cl);
        any = true;
    }
    if let Some(bg) = o
        .get("bg")
        .and_then(|v| v.get("rgb"))
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty() && *c != "#FFFFFF")
    {
        // 纯色底纹必须同时设置 Solid 图案，否则 Excel 忽略 bgColor。
        f = f.set_pattern(FormatPattern::Solid).set_foreground_color(bg);
        any = true;
    }
    match o.get("ht").and_then(Value::as_u64) {
        Some(1) => {
            f = f.set_align(FormatAlign::Left);
            any = true;
        }
        Some(2) => {
            f = f.set_align(FormatAlign::Center);
            any = true;
        }
        Some(3) => {
            f = f.set_align(FormatAlign::Right);
            any = true;
        }
        Some(4) => {
            f = f.set_align(FormatAlign::Justify);
            any = true;
        }
        _ => {}
    }
    match o.get("vt").and_then(Value::as_u64) {
        Some(1) => {
            f = f.set_align(FormatAlign::VerticalCenter);
            any = true;
        }
        Some(2) => {
            f = f.set_align(FormatAlign::Bottom);
            any = true;
        }
        _ => {}
    }
    if o.get("tb").and_then(|v| v.get("s")).and_then(Value::as_u64) == Some(1) {
        f = f.set_text_wrap();
        any = true;
    }
    match o.get("fs").and_then(Value::as_u64) {
        Some(1) => {
            f = f.set_font_script(FormatScript::Superscript);
            any = true;
        }
        Some(2) => {
            f = f.set_font_script(FormatScript::Subscript);
            any = true;
        }
        _ => {}
    }
    border!(f, o, "bl", set_border_left, set_border_left_color);
    border!(f, o, "br", set_border_right, set_border_right_color);
    border!(f, o, "bt", set_border_top, set_border_top_color);
    border!(f, o, "bb", set_border_bottom, set_border_bottom_color);
    if !any && !has_border(o) {
        return None;
    }
    Some(f)
}

fn has_border(o: &Map<String, Value>) -> bool {
    ["bl", "br", "bt", "bb"].iter().any(|k| {
        o.get(*k)
            .and_then(|b| b.get("s"))
            .and_then(Value::as_u64)
            .and_then(border_style)
            .is_some()
    })
}

fn border_style(s: u64) -> Option<FormatBorder> {
    match s {
        1 => Some(FormatBorder::Thin),
        2 => Some(FormatBorder::Thick),
        3 => Some(FormatBorder::Dotted),
        4 => Some(FormatBorder::Hair),
        5 => Some(FormatBorder::Dashed),
        6 => Some(FormatBorder::Double),
        7 => Some(FormatBorder::Medium),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

/// dataStream 解析块。
#[derive(Debug, Clone)]
enum DocBlock {
    Para(String),
    Table(Vec<Vec<String>>),
}

fn to_docx(snapshot: &Value) -> Result<Vec<u8>, ConvertError> {
    use docx_rs::{
        AbstractNumbering, Docx, IndentLevel, LineSpacing, LineSpacingType, Numbering, NumberingId,
        Run, RunFonts, Style, StyleType, Table, TableCell, TableRow, WidthType,
    };

    let body = snapshot
        .get("body")
        .ok_or_else(|| ConvertError::Parse("缺少文档正文 (body)".into()))?;
    let data_stream = body
        .get("dataStream")
        .and_then(Value::as_str)
        .ok_or_else(|| ConvertError::Parse("缺少文档 dataStream".into()))?;
    let paras: Vec<&Value> = body
        .get("paragraphs")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let tables: Vec<&Value> = body
        .get("tables")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let lists = snapshot
        .get("lists")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let styles_map = snapshot
        .get("styles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let doc_style = snapshot
        .get("documentStyle")
        .cloned()
        .unwrap_or(Value::Null);
    let table_source = snapshot
        .get("tableSource")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut blocks = parse_data_stream(data_stream);
    if blocks.is_empty() {
        blocks.push(DocBlock::Para(String::new()));
    }

    // 收集文档实际用到的列表定义：listType → 最大嵌套层。
    let mut list_usage: BTreeMap<String, u32> = BTreeMap::new();
    for p in &paras {
        let Some(lt) = p.pointer("/bullet/listType").and_then(Value::as_str) else {
            continue;
        };
        let lvl = p
            .pointer("/bullet/nestingLevel")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;
        let entry = list_usage.entry(lt.to_string()).or_insert(0);
        if lvl > *entry {
            *entry = lvl;
        }
    }

    // numbering id 从 2 开始：docx-rs 恒写默认 abstract numbering（id=1）。
    let mut num_map: HashMap<String, usize> = HashMap::new();
    let mut docx = Docx::new();
    for (lt, &max_lvl) in &list_usage {
        let id = 2 + num_map.len();
        num_map.insert(lt.clone(), id);
        let cfg = lists.get(lt.as_str());
        let mut abs = AbstractNumbering::new(id);
        for lvl in 0..=max_lvl {
            abs = abs.add_level(build_level(lvl as usize, cfg));
        }
        docx = docx.add_abstract_numbering(abs);
        docx = docx.add_numbering(Numbering::new(id, id));
    }

    // 为用到的标题级别注册 Heading1-3 样式，Word / python-docx 才能按标题解析。
    let mut heading_used = [false; 4];
    for p in &paras {
        if let Some(hid) = p
            .pointer("/paragraphStyle/headingId")
            .and_then(Value::as_str)
        {
            let lvl = match hid {
                "h1" => 1,
                "h2" => 2,
                _ => 3,
            };
            heading_used[lvl] = true;
        }
    }
    for (lvl, &used) in heading_used.iter().enumerate().skip(1) {
        if !used {
            continue;
        }
        let st = styles_map
            .get(&format!("h{lvl}"))
            .and_then(|s| s.pointer("/textStyle"));
        let sz = st
            .and_then(|t| t.get("sz"))
            .and_then(Value::as_f64)
            .unwrap_or((24 - 2 * lvl).max(14) as f64);
        let style = Style::new(format!("Heading{lvl}"), StyleType::Paragraph)
            .name(format!("Heading {lvl}"))
            .based_on("Normal")
            .bold()
            .size((sz * 2.0).round() as usize)
            .outline_lvl(lvl - 1);
        docx = docx.add_style(style);
    }

    if let (Some(w), Some(h)) = (
        doc_style
            .pointer("/defaultPageSize/width")
            .and_then(Value::as_f64),
        doc_style
            .pointer("/defaultPageSize/height")
            .and_then(Value::as_f64),
    ) && w > 0.0
        && h > 0.0
    {
        docx = docx.page_size((w * 20.0).round() as u32, (h * 20.0).round() as u32);
    }
    let dts = doc_style.pointer("/defaultParagraphStyle/textStyle");
    let sz = dts
        .and_then(|t| t.get("sz"))
        .and_then(Value::as_f64)
        .unwrap_or(12.0);
    docx = docx.default_size((sz * 2.0).round() as usize);
    if let Some(ff) = dts.and_then(|t| t.get("ff")).and_then(Value::as_str) {
        docx = docx.default_fonts(RunFonts::new().ascii(ff).east_asia(ff));
    }
    let sp = doc_style.pointer("/defaultParagraphStyle/spacing");
    let before = sp
        .and_then(|s| s.get("before"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let after = sp
        .and_then(|s| s.get("after"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let line = sp
        .and_then(|s| s.get("line"))
        .and_then(Value::as_i64)
        .unwrap_or(240) as i32;
    let rule = match sp.and_then(|s| s.get("lineRule")).and_then(Value::as_u64) {
        Some(1) => LineSpacingType::AtLeast,
        Some(2) => LineSpacingType::Exact,
        _ => LineSpacingType::Auto,
    };
    docx = docx.default_line_spacing(
        LineSpacing::new()
            .before(before)
            .after(after)
            .line(line)
            .line_rule(rule),
    );

    let mut para_idx = 0usize;
    let mut table_idx = 0usize;
    for block in &blocks {
        match block {
            DocBlock::Para(text) => {
                let pinfo = paras.get(para_idx).copied();
                para_idx += 1;
                let heading = pinfo
                    .and_then(|p| {
                        p.pointer("/paragraphStyle/headingId")
                            .and_then(Value::as_str)
                    })
                    .map(|hid| match hid {
                        "h1" => 1,
                        "h2" => 2,
                        _ => 3,
                    });
                let (bold, size) = match heading {
                    Some(lvl) => {
                        let st = styles_map
                            .get(&format!("h{lvl}"))
                            .and_then(|s| s.pointer("/textStyle"));
                        let s = st
                            .and_then(|t| t.get("sz"))
                            .and_then(Value::as_f64)
                            .unwrap_or((24 - 2 * lvl).max(14) as f64);
                        (true, (s * 2.0).round() as usize)
                    }
                    None => (false, 0),
                };
                let mut para = add_runs(Paragraph::new(), text, bold, size);
                if let Some(lvl) = heading {
                    para = para.style(format!("Heading{lvl}").as_str());
                }
                if let Some(lt) =
                    pinfo.and_then(|p| p.pointer("/bullet/listType").and_then(Value::as_str))
                    && let Some(&num_id) = num_map.get(lt)
                {
                    let ilvl = pinfo
                        .and_then(|p| p.pointer("/bullet/nestingLevel").and_then(Value::as_u64))
                        .unwrap_or(0) as usize;
                    para = para.numbering(NumberingId::new(num_id), IndentLevel::new(ilvl));
                }
                docx = docx.add_paragraph(para);
            }
            DocBlock::Table(rows) => {
                let tinfo = tables.get(table_idx).copied();
                table_idx += 1;
                let col_count = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
                let total_px = tinfo
                    .and_then(|t| t.get("tableId").and_then(Value::as_str))
                    .and_then(|tid| table_source.get(tid))
                    .and_then(|ts| ts.get("tableColumns").and_then(Value::as_array))
                    .map(|cols| {
                        cols.iter()
                            .map(|c| {
                                c.pointer("/size/width/v")
                                    .and_then(Value::as_f64)
                                    .unwrap_or(96.0)
                            })
                            .sum::<f64>()
                    })
                    .unwrap_or(96.0 * col_count as f64);
                let total_twips = (total_px * 20.0).round().max(1.0) as usize;
                let col_twips = total_twips / col_count;
                let table_rows: Vec<TableRow> = rows
                    .iter()
                    .map(|row| {
                        let mut cells: Vec<TableCell> = Vec::with_capacity(col_count);
                        for i in 0..col_count {
                            let mut cell = TableCell::new();
                            match row.get(i).map(String::as_str).unwrap_or("") {
                                "" => {
                                    cell = cell.add_paragraph(Paragraph::new());
                                }
                                text => {
                                    for line in text.split('\n') {
                                        cell = cell.add_paragraph(
                                            Paragraph::new().add_run(Run::new().add_text(line)),
                                        );
                                    }
                                }
                            }
                            cells.push(cell);
                        }
                        TableRow::new(cells)
                    })
                    .collect();
                let mut table = Table::new(table_rows);
                table = table.set_grid(vec![col_twips; col_count]);
                table = table.width(total_twips, WidthType::Dxa);
                docx = docx.add_table(table);
            }
        }
    }

    let mut buf = std::io::Cursor::new(Vec::new());
    docx.build()
        .pack(&mut buf)
        .map_err(|e| ConvertError::Parse(format!("写入 docx 失败: {e}")))?;
    mark_normal_default(buf.into_inner())
}

/// docx-rs 输出的 Normal 样式缺少 `w:default="1"`，部分解析器（如 python-docx）
/// 无法据此定位默认段落样式；在打包后重写 `word/styles.xml` 补上该属性。
fn mark_normal_default(bytes: Vec<u8>) -> Result<Vec<u8>, ConvertError> {
    use std::io::{Read, Write};
    use zip::{ZipArchive, ZipWriter};

    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| ConvertError::Parse(format!("读取 docx 包失败: {e}")))?;
    let mut out = std::io::Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(&mut out);
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| ConvertError::Parse(format!("读取 docx 条目失败: {e}")))?;
        let name = entry.name().to_string();
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|e| ConvertError::Parse(format!("读取 docx 条目内容失败: {e}")))?;
        if name == "word/styles.xml" {
            let owned = std::mem::take(&mut data);
            data = match String::from_utf8(owned) {
                Ok(mut xml) => {
                    let needle = "<w:style w:type=\"paragraph\" w:styleId=\"Normal\">";
                    if let Some(pos) = xml.find(needle) {
                        xml.replace_range(
                            pos..pos + needle.len(),
                            "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\">",
                        );
                    }
                    xml.into_bytes()
                }
                Err(e) => e.into_bytes(),
            };
        }
        writer
            .start_file(
                &name,
                zip::write::SimpleFileOptions::default().compression_method(entry.compression()),
            )
            .map_err(|e| ConvertError::Parse(format!("写入 docx 条目失败: {e}")))?;
        writer
            .write_all(&data)
            .map_err(|e| ConvertError::Parse(format!("写入 docx 条目内容失败: {e}")))?;
    }
    writer
        .finish()
        .map_err(|e| ConvertError::Parse(format!("完成 docx 包失败: {e}")))?;
    Ok(out.into_inner())
}

/// 按 Univer dataStream 约定逐字符扫描，得到段落 / 表格块序列
/// （与 `body.paragraphs` / `body.tables` 的下标一一对应）。
fn parse_data_stream(ds: &str) -> Vec<DocBlock> {
    let mut blocks = Vec::new();
    let mut cur = String::new();
    let mut in_table = false;
    let mut table_rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    for ch in ds.chars() {
        match ch {
            '\x1a' => {
                if !cur.is_empty() {
                    blocks.push(DocBlock::Para(std::mem::take(&mut cur)));
                }
                in_table = true;
                table_rows.clear();
                row.clear();
                cell.clear();
            }
            '\x1b' => row.clear(),
            '\x1c' => cell.clear(),
            '\x1d' => {
                row.push(std::mem::take(&mut cell));
            }
            '\x1e' => table_rows.push(std::mem::take(&mut row)),
            '\x1f' => {
                in_table = false;
                blocks.push(DocBlock::Table(std::mem::take(&mut table_rows)));
            }
            '\r' => {
                if in_table {
                    cell.push('\n');
                } else {
                    blocks.push(DocBlock::Para(std::mem::take(&mut cur)));
                }
            }
            '\0' => break,
            _ => {
                if in_table {
                    cell.push(ch);
                } else {
                    cur.push(ch);
                }
            }
        }
    }
    if !cur.is_empty() {
        blocks.push(DocBlock::Para(cur));
    }
    blocks
}

/// 按 glyphType 还原 w:numFmt / w:lvlText（与 doc.rs 正向映射互逆）。
fn build_level(lvl: usize, cfg: Option<&Value>) -> Level {
    use docx_rs::{LevelJc, LevelText, NumberFormat, SpecialIndentType, Start};

    let level_cfg = cfg
        .and_then(|c| c.get("nestingLevel"))
        .and_then(Value::as_array)
        .and_then(|a| a.get(lvl));
    let glyph_type = level_cfg
        .and_then(|c| c.get("glyphType"))
        .and_then(Value::as_u64);
    let glyph = level_cfg
        .and_then(|c| c.get("glyphSymbol").or_else(|| c.get("glyphFormat")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("●");
    let start = level_cfg
        .and_then(|c| c.get("startNumber"))
        .and_then(Value::as_u64)
        .unwrap_or(1) as usize;
    let numfmt = match glyph_type {
        Some(2) => "decimal",
        Some(3) => "decimalZero",
        Some(4) => "upperLetter",
        Some(5) => "lowerLetter",
        Some(6) => "upperRoman",
        Some(7) => "lowerRoman",
        _ => "bullet",
    };
    Level::new(
        lvl,
        Start::new(start),
        NumberFormat::new(numfmt),
        LevelText::new(glyph),
        LevelJc::new("left"),
    )
    .indent(
        Some(420 * (lvl as i32 + 1)),
        Some(SpecialIndentType::Hanging(420)),
        None,
        None,
    )
}

/// 段落文本 → runs；`\n` 处插软换行（段内换行）。
fn add_runs(mut para: Paragraph, text: &str, bold: bool, size: usize) -> Paragraph {
    use docx_rs::{BreakType, Run};

    if text.is_empty() {
        return para;
    }
    let mut first = true;
    for seg in text.split('\n') {
        if !first {
            para = para.add_run(Run::new().add_break(BreakType::TextWrapping));
        }
        let mut run = Run::new().add_text(seg);
        if bold {
            run = run.bold();
        }
        if size > 0 {
            run = run.size(size);
        }
        para = para.add_run(run);
        first = false;
    }
    para
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_stream_blocks() {
        // 段1 + 表格 + 段2
        let ds = "标题\r\x1a\x1b\x1cA\x1d\x1cB\x1d\x1e\x1b\x1cC\x1d\x1e\x1f结尾\r";
        let blocks = parse_data_stream(ds);
        assert_eq!(blocks.len(), 3);
        match &blocks[0] {
            DocBlock::Para(t) => assert_eq!(t, "标题"),
            _ => panic!("应为段落"),
        }
        match &blocks[1] {
            DocBlock::Table(rows) => {
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0], vec!["A", "B"]);
                assert_eq!(rows[1], vec!["C"]);
            }
            _ => panic!("应为表格"),
        }
        match &blocks[2] {
            DocBlock::Para(t) => assert_eq!(t, "结尾"),
            _ => panic!("应为段落"),
        }
    }

    #[test]
    fn data_stream_cell_break_and_null_end() {
        let ds = "\x1a\x1b\x1c多行\r内容\x1d\x1e\x1f\r\0";
        let blocks = parse_data_stream(ds);
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            DocBlock::Table(rows) => assert_eq!(rows[0], vec!["多行\n内容"]),
            _ => panic!("应为表格"),
        }
        match &blocks[1] {
            DocBlock::Para(t) => assert!(t.is_empty()),
            _ => panic!("应为段落"),
        }
    }

    #[test]
    fn extract_cell_variants() {
        let e = Map::from_iter([
            ("f".to_string(), Value::String("=A1+B1".into())),
            ("v".to_string(), Value::from(42.0)),
            ("t".to_string(), Value::from(2u8)),
        ]);
        match extract_cell(&e) {
            Some(CellContent::Formula(f, Some(c))) => {
                assert_eq!(f, "=A1+B1");
                assert_eq!(c, "42");
            }
            other => panic!("应为公式: {other:?}"),
        }

        let e = Map::from_iter([("v".to_string(), Value::from(true))]);
        assert!(matches!(extract_cell(&e), Some(CellContent::Bool(true))));

        let e = Map::from_iter([("v".to_string(), Value::String("文本".into()))]);
        assert!(matches!(extract_cell(&e), Some(CellContent::Text(ref s, false)) if s == "文本"));

        let e = Map::from_iter([("s".to_string(), Value::String("x".into()))]);
        assert!(extract_cell(&e).is_none());

        let rich = Map::from_iter([(
            "v".to_string(),
            Value::Object(Map::from_iter([(
                "body".to_string(),
                Value::Object(Map::from_iter([(
                    "dataStream".to_string(),
                    Value::String("富文本\r第二行".into()),
                )])),
            )])),
        )]);
        match extract_cell(&rich) {
            Some(CellContent::Text(s, false)) => assert_eq!(s, "富文本\n第二行"),
            other => panic!("应为文本: {other:?}"),
        }
    }

    #[test]
    fn xlsx_roundtrip_minimal() {
        let snap = serde_json::json!({
            "id": "wb1",
            "name": "测试",
            "sheetOrder": ["s1"],
            "sheets": {
                "s1": {
                    "id": "s1",
                    "name": "Sheet1",
                    "rowCount": 20,
                    "columnCount": 5,
                    "defaultColumnWidth": 88.0,
                    "defaultRowHeight": 24.0,
                    "cellData": {
                        "0": {
                            "0": {"v": "标题", "s": {"b": 1, "bg": {"rgb": "#FFFF00"}, "ht": 2}},
                            "1": {"v": 1.5, "t": 2},
                            "2": {"f": "=A1+B1", "v": 2.5, "t": 2},
                            "3": {"v": true, "t": 3}
                        },
                        "1": {
                            "0": {"v": "纯文本"},
                            "4": {"s": {"b": 1}}
                        }
                    },
                    "mergeData": [{"startRow": 0, "startColumn": 0, "endRow": 0, "endColumn": 1}],
                    "rowData": {"1": {"h": 40.0}},
                    "columnData": {"2": {"w": 120.0}}
                }
            },
            "styles": {}
        });
        let bytes = to_xlsx(&snap, "测试.xlsx").expect("xlsx 写入失败");
        assert!(!bytes.is_empty());
        assert!(bytes[0..2] == *b"PK");
    }

    #[test]
    fn docx_roundtrip_minimal() {
        let snap = serde_json::json!({
            "id": "doc1",
            "title": "测试",
            "documentStyle": {
                "defaultPageSize": {"width": 794.0, "height": 1123.0},
                "defaultParagraphStyle": {
                    "spacing": {"before": 0, "after": 120, "line": 360, "lineRule": 0},
                    "horizontalAlign": 0,
                    "textStyle": {"sz": 12.0, "cl": "#000000"}
                }
            },
            "styles": {
                "h1": {"textStyle": {"sz": 22.0, "b": 1}},
                "h2": {"textStyle": {"sz": 20.0, "b": 1}},
                "h3": {"textStyle": {"sz": 18.0, "b": 1}}
            },
            "lists": {
                "list-1": {
                    "listType": "bullet",
                    "nestingLevel": [{"glyphFormat": "●", "glyphSymbol": "●", "startNumber": 1}]
                },
                "list-2": {
                    "listType": "ordered",
                    "nestingLevel": [{"glyphFormat": "%1.", "glyphType": 2, "startNumber": 1}]
                }
            },
            "body": {
                "dataStream": "大标题\r正文一\r项目一\r项目二\r序号一\r\x1a\x1b\x1cA\x1d\x1cB\x1d\x1e\x1f表后\r",
                "paragraphs": [
                    {"startIndex": 3, "paragraphId": "p0", "paragraphStyle": {"headingId": "h1"}},
                    {"startIndex": 7, "paragraphId": "p1"},
                    {"startIndex": 11, "paragraphId": "p2", "bullet": {"listType": "list-1", "listId": 1, "nestingLevel": 0}},
                    {"startIndex": 15, "paragraphId": "p3", "bullet": {"listType": "list-1", "listId": 1, "nestingLevel": 0}},
                    {"startIndex": 19, "paragraphId": "p4", "bullet": {"listType": "list-2", "listId": 2, "nestingLevel": 0}},
                    {"startIndex": 33, "paragraphId": "p5"}
                ],
                "tables": [{"startIndex": 20, "endIndex": 29, "tableId": "tbl-01"}],
            },
            "tableSource": {
                "tbl-01": {
                    "tableColumns": [{"size": {"type": 1, "width": {"v": 96.0, "u": 3}}},
                                       {"size": {"type": 1, "width": {"v": 96.0, "u": 3}}}]
                }
            }
        });
        let bytes = to_docx(&snap).expect("docx 写入失败");
        assert!(!bytes.is_empty());
        assert!(bytes[0..2] == *b"PK");
    }

    #[test]
    fn dispatch_unknown_unit() {
        let snap = serde_json::json!({});
        assert!(univer_to_office(&snap, "flow", "x").is_err());
    }
}
