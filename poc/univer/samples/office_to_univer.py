#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
POC-1 桥接脚本：Office 样例文件 → Univer 数据模型 JSON（模拟"导入"这一步）。

背景：Univer OSS 不提供 xlsx/docx/pptx 的文件导入（导入/导出为 Pro 功能，
见 docs/poc/univer-matrix.md 的包审计结论）。本脚本用 openpyxl/python-docx
把样例文件翻译成 Univer 的 IWorkbookData / IDocumentData JSON，用于验证
"导入→编辑→导出快照"链路中 **编辑与快照保真度** 部分。

产物（输出到 poc/univer/samples/univer/）：
  sheet-sample.json  - IWorkbookData（来自 sample.xlsx）
  sheet-expected.json - 校验期望（单元格值/公式/合并区域/条件格式/图片数）
  doc-sample.json    - IDocumentData（来自 sample.docx）
  doc-expected.json  - 校验期望（段落文本/标题层级/表格/脚注尾注/图片）
  ppt-expected.json  - pptx 内容清单（仅作对照，OSS 无 headless slides 模型）

用法：
  python3 samples/office_to_univer.py
"""
import json
import os
import re
import uuid

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from docx import Document
from pptx import Presentation

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "univer")


def _uid(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------- helpers
def _col_to_idx(col_letter):
    n = 0
    for ch in col_letter:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def _style_from_openpyxl(cell):
    """从 openpyxl 单元格提取 Univer IStyleData 子集（仅验证用，覆盖常用样式）。"""
    s = {}
    font = cell.font
    if font is not None:
        if font.bold:
            s["b"] = 1
        if font.italic:
            s["i"] = 1
        if font.underline and font.underline != "none":
            s["u"] = {"s": 1}
        # 仅处理显式 rgb 颜色；theme/indexed 颜色在 OSS 无对应语义，跳过（记录为丢失项）
        if font.color is not None and getattr(font.color, "type", None) == "rgb":
            rgb = str(font.color.rgb)[-6:]
            if rgb not in ("000000", "FFFFFF"):
                s["cl"] = {"rgb": f"#{rgb}"}
        if font.size:
            s["sz"] = float(font.size)
    fill = cell.fill
    if fill is not None and fill.patternType == "solid" and fill.fgColor is not None:
        rgb = str(fill.fgColor.rgb)
        if rgb and rgb not in ("000000", "FFFFFFFF"):
            s["bg"] = {"rgb": f"#{rgb[-6:]}"}
    align = cell.alignment
    if align is not None:
        m = {"general": 0, "left": 1, "center": 2, "right": 3, "justify": 4}
        if align.horizontal in m:
            s["ht"] = m[align.horizontal]
        vm = {"top": 4, "center": 1, "bottom": 0}
        if align.vertical in vm:
            s["vt"] = vm[align.vertical]
    border = cell.border
    if border is not None:
        for side, key in (("left", "bl"), ("right", "br"), ("top", "bt"), ("bottom", "bb")):
            b = getattr(border, side)
            if b is not None and b.style:
                s[key] = {"s": 1, "cl": {"rgb": b.color.rgb[-6:] if b.color and b.color.rgb else "#000000"}}
    return s


# ---------------------------------------------------------------- 公式求值
class _MiniFormula:
    """极小公式求值器（纯手写扫描，无正则）：支持单元格引用/跨表引用/四则运算/括号。

    用途：真实 xlsx 导入器会把公式计算缓存值一并写入 Univer 数据（v 字段）。
    无头 node-core 预设不会重新计算公式（实测 getValue()=null，快照只保留 f），
    因此桥接层预写缓存值以验证"数据经 createWorkbook->save() 的完整性"；
    真实求值能力在浏览器页面（editor 完整引擎）中另行验证。
    不支持函数调用（样例无函数公式）。
    """

    def __init__(self, wb):
        self.grid = {}
        self.formulas = {}
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                for c in row:
                    if c.value is None:
                        continue
                    if isinstance(c.value, str) and c.value.startswith("="):
                        self.formulas[(ws.title, c.coordinate)] = c.value[1:]
                    else:
                        self.grid[(ws.title, c.coordinate)] = c.value

    def eval_formula(self, formula, sheet):
        state = {"s": formula, "i": 0, "seen": set(), "sheet": sheet}
        val = self._parse_expr(state)
        self._skip_ws(state)
        if state["i"] != len(state["s"]):
            raise ValueError("公式存在多余字符: %r" % state["s"][state["i"]:])
        return int(val) if float(val).is_integer() else float(val)

    def _skip_ws(self, state):
        s, n = state["s"], len(state["s"])
        while state["i"] < n and s[state["i"]].isspace():
            state["i"] += 1

    def _peek(self, state):
        i = state["i"]
        return state["s"][i] if i < len(state["s"]) else ""

    def _parse_expr(self, state):
        val = self._parse_term(state)
        while True:
            self._skip_ws(state)
            ch = self._peek(state)
            if ch == "+":
                state["i"] += 1
                val = val + self._parse_term(state)
            elif ch == "-":
                state["i"] += 1
                val = val - self._parse_term(state)
            else:
                return val

    def _parse_term(self, state):
        val = self._parse_factor(state)
        while True:
            self._skip_ws(state)
            ch = self._peek(state)
            if ch == "*":
                state["i"] += 1
                val = val * self._parse_factor(state)
            elif ch == "/":
                state["i"] += 1
                right = self._parse_factor(state)
                if right == 0:
                    raise ValueError("除零")
                val = val / right
            else:
                return val

    def _parse_factor(self, state):
        s, n = state["s"], len(state["s"])
        self._skip_ws(state)
        i = state["i"]
        if i >= n:
            raise ValueError("公式意外结束")
        ch = s[i]
        if ch == "(":
            state["i"] += 1
            val = self._parse_expr(state)
            self._skip_ws(state)
            if state["i"] >= n or s[state["i"]] != ")":
                raise ValueError("缺少右括号")
            state["i"] += 1
            return val
        if ch == "-":
            state["i"] += 1
            return -self._parse_factor(state)
        if ch.isdigit():
            j = i
            while j < n and (s[j].isdigit() or s[j] == "."):
                j += 1
            state["i"] = j
            return float(s[i:j])
        if ch.isalpha() or ch in "$_":
            j = i
            while j < n and (s[j].isalnum() or s[j] in "$_"):
                j += 1
            word = s[i:j]
            if j < n and s[j] == "!":
                state["i"] = j + 1
                cell = self._parse_cell(state)
                return self._cell_value((word, cell), state)
            state["i"] = j
            return self._cell_value((state["sheet"], word), state)
        raise ValueError("无法解析字符: %r" % ch)

    def _parse_cell(self, state):
        s, n = state["s"], len(state["s"])
        i = state["i"]
        if i < n and s[i] == "$":
            i += 1
        col_start = i
        while i < n and s[i].isalpha():
            i += 1
        if i == col_start or i - col_start > 3:
            raise ValueError("非法单元格列: %r" % s[i - 4:i + 4])
        col = s[col_start:i].upper()
        if i < n and s[i] == "$":
            i += 1
        row_start = i
        while i < n and s[i].isdigit():
            i += 1
        if i == row_start:
            raise ValueError("非法单元格行: %r" % s[i:i + 8])
        state["i"] = i
        return col + s[row_start:i]

    def _cell_value(self, key, state):
        if key in state["seen"]:
            raise ValueError("循环引用: %s!%s" % key)
        if key in self.grid:
            return self.grid[key]
        if key in self.formulas:
            state["seen"].add(key)
            try:
                val = self.eval_formula(self.formulas[key], key[0])
            finally:
                state["seen"].discard(key)
            return val
        return 0


def _norm_val(val):
    """把 python 值规范为 Univer 的 (v, t)。"""
    if isinstance(val, bool):
        return val, 3
    if isinstance(val, int):
        return val, 2
    if isinstance(val, float):
        return int(val) if val.is_integer() else val, 2
    return str(val), 1


# ----------------------------------------------------------------- xlsx
def build_sheet(path, out_dir):
    wb = load_workbook(path, data_only=False)
    sample = {
        "id": "poc-workbook",
        "name": os.path.basename(path),
        "appVersion": "1.0.4",
        "locale": "zhCN",
        "styles": {},
        "sheetOrder": [],
        "sheets": {},
    }
    expected = {"sheets": {}}
    evaluator = _MiniFormula(wb)

    for ws in wb.worksheets:
        sheet_id = f"sheet-{_uid('s')}"
        cell_data = {}
        exp_cells = {}
        for row in ws.iter_rows():
            for cell in row:
                if cell.value is None and cell.has_style is False:
                    continue
                r, c = cell.row - 1, _col_to_idx(cell.column_letter)
                entry = {}
                v = cell.value
                if isinstance(v, str) and v.startswith("="):
                    # 公式单元格：f 存公式（无 = 前缀），v/t 存计算缓存值
                    # （真实导入器行为；无头 node-core 不重算公式，实测见 verify-sheets）
                    entry["f"] = v[1:]
                    try:
                        ev = evaluator.eval_formula(v[1:], ws.title)
                        if ev is not None:
                            nv, nt = _norm_val(ev)
                            entry["v"] = nv
                            entry["t"] = nt
                    except Exception as e:
                        print(f"  警告: 公式 {ws.title}!{cell.coordinate} 无法求值: {e}")
                elif isinstance(v, bool):
                    entry["v"] = v
                    entry["t"] = 3
                elif isinstance(v, (int, float)):
                    entry["v"] = v
                    entry["t"] = 2
                elif v is not None:
                    entry["v"] = str(v)
                    entry["t"] = 1
                st = _style_from_openpyxl(cell)
                if st:
                    entry["s"] = st
                if not entry:
                    continue
                cell_data.setdefault(str(r), {})[str(c)] = entry
                exp_cells[f"{cell.coordinate}"] = {
                    "value": entry.get("v"),
                    "formula": entry.get("f"),
                }

        merge_data = []
        for mr in ws.merged_cells.ranges:
            merge_data.append({
                "startRow": mr.min_row - 1,
                "startColumn": mr.min_col - 1,
                "endRow": mr.max_row - 1,
                "endColumn": mr.max_col - 1,
            })

        cf_ranges = []
        for rng in ws.conditional_formatting:
            for rule in rng.rules:
                cf_ranges.append({
                    "range": str(rng.sqref),
                    "type": rule.type,
                    "operator": getattr(rule, "operator", None),
                    "formula": getattr(rule, "formula", None),
                })

        n_images = len(getattr(ws, "_images", []))
        n_charts = len(getattr(ws, "_charts", []))

        sample["sheets"][sheet_id] = {
            "id": sheet_id,
            "name": ws.title,
            "tabColor": "#000000",
            "hidden": 0,
            "rowCount": max(ws.max_row, 20),
            "columnCount": max(ws.max_column, 10),
            "defaultColumnWidth": 88,
            "defaultRowHeight": 24,
            "zoomRatio": 100,
            "scrollTop": 0,
            "scrollLeft": 0,
            "rowHeader": {"width": 46},
            "columnHeader": {"height": 24},
            "showGridlines": 1,
            "rightToLeft": 0,
            "mergeData": merge_data,
            "cellData": cell_data,
            "rowData": {},
            "columnData": {},
        }
        sample["sheetOrder"].append(sheet_id)
        expected["sheets"][ws.title] = {
            "sheetId": sheet_id,
            "cells": exp_cells,
            "merged": sorted(
                (f"{get_column_letter(mr.min_col)}{mr.min_row}:{get_column_letter(mr.max_col)}{mr.max_row}")
                for mr in ws.merged_cells.ranges
            ),
            "conditionalFormatting": cf_ranges,
            "images": n_images,
            "charts": n_charts,
        }

    _dump(os.path.join(out_dir, "sheet-sample.json"), sample)
    _dump(os.path.join(out_dir, "sheet-expected.json"), expected)


# ----------------------------------------------------------------- docx
def _para_style_info(p):
    """从 python-docx 段落提取 (文本, heading 级别, 列表样式名)。"""
    text = p.text
    style_name = (p.style.name or "").lower() if p.style is not None else ""
    heading = None
    if "heading" in style_name or "标题" in (p.style.name or ""):
        m = re.search(r"(\d+)", style_name)
        if m:
            heading = int(m.group(1))
    return text, heading, p.style.name if p.style is not None else ""


def build_doc(path, out_dir):
    """docx → Univer 现代文档模型（dataStream + textRuns + paragraphs + 表格哨兵）。

    dataStream 规则（来自 @univerjs/core IDocumentBody 注释）：
      文本原样写入；段落结束 \\r；文档结束 \\0；
      表格 \\x1A 表开始 / \\x1B 行开始 / \\x1C 单元格开始 / \\x1D 单元格结束 /
            \\x1E 行结束 / \\x1F 表结束。
    说明：脚注/尾注/TOC 域/图片在 OSS 模型中有承载字段（notes/customRange/drawings），
    但完整翻译属于 Pro exchange 层职责，本桥接只覆盖正文段落+标题+列表+表格，
    其余项在 expected 中记录为"模型支持、桥接未覆盖"。
    """
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn

    doc = Document(path)
    body = doc.element.body

    data_stream = []          # 字符串片段
    paragraphs = []           # IParagraph[]
    tables = []               # ICustomTable[]
    table_source = {}         # ITables
    exp_blocks = []           # 期望清单（保真度对照）
    has_toc = False
    n_images = sum(1 for rel in doc.part.rels.values() if "image" in rel.reltype)

    def add_para(text, heading, style_name, numFmt=False):
        idx = len("".join(data_stream))
        pstyle = {}
        if heading is not None:
            pstyle["headingId"] = f"h{heading}"
        # 实测 1.0.4 模型约定：startIndex 指向本段结束处（终止 \r 的位置），
        # 段落 i 的文本范围 = [前一段 startIndex+1, 本段 startIndex)
        para = {"startIndex": idx + len(text), "paragraphId": _uid("para")}
        if pstyle:
            para["paragraphStyle"] = pstyle
        if numFmt:
            para["bullet"] = {"listType": "list-1", "listId": 1, "nestingLevel": 0}
        paragraphs.append(para)
        data_stream.append(text)
        data_stream.append("\r")
        exp_blocks.append({
            "kind": "para", "text": text, "heading": heading, "style": style_name,
        })

    tbl_idx = 0
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            p = Paragraph(child, doc)
            text, heading, style_name = _para_style_info(p)
            xml = child.xml
            if "TOC" in xml and "fldChar" in xml:
                has_toc = True
                text = text or "[TOC 目录域]"
            is_list = "List" in (style_name or "")
            add_para(text, heading, style_name, numFmt=is_list)
        elif child.tag == qn("w:tbl"):
            tbl = Table(child, doc)
            rows = [[cell.text for cell in row.cells] for row in tbl.rows]
            if not rows:
                continue
            tbl_idx += 1
            r, c = len(rows), max(len(x) for x in rows)
            table_id = f"tbl-{tbl_idx:02d}"
            start_idx = len("".join(data_stream))
            frag = ["\x1A"]
            for row in rows:
                frag.append("\x1B")
                for cell in row:
                    frag.append("\x1C")
                    frag.append(cell.replace("\r", ""))
                    frag.append("\x1D")
                frag.append("\x1E")
            frag.append("\x1F")
            data_stream.append("".join(frag))
            end_idx = len("".join(data_stream))
            tables.append({"startIndex": start_idx, "endIndex": end_idx, "tableId": table_id})
            # 表格内联在前一段落之后：把前一段的 startIndex 延伸到表格结束，
            # 使其文本范围覆盖 文本+\r+表格哨兵块
            if paragraphs:
                # 实测：表格段落的 startIndex 应指向 TABLE_END(\x1f) 哨兵本身，
                # 其后一段的起点 = 该值+1，才能紧贴表格结束位置
                paragraphs[-1]["startIndex"] = end_idx - 1
            # 结构对齐 @univerjs/core 1.0.4 的 ITable/ITableRow/ITableColumn
            # （单元格内容已在 dataStream 中，tableCells 只承载样式占位）
            table_source[table_id] = {
                "tableId": table_id,
                "tableRows": [
                    {
                        "tableCells": [{} for _ in range(c)],
                        "trHeight": {"val": {"v": 32, "u": 3}, "hRule": 0},
                    }
                    for _ in range(r)
                ],
                "tableColumns": [
                    {"size": {"type": 1, "width": {"v": 96, "u": 3}}}
                    for _ in range(c)
                ],
                "align": 0,
                "indent": {"v": 0, "u": 3},
                "textWrap": 1,
                "position": {
                    "positionH": {"relativeFrom": 1},
                    "positionV": {"relativeFrom": 1},
                },
                "dist": {"distT": 0, "distB": 0, "distL": 0, "distR": 0},
                "size": {"type": 1, "width": {"v": c * 96, "u": 3}},
            }
            exp_blocks.append({"kind": "table", "rows": rows})

    data_stream.append("\0")
    data_stream_str = "".join(data_stream)

    # 标题/列表样式注册到 IDocStyles
    styles = {}
    for i in range(1, 4):
        styles[f"h{i}"] = {
            "name": f"Heading {i}",
            "type": 1,  # paragraph
            "paragraphStyle": {"headingId": f"h{i}", "namedStyleType": 1},
            "textStyle": {"bl": 1, "sz": max(24 - i * 2, 14)},
        }

    doc_data = {
        "id": "poc-doc",
        "title": os.path.basename(path),
        "documentStyle": {
            "defaultNumFormat": {},
            "defaultPageSize": {"width": 595, "height": 842},
            "defaultParagraphStyle": {
                "spacing": {"before": 0, "after": 120, "line": 360, "lineRule": 0},
                "horizontalAlign": 0,
                "textStyle": {"sz": 12, "ff": "Calibri", "cl": "#000000"},
            },
        },
        "styles": styles,
        "lists": {"list-1": {"listType": "list-1", "nestingLevel": [
            {"bulletAlignment": 0, "glyphFormat": "●",
             "glyphSource": "Symbol", "glyphStyle": {"bl": 0}},
        ]}},
        "body": {
            "dataStream": data_stream_str,
            "paragraphs": paragraphs,
            "tables": tables,
        },
    }
    if table_source:
        doc_data["tableSource"] = table_source

    # 提取脚注/尾注 part 文本（仅用于期望清单）
    exp_notes = []
    for kind, tag in (("footnotes", "footnote"), ("endnotes", "endnote")):
        for rel in doc.part.rels.values():
            if rel.reltype.endswith(f"/{kind}"):
                part_xml = rel.target_part.blob.decode("utf-8")
                for m in re.finditer(r'<w:%s w:id="(\d+)".*?</w:%s>' % (tag, tag), part_xml, re.S):
                    texts = re.findall(r"<w:t[^>]*>([^<]*)</w:t>", m.group(0))
                    exp_notes.append({"kind": kind[:-1], "id": m.group(1),
                                      "text": "".join(texts).strip()})

    expected = {
        "docId": "poc-doc",
        "blocks": exp_blocks,
        "hasToc": has_toc,
        "notes": exp_notes,
        "images": n_images,
    }

    _dump(os.path.join(out_dir, "doc-sample.json"), doc_data)
    _dump(os.path.join(out_dir, "doc-expected.json"), expected)


# ----------------------------------------------------------------- pptx
def build_ppt(path, out_dir):
    prs = Presentation(path)
    slides = []
    for i, slide in enumerate(prs.slides, 1):
        texts = []
        n_pics = 0
        for shape in slide.shapes:
            if shape.shape_type == 13:  # PICTURE
                n_pics += 1
            if shape.has_text_frame:
                for p in shape.text_frame.paragraphs:
                    t = "".join(r.text for r in p.runs)
                    if t.strip():
                        texts.append(t)
        slides.append({"slide": i, "texts": texts, "images": n_pics})
    _dump(os.path.join(out_dir, "ppt-expected.json"), {"slides": slides})


def _dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    print(f"  写出 {path}")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    print("构建 Univer 数据模型 JSON（模拟导入）...")
    build_sheet(os.path.join(HERE, "sample.xlsx"), OUT)
    build_doc(os.path.join(HERE, "sample.docx"), OUT)
    build_ppt(os.path.join(HERE, "sample.pptx"), OUT)
    print("完成。")
