//! xlsx / xls / csv → Univer IWorkbookData（M2.1 只读）。
//!
//! xlsx 通过 calamine 的值/公式流 + zipxml 的样式/几何信息拼装；
//! xls 仅有值与合并；csv 全部为文本。

use std::io::Cursor;

use calamine::{Data, DataRef, Reader, Xls, Xlsx};
use chrono::Timelike;
use serde_json::{Map, Value, json};

use crate::zipxml::{SheetGeom, StyleTable};
use crate::{ConvertError, MAX_CELLS};

/// 转换 xlsx 字节为 Univer 工作簿数据模型。
pub fn xlsx_workbook(bytes: &[u8], file_name: &str) -> Result<Value, ConvertError> {
    let mut wb = Xlsx::new(Cursor::new(bytes))
        .map_err(|e| ConvertError::Parse(format!("xlsx 解析失败：{e}")))?;
    let sheets_meta = wb.sheets_metadata().to_vec();

    let zipdata = crate::zipxml::load_xlsx_zip(bytes).map_err(ConvertError::Parse)?;

    // 公式求值环境（全工作簿）：数值单元格 + 公式。用于补齐无缓存值的公式
    // 单元格（openpyxl 等工具写出时不计算）；有缓存值时直接取缓存值。
    let mut formula_book = crate::formula::FormulaBook::new();
    for sh in &sheets_meta {
        if sh.typ != calamine::SheetType::WorkSheet {
            continue;
        }
        let Ok(mut reader) = wb.worksheet_cells_reader(&sh.name) else {
            continue;
        };
        while let Ok(Some(cf)) = reader.next_cell_with_formula() {
            let ref_name = crate::formula::cell_ref(cf.pos.0, cf.pos.1);
            if let Some(f) = cf.formula.as_deref().filter(|f| !f.is_empty()) {
                formula_book.add_formula(&sh.name, &ref_name, f);
            }
            if let Some(n) = ref_numeric(&cf.value) {
                formula_book.add_value(&sh.name, &ref_name, n);
            }
        }
    }

    let mut sheet_order: Vec<String> = Vec::new();
    let mut sheets: Map<String, Value> = Map::new();
    let mut total_cells: u64 = 0;

    for sh in &sheets_meta {
        if sh.typ != calamine::SheetType::WorkSheet {
            continue;
        }
        // 单元格值与公式（借用 wb，作用域限定在此块内）
        let (cell_data, max_row, max_col) = {
            let mut reader = wb
                .worksheet_cells_reader(&sh.name)
                .map_err(|e| ConvertError::Parse(format!("读取工作表 {} 失败：{}", sh.name, e)))?;
            let mut cells: Map<String, Value> = Map::new();
            let mut mr = 0u32;
            let mut mc = 0u32;
            loop {
                match reader.next_cell_with_formula() {
                    Ok(Some(cf)) => {
                        // 公式单元格可能没有缓存值（openpyxl 写入时不计算），必须保留
                        if is_blank(&cf.value) && cf.formula.as_deref().unwrap_or("").is_empty() {
                            continue;
                        }
                        total_cells += 1;
                        if total_cells > MAX_CELLS {
                            return Err(ConvertError::TooLarge);
                        }
                        let (row, col) = cf.pos;
                        mr = mr.max(row);
                        mc = mc.max(col);
                        let geom: Option<&SheetGeom> = zipdata.geoms.get(&sh.name);
                        let s = zipdata.styles.as_ref().and_then(|st| {
                            cell_style_idx(geom, row, col).and_then(|idx| style_data(st, idx))
                        });
                        let (mut v, mut t) = dataref_to_value(&cf.value)?;
                        // 公式无缓存值时用求值器补齐 v（求值失败则只保留 f，
                        // 由 Univer 前端引擎加载后计算）
                        if let Some(f) = &cf.formula
                            && !f.is_empty()
                            && v.is_none()
                            && let Some(ev) = formula_book.eval(f, &sh.name)
                            && ev.is_finite()
                        {
                            v = Some(number_to_json(ev));
                            t = Some(2);
                        }
                        let mut entry = Map::new();
                        if let Some(f) = &cf.formula
                            && !f.is_empty()
                        {
                            entry.insert("f".into(), json!(format!("={f}")));
                        }
                        if let Some(v) = v {
                            entry.insert("v".into(), v);
                        }
                        if let Some(t) = t {
                            entry.insert("t".into(), json!(t));
                        }
                        if let Some(s) = s {
                            entry.insert("s".into(), s);
                        }
                        put_cell(&mut cells, row, col, entry);
                    }
                    Ok(None) => break,
                    Err(e) => {
                        return Err(ConvertError::Parse(format!(
                            "读取工作表 {} 失败：{}",
                            sh.name, e
                        )));
                    }
                }
            }
            (cells, mr, mc)
        };

        // 合并单元格
        let merge_data: Vec<Value> = wb
            .merge_cells_by_sheet_name(&sh.name)
            .map_err(|e| ConvertError::Parse(format!("读取合并单元格失败：{e}")))?
            .into_iter()
            .map(|d| {
                json!({
                    "startRow": d.start.0,
                    "startColumn": d.start.1,
                    "endRow": d.end.0,
                    "endColumn": d.end.1,
                })
            })
            .collect();

        let geom = zipdata.geoms.get(&sh.name).cloned().unwrap_or_default();
        let row_count = max_row_count(max_row);
        let col_count = max_col_count(max_col);

        // 行高 / 列宽
        let mut row_data: Map<String, Value> = Map::new();
        for (r, ht) in &geom.row_heights {
            if *r < row_count {
                row_data.insert(r.to_string(), json!({ "h": pt_to_px(*ht) }));
            }
        }
        let mut col_data: Map<String, Value> = Map::new();
        for (c, w) in &geom.col_widths {
            if *c < col_count {
                col_data.insert(c.to_string(), json!({ "w": col_width_px(*w) }));
            }
        }

        let sid = sheet_id(file_name, &sh.name);
        let sheet = json!({
            "id": sid.clone(),
            "name": sh.name,
            "tabColor": "#000000",
            "hidden": match sh.visible {
                calamine::SheetVisible::Visible => 0,
                calamine::SheetVisible::Hidden => 1,
                calamine::SheetVisible::VeryHidden => 2,
            },
            "rowCount": row_count,
            "columnCount": col_count,
            "defaultColumnWidth": geom.default_col_width.map(col_width_px).unwrap_or(88),
            "defaultRowHeight": geom.default_row_height.map(pt_to_px).unwrap_or(24),
            "zoomRatio": 100,
            "scrollTop": 0,
            "scrollLeft": 0,
            "rowHeader": { "width": 46 },
            "columnHeader": { "height": 24 },
            "showGridlines": 1,
            "rightToLeft": 0,
            "mergeData": merge_data,
            "cellData": cell_data,
            "rowData": row_data,
            "columnData": col_data,
        });
        sheet_order.push(sid.clone());
        sheets.insert(sid, sheet);
    }

    Ok(json!({
        "id": "vento-workbook",
        "name": file_name,
        "appVersion": "1.0.4",
        "locale": "zhCN",
        "styles": {},
        "sheetOrder": sheet_order,
        "sheets": sheets,
    }))
}

/// 转换 xls 字节为 Univer 工作簿数据模型（仅值与合并，无样式）。
pub fn xls_workbook(bytes: &[u8], file_name: &str) -> Result<Value, ConvertError> {
    let mut xls = Xls::new(Cursor::new(bytes))
        .map_err(|e| ConvertError::Parse(format!("xls 解析失败：{e}")))?;
    let sheet_names: Vec<String> = xls.sheet_names().to_vec();

    let mut sheet_order: Vec<String> = Vec::new();
    let mut sheets: Map<String, Value> = Map::new();
    let mut total_cells: u64 = 0;

    for name in &sheet_names {
        let range = xls
            .worksheet_range(name)
            .map_err(|e| ConvertError::Parse(format!("读取工作表 {name} 失败：{e}")))?;

        let mut cells: Map<String, Value> = Map::new();
        let mut mr = 0u32;
        let mut mc = 0u32;
        for (row, row_cells) in range.rows().enumerate() {
            for (col, d) in row_cells.iter().enumerate() {
                let entry: Option<Map<String, Value>> = match d {
                    Data::Int(v) => Some(cell_entry_t(json!(*v), Some(2))),
                    Data::Float(v) => Some(cell_entry_t(json!(*v), Some(2))),
                    Data::Bool(v) => Some(cell_entry_t(json!(*v), Some(3))),
                    Data::String(s) => (!s.is_empty()).then(|| cell_entry_t(json!(s), Some(1))),
                    Data::DateTime(dt) => {
                        let (v, t) = xls_datetime_value(dt);
                        Some(cell_entry_t(v, t))
                    }
                    Data::DateTimeIso(s) | Data::DurationIso(s) => {
                        Some(cell_entry_t(json!(s), Some(1)))
                    }
                    Data::Error(e) => Some(cell_entry_t(json!(e.to_string()), Some(1))),
                    Data::Empty => None,
                };
                if let Some(entry) = entry {
                    put_cell(&mut cells, row as u32, col as u32, entry);
                    total_cells += 1;
                    if total_cells > MAX_CELLS {
                        return Err(ConvertError::TooLarge);
                    }
                    mr = mr.max(row as u32);
                    mc = mc.max(col as u32);
                }
            }
        }

        let merge_data: Vec<Value> = xls
            .merge_cells_by_sheet_name(name)
            .map_err(|e| ConvertError::Parse(format!("读取合并单元格失败：{e}")))?
            .into_iter()
            .map(|d| {
                json!({
                    "startRow": d.start.0,
                    "startColumn": d.start.1,
                    "endRow": d.end.0,
                    "endColumn": d.end.1,
                })
            })
            .collect();

        let sid = sheet_id(file_name, name);
        let sheet = json!({
            "id": sid.clone(),
            "name": name,
            "tabColor": "#000000",
            "hidden": 0,
            "rowCount": max_row_count(mr),
            "columnCount": max_col_count(mc),
            "defaultColumnWidth": 88,
            "defaultRowHeight": 24,
            "zoomRatio": 100,
            "scrollTop": 0,
            "scrollLeft": 0,
            "rowHeader": { "width": 46 },
            "columnHeader": { "height": 24 },
            "showGridlines": 1,
            "rightToLeft": 0,
            "mergeData": merge_data,
            "cellData": cells,
            "rowData": {},
            "columnData": {},
        });
        sheet_order.push(sid.clone());
        sheets.insert(sid, sheet);
    }

    Ok(json!({
        "id": "vento-workbook",
        "name": file_name,
        "appVersion": "1.0.4",
        "locale": "zhCN",
        "styles": {},
        "sheetOrder": sheet_order,
        "sheets": sheets,
    }))
}

/// 转换 CSV/TSV 字节为 Univer 工作簿数据模型（单表，全部文本）。
pub fn csv_workbook(bytes: &[u8], file_name: &str, delim: u8) -> Result<Value, ConvertError> {
    let text = csv_to_text(bytes)?;
    let rows = csv_parse_rows(&text, delim);

    let mut cells: Map<String, Value> = Map::new();
    let mut mr = 0u32;
    let mut mc = 0u32;
    let mut total: u64 = 0;
    for (r, row) in rows.iter().enumerate() {
        let all_empty = row.iter().all(|f| f.is_empty());
        if all_empty {
            continue;
        }
        for (c, f) in row.iter().enumerate() {
            if f.is_empty() {
                continue;
            }
            total += 1;
            if total > MAX_CELLS {
                return Err(ConvertError::TooLarge);
            }
            mr = mr.max(r as u32);
            mc = mc.max(c as u32);
            put_cell(
                &mut cells,
                r as u32,
                c as u32,
                cell_entry_t(json!(f), Some(1)),
            );
        }
    }

    let stem = file_name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .filter(|s| !s.is_empty())
        .unwrap_or("Sheet1");

    let sid = sheet_id(file_name, stem);
    let sheet = json!({
        "id": sid.clone(),
        "name": stem,
        "tabColor": "#000000",
        "hidden": 0,
        "rowCount": max_row_count(mr),
        "columnCount": max_col_count(mc),
        "defaultColumnWidth": 88,
        "defaultRowHeight": 24,
        "zoomRatio": 100,
        "scrollTop": 0,
        "scrollLeft": 0,
        "rowHeader": { "width": 46 },
        "columnHeader": { "height": 24 },
        "showGridlines": 1,
        "rightToLeft": 0,
        "mergeData": [],
        "cellData": cells,
        "rowData": {},
        "columnData": {},
    });
    let mut sheets = Map::new();
    sheets.insert(sid.clone(), sheet);
    Ok(json!({
        "id": "vento-workbook",
        "name": file_name,
        "appVersion": "1.0.4",
        "locale": "zhCN",
        "styles": {},
        "sheetOrder": [sid],
        "sheets": sheets,
    }))
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/// 构造 Univer 单元格对象 `{v, t}`（t 可选）。
fn cell_entry_t(v: Value, t: Option<u8>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("v".into(), v);
    if let Some(t) = t {
        m.insert("t".into(), json!(t));
    }
    m
}

/// 向 Univer cellData 结构写入一个单元格（行/列 0-based，行对象为 JSON object）。
fn put_cell(cells: &mut Map<String, Value>, row: u32, col: u32, entry: Map<String, Value>) {
    let row_val = cells
        .entry(row.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(row_obj) = row_val.as_object_mut() {
        row_obj.insert(col.to_string(), Value::Object(entry));
    }
}

pub(crate) fn max_row_count(mr: u32) -> u32 {
    mr.max(20)
}

pub(crate) fn max_col_count(mc: u32) -> u32 {
    mc.max(10)
}

pub(crate) fn col_width_px(chars: f64) -> u32 {
    (chars * 7.0).round() as u32 + 5
}

pub(crate) fn pt_to_px(pt: f64) -> u32 {
    (pt * 96.0 / 72.0).round() as u32
}

fn cell_style_idx(geom: Option<&SheetGeom>, row: u32, col: u32) -> Option<u32> {
    geom.and_then(|g| g.cell_styles.get(&(row, col)).copied())
}

/// DataRef（xlsx 单元格值）→ (json 值, Univer 类型码)。
/// 数值单元格 → f64（构建公式求值环境用；非数值返回 None）。
fn ref_numeric(d: &DataRef) -> Option<f64> {
    match d {
        DataRef::Int(v) => Some(*v as f64),
        DataRef::Float(v) => Some(*v),
        _ => None,
    }
}

/// 生成 Univer 格式的 sheet id（`sheet-s-` + 12 位十六进制）。
/// 由文件名与表名做 FNV-1a 哈希派生：同一文件重复转换结果稳定，
/// 与 Univer 自身 `createWorkbook` 生成的 id 形态一致（sheets 以 id 为键）。
pub(crate) fn sheet_id(file_name: &str, sheet_name: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in file_name.as_bytes().iter().chain(sheet_name.as_bytes()) {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("sheet-s-{h:012x}")
}

/// 数值序列化为 JSON：整数值输出 JSON 整数，与 Excel 原生表示一致（`42` 而非 `42.0`）。
pub(crate) fn number_to_json(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < (i64::MAX as f64) {
        json!(v as i64)
    } else {
        json!(v)
    }
}

pub(crate) fn dataref_to_value(d: &DataRef) -> Result<(Option<Value>, Option<u8>), ConvertError> {
    match d {
        DataRef::Int(v) => Ok((Some(json!(v)), Some(2))),
        DataRef::Float(v) => Ok((Some(number_to_json(*v)), Some(2))),
        DataRef::Bool(v) => Ok((Some(json!(v)), Some(3))),
        DataRef::String(s) => {
            if s.is_empty() {
                Ok((None, None))
            } else {
                Ok((Some(json!(s)), Some(1)))
            }
        }
        DataRef::SharedString(s) => {
            if s.is_empty() {
                Ok((None, None))
            } else {
                Ok((Some(json!(s)), Some(1)))
            }
        }
        DataRef::DateTime(dt) => Ok(excel_datetime_value(dt)),
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => Ok((Some(json!(s)), Some(1))),
        DataRef::Error(e) => Ok((Some(json!(e.to_string())), Some(1))),
        DataRef::Empty => Ok((None, None)),
    }
}

/// 单元格是否为空白（Empty 或空字符串）。
fn is_blank(d: &DataRef) -> bool {
    match d {
        DataRef::Empty => true,
        DataRef::String(s) => s.is_empty(),
        DataRef::SharedString(s) => s.is_empty(),
        _ => false,
    }
}

/// Excel 日期时间/时长 → Univer 值。日期按 ISO 文本存储（Univer 文本可展示），
/// 时长按 H:MM:SS 文本；解析失败回退为原始数值。
pub(crate) fn excel_datetime_value(dt: &calamine::ExcelDateTime) -> (Option<Value>, Option<u8>) {
    if dt.is_duration()
        && let Some(d) = dt.as_duration()
    {
        let total_secs = d.num_seconds().abs();
        let h = total_secs / 3600;
        let m = (total_secs % 3600) / 60;
        let s = total_secs % 60;
        let days = h / 24;
        let hh = h % 24;
        let s = if days > 0 {
            format!("{days}d:{hh:02}:{m:02}:{s:02}")
        } else {
            format!("{h:02}:{m:02}:{s:02}")
        };
        return (Some(json!(s)), Some(1));
    }
    if let Some(naive) = dt.as_datetime() {
        let s =
            if naive.time().hour() == 0 && naive.time().minute() == 0 && naive.time().second() == 0
            {
                naive.format("%Y-%m-%d").to_string()
            } else {
                naive.format("%Y-%m-%d %H:%M:%S").to_string()
            };
        return (Some(json!(s)), Some(1));
    }
    (Some(json!(dt.as_f64())), Some(2))
}

/// xls 的 `Data::DateTime`（值）→ Univer 值。
pub(crate) fn xls_datetime_value(dt: &calamine::ExcelDateTime) -> (Value, Option<u8>) {
    let (v, t) = excel_datetime_value(dt);
    (v.unwrap_or(json!(dt.as_f64())), t.or(Some(2)))
}

/// 由 xf 索引生成 Univer 样式对象（空样式返回 None）。
fn style_data(st: &StyleTable, idx: u32) -> Option<Value> {
    let xf = st.cell_xfs.get(idx as usize)?.clone();
    let base = st.cell_style_xfs.get(xf.xf_id as usize);
    let font = st.fonts.get(xf.font as usize);
    let fill = st.fills.get(xf.fill as usize);
    let border = st.borders.get(xf.border as usize);

    let (horizontal, vertical, wrap) = if xf.apply_alignment {
        (xf.horizontal, xf.vertical, xf.wrap_text)
    } else {
        let b = base.filter(|&b| b.apply_alignment);
        (
            b.and_then(|b| b.horizontal.clone()),
            b.and_then(|b| b.vertical.clone()),
            b.is_some_and(|b| b.wrap_text),
        )
    };

    let mut s = Map::new();

    if let Some(f) = font {
        if f.bold {
            // Univer sheet 粗体键为 "b"（"bl" 是左边框键）
            s.insert("b".into(), json!(1));
        }
        if f.italic {
            s.insert("i".into(), json!(1));
        }
        if f.underline {
            s.insert("u".into(), json!({ "s": 1 }));
        }
        if f.strike {
            s.insert("st".into(), json!({ "s": 1 }));
        }
        if let Some(sz) = f.sz_half_pt {
            s.insert("sz".into(), json!(sz as f64 / 2.0));
        }
        if let Some(c) = &f.color
            && c != "#000000"
        {
            s.insert("cl".into(), json!({ "rgb": c }));
        }
    }

    if let Some(Some(bg)) = fill
        && bg != "#000000"
        && bg != "#FFFFFF"
    {
        s.insert("bg".into(), json!({ "rgb": bg }));
    }

    if let Some(h) = &horizontal {
        let ht = match h.as_str() {
            "left" => 1,
            "center" => 2,
            "right" => 3,
            "justify" => 4,
            _ => 0,
        };
        s.insert("ht".into(), json!(ht));
    }
    if let Some(v) = &vertical {
        let vt = match v.as_str() {
            "center" | "middle" => 1,
            "bottom" | "distributed" => 2,
            _ => 0,
        };
        s.insert("vt".into(), json!(vt));
    }
    if wrap {
        s.insert("tb".into(), json!({ "s": 1 }));
    }

    if let Some(b) = border {
        for (key, side) in [
            ("bl", &b.left),
            ("br", &b.right),
            ("bt", &b.top),
            ("bb", &b.bottom),
        ] {
            if side.has {
                let rgb = side.color.clone().unwrap_or_else(|| "#000000".into());
                s.insert(key.into(), json!({ "s": 1, "cl": { "rgb": rgb } }));
            }
        }
    }

    if s.is_empty() {
        None
    } else {
        Some(Value::Object(s))
    }
}

/// CSV 字节 → UTF-8 文本（BOM 去除；非 UTF-8 按 GB18030 转码）。
fn csv_to_text(bytes: &[u8]) -> Result<String, ConvertError> {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => {
            let (s, _, _) = encoding_rs::GB18030.decode(b);
            Ok(s.into_owned())
        }
    }
}

/// RFC 4180 状态机解析 CSV 行。
pub(crate) fn csv_parse_rows(text: &str, delim: u8) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut at_field_start = true;
    let mut after_close_quote = false;

    for ch in text.chars() {
        if in_quotes {
            if ch == '"' {
                in_quotes = false;
                after_close_quote = true;
            } else {
                field.push(ch);
            }
            continue;
        }
        if after_close_quote {
            after_close_quote = false;
            if ch == '"' {
                // RFC4180：闭引号后紧跟引号 = 字面量 "
                field.push('"');
                in_quotes = true;
                continue;
            }
            if (ch as u8) == delim || ch == '\n' {
                row.push(std::mem::take(&mut field));
                if ch == '\n' {
                    if !row.iter().all(String::is_empty) {
                        rows.push(std::mem::take(&mut row));
                    } else {
                        row.clear();
                    }
                }
                at_field_start = true;
                continue;
            }
            if ch == '\r' {
                continue;
            }
            // 闭引号后的杂散字符按字面量处理
            field.push(ch);
            at_field_start = false;
            continue;
        }
        match ch {
            '"' if at_field_start => {
                in_quotes = true;
                at_field_start = false;
            }
            d if d as u8 == delim => {
                row.push(std::mem::take(&mut field));
                at_field_start = true;
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                if !row.iter().all(String::is_empty) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
                at_field_start = true;
            }
            '\r' => {}
            _ => {
                field.push(ch);
                at_field_start = false;
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{Data, DataRef, ExcelDateTime, ExcelDateTimeType};
    use chrono::{Duration, NaiveDate, NaiveTime};

    #[test]
    fn px_helpers() {
        assert_eq!(col_width_px(8.43), 64); // 8.43*7 = 59.01 → 59 + 5
        assert_eq!(col_width_px(10.0), 75); // 70 + 5
        assert_eq!(pt_to_px(11.0), 15); // 14.67 → 15
        assert_eq!(pt_to_px(12.75), 17); // 17.0
        assert_eq!(pt_to_px(15.0), 20);
        assert_eq!(max_row_count(3), 20);
        assert_eq!(max_row_count(50), 50);
        assert_eq!(max_col_count(4), 10);
        assert_eq!(max_col_count(11), 11);
    }

    #[test]
    fn csv_quotes_and_delimiters() {
        // 基本
        assert_eq!(
            csv_parse_rows("a,b,c\n1,2,3\n", b','),
            vec![
                vec!["a".to_string(), "b".into(), "c".into()],
                vec!["1".into(), "2".into(), "3".into()]
            ]
        );
        // 引号内分隔符
        assert_eq!(
            csv_parse_rows("a,\"b,c\",d\n", b','),
            vec![vec!["a".to_string(), "b,c".into(), "d".into()]]
        );
        // RFC4180 转义引号 ""
        assert_eq!(
            csv_parse_rows("a,\"b\"\"c\",d\n", b','),
            vec![vec!["a".to_string(), "b\"c".into(), "d".into()]]
        );
        // CRLF
        assert_eq!(
            csv_parse_rows("a,b\r\nc,d\r\n", b','),
            vec![
                vec!["a".to_string(), "b".into()],
                vec!["c".to_string(), "d".into()]
            ]
        );
        // 跨行引号字段
        assert_eq!(
            csv_parse_rows("a,\"line1\nline2\",c\n", b','),
            vec![vec!["a".to_string(), "line1\nline2".into(), "c".into()]]
        );
        // 行尾空字段保留
        assert_eq!(
            csv_parse_rows("a,\n", b','),
            vec![vec!["a".to_string(), String::new()]]
        );
        // 全空行跳过
        assert_eq!(
            csv_parse_rows("a\n\nb\n", b','),
            vec![vec!["a".to_string()], vec!["b".to_string()]]
        );
        assert!(csv_parse_rows("\n\n", b',').is_empty());
        // 无尾随换行
        assert_eq!(
            csv_parse_rows("a,b", b','),
            vec![vec!["a".to_string(), "b".to_string()]]
        );
        // TSV
        assert_eq!(
            csv_parse_rows("a\tb\n1\t2\n", b'\t'),
            vec![
                vec!["a".to_string(), "b".to_string()],
                vec!["1".to_string(), "2".to_string()]
            ]
        );
    }

    #[test]
    fn dataref_mapping() {
        assert_eq!(
            dataref_to_value(&to_ref(&Data::Int(10))).unwrap(),
            (Some(json!(10)), Some(2))
        );
        assert_eq!(
            dataref_to_value(&to_ref(&Data::Float(3.5))).unwrap(),
            (Some(json!(3.5)), Some(2))
        );
        assert_eq!(
            dataref_to_value(&to_ref(&Data::Bool(true))).unwrap(),
            (Some(json!(true)), Some(3))
        );
        assert_eq!(
            dataref_to_value(&DataRef::SharedString("你好")).unwrap(),
            (Some(json!("你好")), Some(1))
        );
        assert_eq!(
            dataref_to_value(&to_ref(&Data::String(String::new()))).unwrap(),
            (None, None)
        );
        assert_eq!(
            dataref_to_value(&to_ref(&Data::Empty)).unwrap(),
            (None, None)
        );
        assert!(is_blank(&to_ref(&Data::Empty)));
        assert!(is_blank(&to_ref(&Data::String(String::new()))));
        assert!(!is_blank(&to_ref(&Data::Int(0))));
    }

    /// 测试辅助：Data → DataRef（calamine 无现成 From 实现）。
    fn to_ref<'a>(d: &'a Data) -> DataRef<'a> {
        match d {
            Data::Int(v) => DataRef::Int(*v),
            Data::Float(v) => DataRef::Float(*v),
            Data::Bool(v) => DataRef::Bool(*v),
            Data::String(s) => DataRef::String(s.clone()),
            Data::DateTime(dt) => DataRef::DateTime(*dt),
            Data::DateTimeIso(s) => DataRef::DateTimeIso(s.clone()),
            Data::DurationIso(s) => DataRef::DurationIso(s.clone()),
            Data::Error(e) => DataRef::Error(e.clone()),
            Data::Empty => DataRef::Empty,
        }
    }

    #[test]
    fn excel_datetime_values() {
        // 纯日期：1900 epoch，45458 天（用 chrono 独立核算）
        let expected = (NaiveDate::from_ymd_opt(1899, 12, 30).unwrap() + Duration::days(45458))
            .and_time(NaiveTime::MIN)
            .format("%Y-%m-%d")
            .to_string();
        let dt = ExcelDateTime::new(45458.0, ExcelDateTimeType::DateTime, false);
        let (v, t) = excel_datetime_value(&dt);
        assert_eq!(v, Some(json!(expected)));
        assert_eq!(t, Some(1));

        // 含时间
        let dt = ExcelDateTime::new(45458.5, ExcelDateTimeType::DateTime, false);
        let (v, _) = excel_datetime_value(&dt);
        let val = v.unwrap();
        let s = val.as_str().unwrap();
        assert!(s.ends_with("12:00:00"), "expected 12:00:00 tail, got {s}");

        // 时长 1.5 天 → 1d:12:00:00
        let dur = ExcelDateTime::new(1.5, ExcelDateTimeType::TimeDelta, false);
        assert!(dur.is_duration());
        let (v, t) = excel_datetime_value(&dur);
        assert_eq!(v, Some(json!("1d:12:00:00")));
        assert_eq!(t, Some(1));

        // 1904 epoch：0.0 → 1904-01-01
        let dt1904 = ExcelDateTime::new(0.0, ExcelDateTimeType::DateTime, true);
        let (v, _) = excel_datetime_value(&dt1904);
        let val = v.unwrap();
        let s = val.as_str().unwrap();
        assert!(s.starts_with("1904-01-01"), "got {s}");
    }
}
