//! xlsx zip 内 XML 解析：xl/styles.xml（样式表）与 worksheet XML（列宽/行高/单元格样式索引）。
//!
//! calamine 0.37 未提供公开的样式 API，这里用 quick-xml 0.42 手写状态机解析。
//! 仅提取 Univer 预览所需的最小样式子集。

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

/// 单元格字体信息。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FontInfo {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// 半磅值（与 OOXML sz 一致），None = 未设置。
    pub sz_half_pt: Option<u32>,
    pub color: Option<String>,
}

/// 边框单侧。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BorderSide {
    pub has: bool,
    pub color: Option<String>,
}

/// 单元格边框。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BorderInfo {
    pub left: BorderSide,
    pub right: BorderSide,
    pub top: BorderSide,
    pub bottom: BorderSide,
}

/// cellXfs 单元格格式。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct XfInfo {
    pub num_fmt: u32,
    pub font: u32,
    pub fill: u32,
    pub border: u32,
    pub xf_id: u32,
    pub apply_alignment: bool,
    pub horizontal: Option<String>,
    pub vertical: Option<String>,
    pub wrap_text: bool,
}

/// xl/styles.xml 解析结果。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StyleTable {
    pub fonts: Vec<FontInfo>,
    pub fills: Vec<Option<String>>,
    pub borders: Vec<BorderInfo>,
    pub cell_style_xfs: Vec<XfInfo>,
    pub cell_xfs: Vec<XfInfo>,
}

/// 工作表几何信息。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SheetGeom {
    pub default_col_width: Option<f64>,
    pub default_row_height: Option<f64>,
    pub col_widths: BTreeMap<u32, f64>,
    pub row_heights: BTreeMap<u32, f64>,
    pub cell_styles: BTreeMap<(u32, u32), u32>,
}

/// 整个 zip 包解析结果。
#[derive(Debug, Default)]
pub struct ZipData {
    pub styles: Option<StyleTable>,
    pub geoms: BTreeMap<String, SheetGeom>,
}

/// 解析 xlsx 字节中的样式表与各工作表几何信息（geoms 以工作表名为键）。
pub fn load_xlsx_zip(bytes: &[u8]) -> Result<ZipData, String> {
    let mut zip =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("zip 打开失败：{e}"))?;

    let styles = read_entry(&mut zip, "xl/styles.xml")
        .map(|raw| parse_styles(&raw))
        .transpose()
        .map_err(|e| format!("styles.xml 解析失败：{e}"))?;

    let name_paths = sheet_name_paths(&mut zip)?;
    let mut geoms = BTreeMap::new();
    for (name, path) in &name_paths {
        if let Some(raw) = read_entry(&mut zip, path)
            && let Ok(g) = parse_sheet_geom(&raw) {
                geoms.insert(name.clone(), g);
            }
    }
    Ok(ZipData {
        styles,
        geoms,
    })
}

/// 从 xl/workbook.xml 与 xl/_rels/workbook.xml.rels 解析
/// 工作表名 -> 工作表 xml 路径（保持 workbook 中的声明顺序）。
fn sheet_name_paths(zip: &mut ZipArchive<Cursor<&[u8]>>) -> Result<Vec<(String, String)>, String> {
    let wb = read_entry(zip, "xl/workbook.xml").ok_or("找不到 xl/workbook.xml")?;
    let rels = read_entry(zip, "xl/_rels/workbook.xml.rels")
        .ok_or("找不到 xl/_rels/workbook.xml.rels")?;
    let rels_map = parse_rels(&rels)?;
    let ordered = parse_workbook_sheets(&wb)?;
    let mut out = Vec::new();
    for (name, rid) in ordered {
        if let Some(target) = rels_map.get(&rid) {
            let path = format!("xl/{}", target.trim_start_matches('/'));
            out.push((name, path));
        }
    }
    Ok(out)
}

/// 解析 rels：Relationship Id -> Target。
fn parse_rels(xml: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = BTreeMap::new();
    while let Ok(event) = reader.read_event_into(&mut buf) {
        match event {
            Event::Start(e) if e.local_name().into_inner() == "Relationship" => {
                let id = attr(e.attributes(), "Id").unwrap_or_default();
                let target = attr(e.attributes(), "Target").unwrap_or_default();
                if !id.is_empty() && !target.is_empty() {
                    out.insert(id, target);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// 解析 workbook.xml 的 `<sheet name r:id>` 声明（按顺序）。
fn parse_workbook_sheets(xml: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    while let Ok(event) = reader.read_event_into(&mut buf) {
        match event {
            Event::Start(e) if e.local_name().into_inner() == "sheet" => {
                let name = attr(e.attributes(), "name").unwrap_or_default();
                // r:id 的 local name 为 "id"
                let rid = attr(e.attributes(), "id").unwrap_or_default();
                if !name.is_empty() {
                    out.push((name, rid));
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn read_entry(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return None;
    }
    Some(buf)
}

/// 把 quick-xml 的读取错误包装成字符串。
fn xerr(e: quick_xml::Error) -> String {
    format!("{e}")
}

fn attr(attrs: quick_xml::events::attributes::Attributes, key: &str) -> Option<String> {
    for a in attrs {
        if let Ok(a) = a
            && a.key.local_name().into_inner() == key {
                return Some(a.value.to_string());
            }
    }
    None
}

/// 解析 xl/styles.xml。
fn parse_styles(xml: &[u8]) -> Result<StyleTable, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();

    let mut fonts: Vec<FontInfo> = Vec::new();
    let mut fills: Vec<Option<String>> = Vec::new();
    let mut borders: Vec<BorderInfo> = Vec::new();
    let mut cell_style_xfs: Vec<XfInfo> = Vec::new();
    let mut cell_xfs: Vec<XfInfo> = Vec::new();

    // 当前 section 与待解析的 xf 对齐信息
    let mut section: Option<&'static str> = None;
    let mut pending_xf: Option<XfInfo> = None;
    // 字体解析状态
    let mut pending_font: Option<FontInfo> = None;
    // 边框解析状态
    let mut pending_border: Option<BorderInfo> = None;
    // fill 解析状态
    let mut pending_fill: Option<Option<String>> = None;
    // xf 对齐状态
    let mut pending_align: Option<(Option<String>, Option<String>, bool)> = None;

    loop {
        buf.clear();
        let event = reader.read_event_into(&mut buf).map_err(xerr)?;
        match event {
            Event::Start(e) => {
                let name = e.local_name().into_inner();
                match name {
                    "fonts" | "fills" | "borders" | "cellStyleXfs" | "cellXfs" => {
                        section = Some(match name {
                            "fonts" => "fonts",
                            "fills" => "fills",
                            "borders" => "borders",
                            "cellStyleXfs" => "cellStyleXfs",
                            _ => "cellXfs",
                        });
                    }
                    "font" => {
                        if section == Some("fonts") {
                            pending_font = Some(FontInfo::default());
                        }
                    }
                    "b" | "i" | "s" => {
                        if section == Some("fonts") && let Some(f) = pending_font.as_mut() {
                            let off = attr(e.attributes(), "val").as_deref() == Some("0");
                            match name {
                                "b" => f.bold = !off,
                                "i" => f.italic = !off,
                                _ => {
                                    f.underline = !off
                                        && attr(e.attributes(), "val")
                                            .as_deref()
                                            .map(|v| v != "none")
                                            .unwrap_or(true)
                                }
                            }
                        }
                    }
                    "u" => {
                        if section == Some("fonts")
                            && let Some(f) = pending_font.as_mut()
                            && attr(e.attributes(), "val").as_deref() != Some("none")
                        {
                            f.underline = true;
                        }
                    }
                    "sz" => {
                        if section == Some("fonts")
                            && let Some(f) = pending_font.as_mut()
                            && let Some(v) = attr(e.attributes(), "val").and_then(|v| v.parse().ok())
                        {
                            f.sz_half_pt = Some(v);
                        }
                    }
                    "color" => {
                        if section == Some("fonts")
                            && let Some(f) = pending_font.as_mut()
                            && let Some(rgb) = attr(e.attributes(), "rgb")
                            && let Some(hex) = rgb_hex(&rgb)
                        {
                            f.color = Some(hex);
                        }
                    }
                    "fill" => {
                        if section == Some("fills") {
                            pending_fill = Some(None);
                        }
                    }
                    "patternFill" => {
                        if section == Some("fills") && pending_fill.is_some() {
                            if let Some(pt) = attr(e.attributes(), "patternType") {
                                if pt == "solid" {
                                    // fgColor 在后续事件处理
                                } else {
                                    pending_fill = Some(None);
                                }
                            } else {
                                pending_fill = Some(None);
                            }
                        }
                    }
                    "fgColor" => {
                        if section == Some("fills")
                            && let Some(rgb) = attr(e.attributes(), "rgb")
                                && let Some(hex) = rgb_hex(&rgb) {
                                    pending_fill = Some(Some(hex));
                                }
                    }
                    "border" => {
                        if section == Some("borders") {
                            pending_border = Some(BorderInfo::default());
                        }
                    }
                    "left" | "right" | "top" | "bottom" | "start" | "end" => {
                        if section == Some("borders") && let Some(b) = pending_border.as_mut() {
                            let side = if name == "start" {
                                "left"
                            } else if name == "end" {
                                "right"
                            } else {
                                name
                            };
                            let style = attr(e.attributes(), "style");
                            let on = style
                                .as_deref()
                                .map(|s| !s.is_empty() && s != "none")
                                .unwrap_or(false);
                            let color = attr(e.attributes(), "color")
                                .and_then(|c| rgb_hex(&c));
                            let side_obj = match side {
                                "left" => &mut b.left,
                                "right" => &mut b.right,
                                "top" => &mut b.top,
                                _ => &mut b.bottom,
                            };
                            if on {
                                side_obj.has = true;
                                side_obj.color = color;
                            }
                        }
                    }
                    "xf" => {
                        let mut xf = XfInfo {
                            num_fmt: attr(e.attributes(), "numFmtId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            font: attr(e.attributes(), "fontId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            fill: attr(e.attributes(), "fillId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            border: attr(e.attributes(), "borderId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            xf_id: attr(e.attributes(), "xfId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            apply_alignment: attr(e.attributes(), "applyAlignment")
                                .map(|v| v == "1" || v == "true")
                                .unwrap_or(false),
                            horizontal: None,
                            vertical: None,
                            wrap_text: false,
                        };
                        if let Some(w) = attr(e.attributes(), "wrapText") {
                            xf.wrap_text = w == "1" || w == "true";
                        }
                        pending_xf = Some(xf);
                        pending_align = None;
                    }
                    "alignment" => {
                        let h = attr(e.attributes(), "horizontal");
                        let v = attr(e.attributes(), "vertical");
                        let w = attr(e.attributes(), "wrapText")
                            .map(|x| x == "1" || x == "true")
                            .unwrap_or(false);
                        pending_align = Some((h, v, w));
                    }
                    _ => {}
                }
            }
            // 自闭合标签同样到达（如 <b/>、<sz val="11"/>、<color rgb="..."/>、
            // <xf .../> 形态），属性型标签与 Start 共用处理逻辑；
            // 容器型（font/fill/border/xf）因没有后续 End 事件必须立即定稿。
            Event::Empty(e) => {
                let name = e.local_name().into_inner();
                match name {
                    "fonts" | "fills" | "borders" | "cellStyleXfs" | "cellXfs" => {
                        section = Some(match name {
                            "fonts" => "fonts",
                            "fills" => "fills",
                            "borders" => "borders",
                            "cellStyleXfs" => "cellStyleXfs",
                            _ => "cellXfs",
                        });
                    }
                    "font" => {
                        if section == Some("fonts") {
                            fonts.push(FontInfo::default());
                        }
                    }
                    "b" | "i" | "s" => {
                        if section == Some("fonts") && let Some(f) = pending_font.as_mut() {
                            let off = attr(e.attributes(), "val").as_deref() == Some("0");
                            match name {
                                "b" => f.bold = !off,
                                "i" => f.italic = !off,
                                _ => {
                                    f.underline = !off
                                        && attr(e.attributes(), "val")
                                            .as_deref()
                                            .map(|v| v != "none")
                                            .unwrap_or(true)
                                }
                            }
                        }
                    }
                    "u" => {
                        if section == Some("fonts")
                            && let Some(f) = pending_font.as_mut()
                            && attr(e.attributes(), "val").as_deref() != Some("none")
                        {
                            f.underline = true;
                        }
                    }
                    "sz" => {
                        if section == Some("fonts")
                            && let Some(f) = pending_font.as_mut()
                            && let Some(v) = attr(e.attributes(), "val").and_then(|v| v.parse().ok())
                        {
                            f.sz_half_pt = Some(v);
                        }
                    }
                    "color" => {
                        if section == Some("fonts")
                            && let Some(f) = pending_font.as_mut()
                            && let Some(rgb) = attr(e.attributes(), "rgb")
                            && let Some(hex) = rgb_hex(&rgb)
                        {
                            f.color = Some(hex);
                        }
                    }
                    "fill" => {
                        if section == Some("fills") {
                            fills.push(None);
                        }
                    }
                    "patternFill" => {
                        if section == Some("fills") && pending_fill.is_some() {
                            if let Some(pt) = attr(e.attributes(), "patternType") {
                                if pt != "solid" {
                                    pending_fill = Some(None);
                                }
                            } else {
                                pending_fill = Some(None);
                            }
                        }
                    }
                    "fgColor" => {
                        if section == Some("fills")
                            && let Some(rgb) = attr(e.attributes(), "rgb")
                                && let Some(hex) = rgb_hex(&rgb) {
                                    pending_fill = Some(Some(hex));
                                }
                    }
                    "border" => {
                        if section == Some("borders") {
                            borders.push(BorderInfo::default());
                        }
                    }
                    "left" | "right" | "top" | "bottom" | "start" | "end" => {
                        if section == Some("borders") && let Some(b) = pending_border.as_mut() {
                            let side = if name == "start" {
                                "left"
                            } else if name == "end" {
                                "right"
                            } else {
                                name
                            };
                            let style = attr(e.attributes(), "style");
                            let on = style
                                .as_deref()
                                .map(|s| !s.is_empty() && s != "none")
                                .unwrap_or(false);
                            let color = attr(e.attributes(), "color")
                                .and_then(|c| rgb_hex(&c));
                            let side_obj = match side {
                                "left" => &mut b.left,
                                "right" => &mut b.right,
                                "top" => &mut b.top,
                                _ => &mut b.bottom,
                            };
                            if on {
                                side_obj.has = true;
                                side_obj.color = color;
                            }
                        }
                    }
                    "xf" => {
                        let mut xf = XfInfo {
                            num_fmt: attr(e.attributes(), "numFmtId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            font: attr(e.attributes(), "fontId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            fill: attr(e.attributes(), "fillId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            border: attr(e.attributes(), "borderId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            xf_id: attr(e.attributes(), "xfId")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(0),
                            apply_alignment: attr(e.attributes(), "applyAlignment")
                                .map(|v| v == "1" || v == "true")
                                .unwrap_or(false),
                            horizontal: None,
                            vertical: None,
                            wrap_text: false,
                        };
                        if let Some(w) = attr(e.attributes(), "wrapText") {
                            xf.wrap_text = w == "1" || w == "true";
                        }
                        match section {
                            Some("cellStyleXfs") => cell_style_xfs.push(xf),
                            Some("cellXfs") => cell_xfs.push(xf),
                            _ => {}
                        }
                        pending_align = None;
                    }
                    "alignment" => {
                        let h = attr(e.attributes(), "horizontal");
                        let v = attr(e.attributes(), "vertical");
                        let w = attr(e.attributes(), "wrapText")
                            .map(|x| x == "1" || x == "true")
                            .unwrap_or(false);
                        pending_align = Some((h, v, w));
                    }
                    _ => {}
                }
            }
            Event::End(e) => {
                let name = e.local_name().into_inner();
                match name {
                    "fonts" | "fills" | "borders" | "cellStyleXfs" | "cellXfs" => {
                        section = None;
                    }
                    "font" => {
                        if let Some(f) = pending_font.take() {
                            fonts.push(f);
                        }
                    }
                    "fill" => {
                        if let Some(f) = pending_fill.take() {
                            fills.push(f);
                        }
                    }
                    "border" => {
                        if let Some(b) = pending_border.take() {
                            borders.push(b);
                        }
                    }
                    "xf" => {
                        if let Some(mut xf) = pending_xf.take() {
                            if let Some((h, v, w)) = pending_align.take() {
                                xf.horizontal = h;
                                xf.vertical = v;
                                xf.wrap_text = xf.wrap_text || w;
                                if xf.horizontal.is_some() || xf.vertical.is_some() {
                                    xf.apply_alignment = true;
                                }
                            }
                            match section {
                                Some("cellStyleXfs") => cell_style_xfs.push(xf),
                                Some("cellXfs") => cell_xfs.push(xf),
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(StyleTable {
        fonts,
        fills,
        borders,
        cell_style_xfs,
        cell_xfs,
    })
}

/// 解析 worksheet XML 的列宽/行高/单元格样式索引。
fn parse_sheet_geom(xml: &[u8]) -> Result<SheetGeom, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();

    let mut geom = SheetGeom::default();
    let mut in_cols = false;

    loop {
        buf.clear();
        let event = reader.read_event_into(&mut buf).map_err(xerr)?;
        match event {
            // self-closing 标签（如 <col .../>、<sheetFormatPr .../>、<c r s/>）
            // 在 quick-xml 0.42 中同样以 Empty 事件到达，需一并处理。
            Event::Start(e) | Event::Empty(e) => {
                let name = e.local_name().into_inner();
                match name {
                    "sheetFormatPr" => {
                        if let Some(w) = attr(e.attributes(), "defaultColWidth").and_then(|v| v.parse().ok()) {
                            geom.default_col_width = Some(w);
                        }
                        if let Some(h) = attr(e.attributes(), "defaultRowHeight").and_then(|v| v.parse().ok()) {
                            geom.default_row_height = Some(h);
                        }
                    }
                    "cols" => in_cols = true,
                    "col" => {
                        if in_cols {
                            let min = attr(e.attributes(), "min")
                                .and_then(|v| v.parse::<u32>().ok());
                            let max = attr(e.attributes(), "max")
                                .and_then(|v| v.parse::<u32>().ok());
                            let width = attr(e.attributes(), "width")
                                .and_then(|v| v.parse::<f64>().ok());
                            if let (Some(min), Some(max), Some(width)) = (min, max, width) {
                                for c in min - 1..max {
                                    geom.col_widths.insert(c, width);
                                }
                            }
                        }
                    }
                    "row" => {
                        if let (Some(r), Some(ht)) = (
                            attr(e.attributes(), "r").and_then(|v| v.parse::<u32>().ok()),
                            attr(e.attributes(), "ht").and_then(|v| v.parse::<f64>().ok()),
                        ) {
                            geom.row_heights.insert(r - 1, ht);
                        }
                    }
                    "c" => {
                        if let Some(ref_) = attr(e.attributes(), "r")
                            && let Some((row, col)) = parse_cell_ref(&ref_)
                                && let Some(s) = attr(e.attributes(), "s").and_then(|v| v.parse::<u32>().ok())
                                {
                                    geom.cell_styles.insert((row, col), s);
                                }
                    }
                    _ => {}
                }
            }
            Event::End(e) => {
                let name = e.local_name().into_inner();
                match name {
                    "cols" => in_cols = false,
                    "row" => {}
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(geom)
}

/// 解析单元格引用 "BC23" → (row, col) 0-based。
fn parse_cell_ref(ref_: &str) -> Option<(u32, u32)> {
    let mut col = 0u32;
    let mut col_done = false;
    for ch in ref_.chars() {
        if ch.is_ascii_alphabetic() {
            col = col * 26 + (ch.to_ascii_uppercase() as u32 - 64);
            col_done = true;
        } else if ch.is_ascii_digit() {
            if !col_done {
                col = 0;
            }
            break;
        }
    }
    let row = ref_.rsplit(|c: char| c.is_ascii_alphabetic()).next()?.parse::<u32>().ok()?;
    Some((row - 1, col - 1))
}

/// 把 OOXML 的 rgb 属性值（ARGB/RGB 十六进制）转为 "#RRGGBB"；
/// 无法识别（theme/indexed 等）返回 None。
fn rgb_hex(v: &str) -> Option<String> {
    let v = v.trim();
    if v.len() == 8 {
        Some(format!("#{}", &v[2..]))
    } else if v.len() == 6 {
        Some(format!("#{v}"))
    } else {
        None
    }
}
