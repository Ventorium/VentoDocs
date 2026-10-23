# POC-1：Univer OSS 在线编辑验证工程

验证 Univer OSS 对 **XLSX / DOCX / PPTX** 的"导入 → 编辑 → 导出"能力与保真度（M2 前置门禁）。
完整结论见 [docs/poc/univer-matrix.md](../../docs/poc/univer-matrix.md)；本目录是全部可复现证据。

## 目录结构

```
poc/univer/
├── src/                      # 浏览器端验证页（React + Vite，Univer 1.1.0 preset 形态）
│   ├── App.tsx               # 初始化 / 程序化编辑（含无缓存值公式）/ 快照回读 / 销毁
│   ├── main.tsx
│   └── vite-env.d.ts
├── index.html                # 静态按钮 #init / #edit / #destroy（可被自动化脚本直接点击）
├── samples/
│   ├── gen_samples.py        # 生成 sample.xlsx / sample.docx / sample.pptx（openpyxl/python-docx/python-pptx）
│   ├── office_to_univer.py   # 桥接：Office 样本 → Univer 快照 JSON（含 expected 对照文件）
│   ├── check_fidelity.py     # 保真度复核：headless/out/*.json vs samples/univer/*-expected.json
│   ├── chart.png             # 图表样本（用于证明 OSS 无承载）
│   ├── sample.{xlsx,docx,pptx}
│   └── univer/               # 桥接产物：sheet-sample.json / doc-sample.json / *-expected.json
├── headless/                 # ★ 独立 pnpm 项目：无头验证（Univer 1.0.4 node preset 线）
│   ├── verify-sheets.mjs     # 表格链路：载入→编辑→快照，期望 21/21 PASS
│   ├── verify-docs.mjs       # 文档链路：期望 25/25 PASS
│   ├── perf-large.mjs        # 20001×10 性能压测
│   └── out/                  # 运行产物：sheet-snapshot[-load].json / doc-snapshot.json / fidelity-report.json
├── scripts/audit-licenses.sh # 许可证审计（逐包扫描 node_modules/.pnpm）
├── vite.config.ts            # dev server 5199，/samples 指向 samples/ 静态目录
├── tsconfig.json
└── package.json              # 浏览器项目依赖（1.1.0 线）
```

**两条版本线刻意分离**：浏览器 `poc/univer/`（`@univerjs/presets` 1.1.0 preset 形态）与
无头 `poc/univer/headless/`（1.0.4 node preset 形态）是**两个独立 pnpm 项目**，
依赖树与 redi 版本不同，**严禁混用**（跨项目 import 会直接报模块解析错误）。

## 快速开始

```bash
# 1. 安装依赖（两个项目分别装）
pnpm install
cd headless && pnpm install && cd ..

# 2. 生成 Office 样本 + 桥接为 Univer 快照
python3 samples/gen_samples.py
python3 samples/office_to_univer.py

# 3. 无头验证（表格 / 文档 / 性能）
node headless/verify-sheets.mjs     # 期望: PASS 21/21
node headless/verify-docs.mjs       # 期望: 25 PASS / 0 FAIL
node headless/perf-large.mjs        # 20k 行: totalMs < 300

# 4. 保真度复核（依赖第 3 步的 headless/out 产物）
python3 samples/check_fidelity.py   # 判定汇总: 无损 / 轻微丢失 / 结构性丢失

# 5. 许可证审计
bash scripts/audit-licenses.sh      # 期望: 结论: 通过

# 6. 浏览器验证（见下）
pnpm dev
```

Python 依赖：`pip3 install openpyxl python-docx python-pptx`。

## 浏览器端手动验证

1. `pnpm dev` 启动（Vite，默认 http://127.0.0.1:5199/）。
2. 打开页面，点击右下角 **#init**：
   - 状态角标变为"就绪（内存 xxMB）"；日志区显示 createUniver + 3 preset 耗时、
     createWorkbook + createDocument 耗时；
   - 页面出现"销售"工作簿（含公式列、合并区 D4:G4）与"POC 文档"（标题 + 表格）。
3. 点击 **#edit**（程序化编辑）：
   - A11 写入文本 + 加粗 + 背景色；B11 写入**无缓存值公式** `=A1*B1`；
     A13:B13 合并；文档追加一段。
   - 状态先显示"编辑中… 等待公式计算"，随后日志回读 `B11 公式 A1*B1 计算值 = 320 → PASS`
     （**这是公式实时计算的证明**：无头端不会重算，只有浏览器引擎能算出来）；
   - 快照回读日志显示 `cellData[10][1] = {"f":"=A1*B1","v":320,"t":2}`。
4. 点击 **#destroy**：`univer.dispose()` 完成，状态"已销毁（可重新初始化）"，可再次点 #init。
5. 全程 DevTools Console 应无 error。

> 自动化等价脚本：本 POC 用 Playwright（playwright-core 1.49.1 + Chromium Headless Shell）
> 驱动上述按钮序列，结果 ALL_PASS（见矩阵 §4.3）。脚本为临时产物未入库，步骤与 App.tsx 按钮一一对应。

## 验证结果摘要

| 链路 | 结果 |
|---|---|
| verify-sheets（无头表格） | **21/21 PASS**（~95ms） |
| verify-docs（无头文档） | **25/25 PASS**（~48ms） |
| perf-large（20001×10） | load ~115–123ms / edit ~8ms / save ~156ms / **total ~280–287ms**；RSS 161→197MB；快照 4.61MB |
| check_fidelity（xlsx 桥接） | 导入→导出（未编辑）**无损**（34/34 单元格 + 合并区）；编辑后值/公式/合并无损；CF/图片/图表结构性丢失 |
| check_fidelity（docx 桥接） | 段落/标题/表格**无损**；TOC/脚注尾注轻微丢失；图片结构性丢失 |
| 浏览器 E2E（1.1.0） | **ALL_PASS**：初始化 ~200ms、编辑下发 31ms、**B11 公式实时算出 320**、文档追加、干净销毁、零报错 |
| 许可证审计 | 全部 `@univerjs*` Apache-2.0；无 `@univerjs-pro`；唯一非 Apache = 传递依赖 `@univerjs/icons`（MIT，兼容）→ **通过** |

**核心边界结论**：三种 Office 文件的**导入/导出均为 Pro 功能**（`@univerjs-pro/*-exchange-client`、
`exchange-node`）；PPTX 的**编辑内核本身也是 Pro**（OSS 无 slides 预设）。
OSS 提供完整的表格/文档编辑内核 + 数据模型，Office 互通需 Pro 授权或自建桥接（本目录即桥接参考实现）。

## 重要约定（M2 开发规范输入）

1. **公式 `f` 字段必须带前导 `=`**（如 `=SUM(G6:G10)`）。不带 `=` 会被 core 的 `isFormulaString`
   拒识 → 公式数据模型为空 → 引擎静默不计算（不报错）。XLSX `<f>` 不带 `=`，桥接/导入层必须补。
2. **无头端（node preset）不计算公式**：只读缓存值 `v`；导入层需预写 `v`。
   结构性编辑（如 `insertRows`）会清除公式缓存值并保留 `f`（浏览器端引擎会重算恢复）。
3. **版本快照容量基线**：20k 行工作簿快照 ~4.6MB JSON（见 perf-large.mjs）。
4. 1.1.0 浏览器集成：preset 传 `container: "editor"`（**无 `Univer.render()`**）；
   `locales` 为 `createUniver` 顶层选项，多 preset 用 `mergeLocales` 合并。
