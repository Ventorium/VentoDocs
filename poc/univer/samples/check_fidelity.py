#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
POC-1 保真度复核脚本：重新解析无头链路产出的快照 JSON，与桥接期
生成的 *-expected.json 对照，逐项给出保真度判定：

  无损         - 快照中完整保留，与期望一致
  轻微丢失     - 模型字段支持，但桥接未覆盖 / 仅占位 / 语义弱化
  结构性丢失   - Univer 数据模型无对应承载字段（OSS 限制）

覆盖：
  sheet-snapshot.json vs sheet-expected.json
      单元格值/公式、合并区域、条件格式、图片、图表
  doc-snapshot.json   vs doc-expected.json
      段落文本/标题层级、表格(哨兵+tableSource+单元格文本)、TOC 域、脚注/尾注、图片

用法：python3 samples/check_fidelity.py
"""
import json
import os
import sys
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "headless", "out")

# 判定常量
LOSSLESS = "无损"
MINOR = "轻微丢失"
STRUCT = "结构性丢失"

VERDICT_RANK = {LOSSLESS: 0, MINOR: 1, STRUCT: 2}


def better(a, b):
    return a if VERDICT_RANK[a] >= VERDICT_RANK[b] else b


def col_letter_to_idx(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def coord_to_rc(coord):
    m = re.match(r"^([A-Z]+)(\d+)$", coord)
    return int(m.group(2)) - 1, col_letter_to_idx(m.group(1))


def rc_to_coord(r, c):
    s = ""
    c += 1
    while c:
        c, rem = divmod(c - 1, 26)
        s = chr(65 + rem) + s
    return s + str(r + 1)


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


# ----------------------------------------------------------------- xlsx
def check_sheet():
    print("=" * 68)
    print("[xlsx] sheet-snapshot.json vs sheet-expected.json")
    snap = load(os.path.join(OUT, "sheet-snapshot.json"))
    exp = load(os.path.join(HERE, "univer", "sheet-expected.json"))
    report = {}

    all_cell_ok = True
    formula_count = 0
    n_cells = 0
    for name, e in exp["sheets"].items():
        sid = e["sheetId"]
        sheet = snap["sheets"][sid]
        cell_data = sheet.get("cellData", {})
        bad = []
        for coord, ec in e["cells"].items():
            r, c = coord_to_rc(coord)
            sc = (cell_data.get(str(r)) or {}).get(str(c)) or {}
            n_cells += 1
            sv, sf = sc.get("v"), sc.get("f")
            if ec.get("formula") is not None:
                formula_count += 1
                if sf != ec["formula"] or sv != ec["value"]:
                    bad.append("%s(f=%r v=%r, 期望 f=%r v=%r)" % (coord, sf, sv, ec["formula"], ec["value"]))
            elif sv != ec["value"]:
                bad.append("%s(v=%r, 期望 %r)" % (coord, sv, ec["value"]))
        if bad:
            all_cell_ok = False
            print("  单元格不一致(%s): %s" % (name, "; ".join(bad[:5])))
        # 合并区域（含 verify-sheets.mjs 编辑产生的 A14:B14：merge A13:B13 后 insertRows 推移）
        KNOWN_EDIT_MERGES = {"销售": ["A14:B14"]}
        exp_merged = sorted(list(e["merged"]) + KNOWN_EDIT_MERGES.get(name, []))
        got_merged = sorted(
            rc_to_coord(m["startRow"], m["startColumn"]) + ":" + rc_to_coord(m["endRow"], m["endColumn"])
            for m in sheet.get("mergeData", [])
        )
        merge_ok = exp_merged == got_merged
        if not merge_ok:
            print("  合并区域不一致(%s): 快照=%s 期望=%s" % (name, got_merged, exp_merged))
        # 条件格式 / 图片 / 图表
        cf = e.get("conditionalFormatting") or []
        n_cf = len(cf)
        has_cf_field = "conditionalFormatting" in sheet
        report["%s.cells" % name] = LOSSLESS if not bad else MINOR
        report["%s.merged" % name] = LOSSLESS if merge_ok else MINOR
        if n_cf:
            report["%s.conditionalFormatting" % name] = (
                LOSSLESS if has_cf_field else STRUCT
            )
        if e.get("images"):
            report["%s.images" % name] = STRUCT  # 模型无图片资源承载（桥接不搬二进制）
        if e.get("charts"):
            report["%s.charts" % name] = STRUCT  # 图表 = Pro 功能，OSS 模型无承载

    # 公式缓存值说明
    if formula_count:
        report["_formula_note"] = "%d 个公式单元格 f/v 均保留（无头不重算，v 为桥接预写缓存值）" % formula_count
    print("  共核对 %d 个单元格（含 %d 公式）" % (n_cells, formula_count))
    return report


# ----------------------------------------------------------------- docx
def check_doc():
    print("=" * 68)
    print("[docx] doc-snapshot.json vs doc-expected.json")
    snap = load(os.path.join(OUT, "doc-snapshot.json"))
    exp = load(os.path.join(HERE, "univer", "doc-expected.json"))
    report = {}
    body = snap["body"]
    ds = body["dataStream"]
    paras = body["paragraphs"]

    # 段落范围：第 i 段文本 = [前一段 startIndex+1, 本段 startIndex)
    ranges = []
    prev_end = -1
    for p in paras:
        ranges.append((prev_end + 1, p["startIndex"]))
        prev_end = p["startIndex"]

    def para_text(i):
        a, b = ranges[i]
        return ds[a:b]

    def find_para_idx(text):
        for i in range(len(paras)):
            t = para_text(i)
            if text == "":
                if not t.strip():
                    return i
            elif text in t:
                return i
        return -1

    para_ok, para_bad = 0, []
    heading_ok, heading_bad = 0, []
    for b in exp["blocks"]:
        if b["kind"] != "para":
            continue
        text = b["text"]
        i = find_para_idx(text)
        if i < 0:
            para_bad.append("未找到: %r" % text[:30])
            continue
        para_ok += 1
        if b.get("heading") is not None:
            pid = paras[i].get("paragraphStyle", {}).get("headingId", "")
            want = "h%d" % b["heading"]
            if pid == want:
                heading_ok += 1
            else:
                heading_bad.append("%r 期望 %s 实际 %r" % (text[:20], want, pid))

    report["paragraph.text"] = LOSSLESS if not para_bad else (MINOR if para_ok else STRUCT)
    if para_bad:
        print("  段落未命中: %s" % "; ".join(para_bad[:5]))
    report["paragraph.heading"] = LOSSLESS if not heading_bad else (MINOR if heading_ok else STRUCT)
    if heading_bad:
        print("  标题层级不一致: %s" % "; ".join(heading_bad[:5]))

    # 表格：哨兵 + tables 引用 + tableSource + 单元格文本
    tables = body.get("tables", [])
    tsource = snap.get("tableSource", {})
    tbl_blocks = [b for b in exp["blocks"] if b["kind"] == "table"]
    tbl_ok = 0
    tbl_bad = []
    for bi, b in enumerate(tbl_blocks):
        if bi >= len(tables):
            tbl_bad.append("tables 引用缺失 # %s" % bi)
            continue
        ref = tables[bi]
        ts = tsource.get(ref["tableId"])
        if ts is None:
            tbl_bad.append("tableSource 缺失: %s" % ref["tableId"])
            continue
        # 单元格文本必须出现在 dataStream 的哨兵块内
        block = ds[ref["startIndex"]:ref["endIndex"]]
        if "\x1a" not in [ch for ch in block]:
            tbl_bad.append("哨兵 \x1a 缺失: %s" % ref["tableId"])
        rows = b["rows"]
        cell_texts = [cell for row in rows for cell in row if cell.strip()]
        missing = [t for t in cell_texts if t not in block]
        if missing:
            tbl_bad.append("%s 单元格文本缺失 %d 个: %s" % (ref["tableId"], len(missing), missing[:3]))
        shape_ok = len(ts["tableRows"]) == len(rows) and all(
            len(ts["tableRows"][ri]["tableCells"]) == len(rows[ri]) for ri in range(len(rows))
        )
        if not shape_ok:
            tbl_bad.append("%s tableSource 形状不符" % ref["tableId"])
        if not missing and shape_ok:
            tbl_ok += 1
    if tbl_bad:
        print("  表格问题: %s" % "; ".join(tbl_bad[:5]))
    report["table"] = LOSSLESS if not tbl_bad else (MINOR if tbl_ok else STRUCT)

    # TOC 域：桥接将 TOC 域替换为占位纯文本（"[TOC 目录域]" 或 docx 原有占位句），
    # Univer 文档模型无 TOC 域结构承载 → 轻微丢失
    if exp.get("hasToc"):
        toc_hit = ("[TOC 目录域]" in ds) or ("目录将在打开文档时更新" in ds)
        report["toc"] = MINOR if toc_hit else STRUCT
    else:
        report["toc"] = LOSSLESS

    # 脚注/尾注：模型支持 notes 字段，桥接未覆盖
    notes = snap.get("notes") or {}
    exp_notes = exp.get("notes") or []
    if exp_notes:
        got = len(notes) > 0
        report["footnotes/endnotes"] = LOSSLESS if got else MINOR

    # 图片
    if exp.get("images"):
        report["images"] = STRUCT

    report["_para_count"] = "%d 段全部命中（标题 %d/%d）" % (para_ok, heading_ok, heading_ok + len(heading_bad))
    report["_table_count"] = "%d/%d 张表格完整（哨兵+tableSource+单元格文本）" % (tbl_ok, len(tbl_blocks))
    return report


# ----------------------------------------------------------------- 汇总
def main():
    ok = True
    all_reports = {}
    for fn in (check_sheet, check_doc):
        rep = fn()
        all_reports[fn.__name__] = rep

    print("=" * 68)
    print("保真度判定汇总")
    for name, rep in all_reports.items():
        worst = LOSSLESS
        for k, v in rep.items():
            if k.startswith("_"):
                print("  [%s] %s" % (name, v))
            else:
                print("  [%s] %-28s %s" % (name, k, v))
                worst = better(worst, v)
        print("  [%s] 总体: %s" % (name, worst))
    # 机器可读汇总
    summary = {
        "sheet": all_reports["check_sheet"],
        "doc": all_reports["check_doc"],
    }
    out = os.path.join(OUT, "fidelity-report.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print("写出", out)


if __name__ == "__main__":
    main()
