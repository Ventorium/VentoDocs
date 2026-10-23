#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
POC-1 样例文件生成器（可复现）。

生成到 poc/univer/samples/：
  - sample.xlsx   : 2 个工作表、公式(=A1+B1)、合并单元格、条件格式、图片、柱状图、数据验证
  - sample.docx   : 标题样式(H0/H1/H2/H3)、多级段落、表格、图片、脚注+尾注、目录域(TOC)
  - sample.pptx   : 3 页，每页 标题+正文+图片
  - large_20k.xlsx: 2 万行大文件，用于编辑器生命周期/性能测试

依赖版本（已验证可复现）：
  python 3.8.10 / openpyxl 3.1.5 / python-docx 1.1.2 / python-pptx 1.0.2 / pillow 10.4.0

用法：
  python3 samples/gen_samples.py            # 生成全部样例
确定性：所有随机数固定种子；图片为手工像素，字节级可复现。
"""
import os
import random

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE
IMG = os.path.join(OUT, "chart.png")

random.seed(20261023)


def make_png(path=IMG, w=160, h=80):
    """生成一张确定性 PNG（蓝色底 + 黄色对角条 + 红色块），用于 docx/pptx/xlsx 插图。"""
    img = Image.new("RGB", (w, h), (47, 111, 224))
    for x in range(w):
        if x < 30:
            for y in range(h):
                img.putpixel((x, y), (255, 213, 79))
    for x in range(100, 140):
        for y in range(20, 60):
            img.putpixel((x, y), (224, 64, 64))
    img.save(path, "PNG")
    return path


# ---------------------------------------------------------------- xlsx ----
def gen_xlsx(path=os.path.join(OUT, "sample.xlsx")):
    from openpyxl import Workbook
    from openpyxl.chart import BarChart, Reference
    from openpyxl.drawing.image import Image as XLImage
    from openpyxl.formatting.rule import CellIsRule
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = Workbook()

    # ---- 工作表 1：销售 ----
    ws = wb.active
    ws.title = "销售"
    # A1/B1 放数值，A2 放任务指定的公式 =A1+B1
    ws["A1"] = 10
    ws["B1"] = 32
    ws["A2"] = "=A1+B1"
    ws["A2"].font = Font(bold=True)

    ws.merge_cells("D4:G4")
    ws["D4"] = "一季度销售"
    ws["D4"].font = Font(bold=True, size=14)
    ws["D4"].alignment = Alignment(horizontal="center")

    headers = ["产品", "数量", "单价", "小计"]
    for i, h in enumerate(headers):
        c = ws.cell(row=5, column=4 + i, value=h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="2F6FE0")
        c.alignment = Alignment(horizontal="center")

    rows = [("甲", 120, 3.5), ("乙", 45, 12.0), ("丙", 8, 99.0), ("丁", 60, 7.5), ("戊", 200, 1.2)]
    r = 6
    for name, qty, price in rows:
        ws.cell(row=r, column=4, value=name)
        ws.cell(row=r, column=5, value=qty)
        ws.cell(row=r, column=6, value=price)
        ws.cell(row=r, column=7, value=f"=E{r}*F{r}")
        r += 1

    # 条件格式：数量列 >100 标红底
    red = PatternFill("solid", fgColor="FFC7CE")
    ws.conditional_formatting.add(
        "E6:E10",
        CellIsRule(operator="greaterThan", formula=["100"], fill=red),
    )
    # 数据验证：产品列限定下拉
    from openpyxl.worksheet.datavalidation import DataValidation
    dv = DataValidation(type="list", formula1='"甲,乙,丙,丁,戊"', allow_blank=True)
    ws.add_data_validation(dv)
    dv.add("D6:D10")

    # 图片（I2）
    make_png()
    ws.add_image(XLImage(IMG), "I2")

    # 柱状图（数量）
    ch = BarChart()
    ch.title = "数量"
    data = Reference(ws, min_col=5, min_row=5, max_row=10)
    cats = Reference(ws, min_col=4, min_row=6, max_row=10)
    ch.add_data(data, titles_from_data=True)
    ch.set_categories(cats)
    ws.add_chart(ch, "A13")

    # ---- 工作表 2：备注 ----
    ws2 = wb.create_sheet("备注")
    ws2["A1"] = "说明"
    ws2.merge_cells("A1:C1")
    ws2["A1"].font = Font(bold=True)
    ws2["A2"] = "总合计"
    ws2["B2"] = "=销售!A2+销售!G6+销售!G7"
    ws2["A3"] = "公式引用销售!A2"
    ws2["B3"] = "=销售!A2*2"
    ws2["A4"] = "备注文本单元格"

    wb.save(path)
    return path


# ---------------------------------------------------------------- docx ----
def _ensure_part(doc, kind):
    """确保存在 footnotes/endnotes part，返回 (part, next_id)。kind in {'footnotes','endnotes'}。"""
    from docx.opc.part import Part
    from docx.opc.packuri import PackURI

    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    partname = f"/word/{kind}.xml"
    reltype = f"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}"
    part = None
    for rel in doc.part.rels.values():
        if rel.reltype == reltype:
            part = rel.target_part
            break
    if part is None:
        if kind == "footnotes":
            seed = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes {ns}>
<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
</w:footnotes>'''
        else:
            seed = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes {ns}>
<w:endnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:endnote>
<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
</w:endnotes>'''
        content_type = (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"
            if kind == "footnotes"
            else "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"
        )
        part = Part(PackURI(partname), content_type, seed.encode("utf-8"), doc.part.package)
        doc.part.relate_to(part, reltype)
    xml = part.blob.decode("utf-8")
    import re
    ids = [int(m) for m in re.findall(r'w:id="(-?\d+)"', xml)]
    return part, (max(ids) + 1 if ids else 1)


def _add_note_ref(paragraph, doc, kind, text):
    """在段落末尾插入脚注/尾注引用，并把注释正文追加到对应 part。"""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    part, fid = _ensure_part(doc, kind)
    tag = "footnote" if kind == "footnotes" else "endnote"
    style = "FootnoteReference" if kind == "footnotes" else "EndnoteReference"
    textstyle = "FootnoteText" if kind == "footnotes" else "EndnoteText"

    # 注释正文
    note_xml = (
        f'<w:{tag} w:id="{fid}" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:p><w:pPr><w:pStyle w:val="{textstyle}"/></w:pPr>'
        f'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:{kind[:-1]}Ref/></w:r>'
        f'<w:r><w:t xml:space="preserve"> {text}</w:t></w:r></w:p></w:{tag}>'
    )
    xml = part.blob.decode("utf-8")
    xml = xml.replace("</w:footnotes>", note_xml + "</w:footnotes>")
    xml = xml.replace("</w:endnotes>", note_xml + "</w:endnotes>")
    part._blob = xml.encode("utf-8")

    # 段落内引用 run
    run = paragraph.add_run()
    rPr = OxmlElement("w:rPr")
    rStyle = OxmlElement("w:rStyle")
    rStyle.set(qn("w:val"), style)
    rPr.append(rStyle)
    ref = OxmlElement(f"w:{kind[:-1]}Reference")
    ref.set(qn("w:id"), str(fid))
    run._r.append(rPr)
    run._r.append(ref)
    return fid


def _add_toc(doc):
    """插入 TOC 域（Word 打开时更新）。"""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    p = doc.add_paragraph()
    run = p.add_run()
    f1 = OxmlElement("w:fldChar"); f1.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText"); instr.set(qn("xml:space"), "preserve")
    instr.text = r'TOC \o "1-3" \h \z \u'
    f2 = OxmlElement("w:fldChar"); f2.set(qn("w:fldCharType"), "separate")
    t = OxmlElement("w:t"); t.text = "（目录将在打开文档时更新）"
    f3 = OxmlElement("w:fldChar"); f3.set(qn("w:fldCharType"), "end")
    for el in (f1, instr, f2, t, f3):
        run._r.append(el)


def gen_docx(path=os.path.join(OUT, "sample.docx")):
    from docx import Document
    from docx.shared import Inches

    doc = Document()
    doc.add_heading("Univer POC 样例文档", level=0)
    _add_toc(doc)

    doc.add_heading("第一章 概述", level=1)
    doc.add_paragraph("这是第一级段落，用于验证普通正文样式。")
    doc.add_heading("第一节 背景", level=2)
    doc.add_paragraph("这是二级标题下的段落。")
    doc.add_heading("1.1 小节", level=3)
    doc.add_paragraph("这是三级标题下的段落，带一个脚注。")
    fid = _add_note_ref(doc.paragraphs[-1], doc, "footnotes", "这是脚注正文。")
    doc.add_paragraph("编号列表条目一", style="List Number")
    doc.add_paragraph("编号列表条目二", style="List Number")
    doc.add_paragraph("项目符号条目", style="List Bullet")
    doc.add_paragraph("这是一个带尾注的段落。", style="Quote")
    _add_note_ref(doc.paragraphs[-1], doc, "endnotes", "这是尾注正文。")

    doc.add_heading("第二章 表格", level=1)
    doc.add_paragraph("下面是一个 3x3 表格：")
    tbl = doc.add_table(rows=3, cols=3)
    tbl.style = "Table Grid"
    data = [["姓名", "数量", "单价"], ("甲", "120", "3.5"), ("乙", "45", "12.0")]
    for r, row in enumerate(data):
        for c, v in enumerate(row):
            tbl.cell(r, c).text = v

    doc.add_heading("第三章 图片", level=1)
    doc.add_paragraph("下面是一张示例图片：")
    make_png()
    doc.add_picture(IMG, width=Inches(2))
    doc.add_paragraph("图片之后的段落。")

    doc.save(path)
    return path


# ---------------------------------------------------------------- pptx ----
def gen_pptx(path=os.path.join(OUT, "sample.pptx")):
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()
    # 幻灯片 1：标题版式
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = "Univer POC 幻灯片"
    slide.placeholders[1].text = "副标题：导入-编辑-导出保真度验证"
    slide.shapes.add_picture(IMG, Inches(8.5), Inches(4.5), width=Inches(1.5))

    # 幻灯片 2：标题+内容
    slide2 = prs.slides.add_slide(prs.slide_layouts[1])
    slide2.shapes.title.text = "验证要点"
    body = slide2.placeholders[1].text_frame
    body.text = "第一点：单元格值与公式"
    for line in ("第二点：合并单元格", "第三点：图片与表格"):
        p = body.add_paragraph()
        p.text = line
        p.level = 1
    slide2.shapes.add_picture(IMG, Inches(8.5), Inches(4.5), width=Inches(1.5))

    # 幻灯片 3：空白版式 + 手动标题/正文/图片
    slide3 = prs.slides.add_slide(prs.slide_layouts[6])
    tb = slide3.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(8), Inches(1))
    tb.text_frame.text = "第三页：文本框标题"
    tb.text_frame.paragraphs[0].runs[0].font.size = Pt(32)
    tb2 = slide3.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(8), Inches(3))
    tf2 = tb2.text_frame
    tf2.text = "正文第一行"
    p = tf2.add_paragraph()
    p.text = "正文第二行"
    slide3.shapes.add_picture(IMG, Inches(8.5), Inches(4.5), width=Inches(1.5))

    prs.save(path)
    return path


# ------------------------------------------------------------- large xlsx ----
def gen_large(path=os.path.join(OUT, "large_20k.xlsx"), nrows=20000):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "big"
    headers = ["id", "a", "b", "sum", "cat", "note"]
    ws.append(headers)
    cats = ["x", "y", "z"]
    for i in range(1, nrows + 1):
        a = random.randint(1, 1000)
        b = random.randint(1, 1000)
        ws.cell(row=i + 1, column=1, value=i)
        ws.cell(row=i + 1, column=2, value=a)
        ws.cell(row=i + 1, column=3, value=b)
        ws.cell(row=i + 1, column=4, value=f"=B{i+1}+C{i+1}")
        ws.cell(row=i + 1, column=5, value=cats[i % 3])
        ws.cell(row=i + 1, column=6, value=f"row-{i}")
    wb.save(path)
    return path


if __name__ == "__main__":
    print("生成样例文件 ...")
    for fn in (gen_xlsx, gen_docx, gen_pptx, gen_large):
        p = fn()
        print(f"  {p}  ({os.path.getsize(p)} bytes)")
    print("完成。")
