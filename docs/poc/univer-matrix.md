# POC-1：Univer OSS 在线编辑能力矩阵（XLSX / DOCX / PPTX）

> M2 前置门禁文档。验证目标：确认 Univer OSS 对三种 Office 格式的**导入 → 编辑 → 导出**能力与保真度，
> 划定 OSS 与 Pro 的功能边界，为 M2 范围决策提供依据。
>
> 验证工程：[`poc/univer/`](../../poc/univer)（浏览器端 1.1.0 + 无头端 1.0.4 双 pnpm 项目）。
> 本文所有结论均有可复现脚本支撑（见文末"复现方式"）。

## 1. 结论速览

| 格式 | 导入（Office→Univer） | 编辑（OSS 可编辑范围） | 导出（Univer→Office） | 保真度 | M2 建议 |
|---|---|---|---|---|---|
| **XLSX** | **Pro-only**（`@univerjs-pro/sheets-exchange-client` 等） | OSS 核心能力完整：值/公式/样式/合并/数据校验/筛选/超链接/排序/线程评论/图形 | **Pro-only**（同上） | 数据模型级（快照 JSON）**无损**；Office 文件级依赖 Pro | 编辑器接入；文件导入导出走 Pro 或自建桥接 |
| **DOCX** | **Pro-only**（`@univerjs-pro/docs-exchange-client`） | OSS docs 核心能力：段落/标题/富文本/表格/超链接/批注 | **Pro-only**（同上） | 段落/标题/表格**无损**；TOC/脚注尾注**轻微丢失**；图片**结构性丢失** | 编辑器接入（图片导入导出需 Pro） |
| **PPTX** | **Pro-only**（`@univerjs-pro/slides-exchange-client`） | **OSS 无任何 slides 预设**（`preset-slides-*` 不存在于 OSS 命名空间）；slides 整体属 Pro（`@univerjs-pro/slides` + `slides-ui`） | **Pro-only** | 不适用（OSS 不可编辑） | **降级方案**：预览 + 下载 + 提示"暂不支持在线编辑"，待 Pro 商务决策后接入 |

**一句话结论**：OSS 的"编辑器内核"（sheets/docs）能力完整且许可证干净（Apache-2.0），
**三种 Office 文件的导入/导出全部是 Pro 功能**；PPTX 的编辑内核本身也是 Pro。
M2 若只依赖 OSS，则"在线编辑"只能针对**已转为 Univer 数据模型**的文档进行，
Office 文件的进出必须解决 Pro 授权或自建桥接（本 POC 的 Python 桥接已验证该路线可行）。

## 2. OSS / Pro 功能边界（已逐包核实，npm registry 2026-10-23）

| 能力 | OSS（Apache-2.0） | Pro（商业，`@univerjs-pro/*`） |
|---|---|---|
| 表格内核（sheets） | ✅ `preset-sheets-core` / `preset-sheets-node-core` | — |
| 文档内核（docs） | ✅ `preset-docs-core` / `preset-docs-node-core` | — |
| **幻灯片（slides）内核** | ❌ **无** OSS 预设（`@univerjs/preset-slides-*` 不存在） | ✅ `@univerjs-pro/slides`、`slides-ui` 等 |
| XLSX 导入/导出 | ❌ 无 OSS 包 | ✅ `@univerjs-pro/sheets-exchange-client`（浏览器端）、`@univerjs-pro/exchange-client` |
| DOCX 导入/导出 | ❌ 无 OSS 包 | ✅ `@univerjs-pro/docs-exchange-client` |
| PPTX 导入/导出 | ❌ 无 OSS 包（也无 slides 内核可载） | ✅ `@univerjs-pro/slides-exchange-client` |
| 服务端（Node）格式互转 | ❌ | ✅ `@univerjs-pro/exchange-node`（Office ↔ Univer unit data ↔ snapshot，含平台原生 binding） |
| 图表（charts） | ❌ 表格内图表为 Pro 功能（OSS sheets 数据模型无图表承载字段） | ✅ `@univerjs-pro/sheets-chart` 等 |
| 数据透视表 / 迷你图 | ❌ | ✅ `@univerjs-pro/sheets-pivot`、`sheets-sparkline` |
| 条件格式 | ✅ OSS 包 `@univerjs/preset-sheets-conditional-formatting`（浏览器端预设；**无头 node preset 不含**） | — |
| 协作 / 线程评论数据源 | 线程评论 OSS 有（`@univerjs/thread-comment`）；多人实时协作 | ✅ Pro 协作套件 |
| 打印 | 部分 | ✅ `@univerjs-pro/sheets-print` 等 |

**边界含义**：Univer 的"数据模型 + 编辑器"是 OSS 的核心资产；"与 Office 二进制格式的互通"整体被划到 Pro。
本 POC 用 Python 桥接（`poc/univer/samples/office_to_univer.py`）证明了"自建 Office→Univer 快照"路线在
**数据模型层可行**，损失点见 §5。

## 3. 验证方法

- **无头链路（Node 18+，Univer 1.0.4 线）**：`preset-sheets-node-core` / `preset-docs-node-core`。
  因 OSS 无 Office 文件导入器，"导入"一步由 Python 桥接把 `samples/sample.xlsx|docx` 解析为
  Univer 快照 JSON（`samples/univer/*-sample.json` + `*-expected.json`），再 `createWorkbook`/`createDocument` 载入 →
  程序化编辑 → `wb.save()`/`doc.save()` 导出快照 → Python 逐项复核保真度。
- **浏览器链路（Vite + React，Univer 1.1.0 线）**：`UniverSheetsCorePreset` + `UniverDocsCorePreset` +
  `UniverSheetsConditionalFormattingPreset`，加载同一份桥接 JSON，做初始化 / 程序化编辑（含**无缓存值公式**）/
  快照回读 / 销毁全生命周期，Playwright headless 驱动，结果见 §4.3。
- **两条版本线分离是刻意设计**：浏览器 1.1.0（最新 preset 形态）、无头 1.0.4（当前最稳定的 node preset 形态），
  两个独立 pnpm 项目、互不混用（依赖树与 redi 版本不同，混用会直接报模块解析错误）。
- 保真度判定口径：**无损**（快照与期望一致）/ **轻微丢失**（模型支持但桥接未覆盖或语义弱化）/
  **结构性丢失**（Univer OSS 数据模型无承载字段）。

## 4. 实测结果

### 4.1 无头 sheets 链路（verify-sheets.mjs）

**21/21 PASS**（~95ms）：

- 加载桥接工作簿（2 表：销售 10 行数据 + 备注跨表引用），值/公式/合并区读取全部正确；
- 编辑：写值、写公式（`setFormula`/`setValue({f})`）、加粗、背景色、`merge(A13:B13)`、`insertRows(12)`；
- 合并区随插行正确推移 A13:B13 → A14:B14；
- undo/redo 单命令往返正确；
- 快照导出：公式文本完整保留；
- `disposeUnit` 销毁干净。

### 4.2 无头 docs 链路（verify-docs.mjs）

**25/25 PASS**（~48ms）：段落/标题/富文本/表格（哨兵 + `tableSource`）/超链接/批注的加载、读取、
`appendParagraph` 编辑、快照导出全部正确。

### 4.3 浏览器 E2E（Playwright headless，1.1.0）

**ALL_PASS**，关键数据：

- 初始化（createUniver + 3 preset + createWorkbook + createDocument）：117ms + 89ms；页面总 JS 内存 ~57MB；
- 程序化编辑下发 31ms；
- **公式实时计算证明**：B11 写入 `setFormula("=A1*B1")`（不带缓存值 v）→ 引擎在渲染生命周期后自动计算，
  轮询回读 `getValue() === 320` ✅；快照 cellData = `{"f":"=A1*B1","v":320,"t":2}`；
- 文档 `appendParagraph` 编辑后快照 dataStream 尾部含新段落 ✅；
- `univer.dispose()` 干净销毁，可重新初始化；
- 全程零 `pageerror` / `console.error`。

### 4.4 保真度判定（check_fidelity.py 汇总，headless/out/fidelity-report.json）

**XLSX（桥接路线）**：

| 项 | 判定 |
|---|---|
| 导入→导出（未编辑）单元格 f/v/t + 合并区 | **无损**（34/34 单元格 + 双表合并区严格一致） |
| 单元格值 / 公式 / 合并（含编辑后快照） | **无损**（8 个公式 f 全部严格一致） |
| 条件格式 | **结构性丢失**（OSS 数据模型有承载，但桥接未搬运 CF 规则；浏览器端 CF 预设可用） |
| 图片 | **结构性丢失**（桥接不搬二进制；OSS 数据模型无图片资源承载） |
| 图表 | **结构性丢失**（图表为 Pro 功能，OSS 数据模型无承载字段） |

**DOCX（桥接路线）**：

| 项 | 判定 |
|---|---|
| 段落文本 / 标题层级 | **无损**（18 段全命中，标题 5/5） |
| 表格（哨兵 + tableSource + 单元格文本） | **无损**（1/1 张完整） |
| TOC 域 | **轻微丢失**（域指令以静态文本保留，非可更新域对象） |
| 脚注 / 尾注 | **轻微丢失**（内容保留为正文占位，非原生 footnotes 结构） |
| 图片 | **结构性丢失**（不搬二进制） |

**PPTX**：OSS 无 slides 内核，未做数据模型级验证（无验证对象）；结论为"OSS 不可编辑，整体 Pro"。

## 5. 关键工程发现

### 5.1 公式契约（最重要，直接影响桥接/导入层正确性）

1. **存储的公式 `f` 必须带前导 `=`**。core 的公式识别门
   `isFormulaString`（1.1.0 `lib/es/index.js` @8679）判定条件为
   `Tools.isString(value) && value.substring(0,1)==="=" && value.length>1`；
   不满足的 `f` 会在 `buildSheetFormulaData`（engine-formula @4897）被**静默丢弃** →
   `totalFormulasToCalculate: 0` → 引擎不产生任何计算结果（单元格表现为"有公式文本、无值、不报错"）。
2. **引擎解析时剥掉前导 `=`**（`normalizeFormulaText` @6137），即：存 `=SUM(G6:G10)`，解析 `SUM(G6:G10)`。
3. **共享公式**：仅带 `si`（共享组 id）的单元格由 `buildSheetFormulaData` 相对锚点公式推导，导入层需保留 `si`。
4. **桥接层必须补 `=`**：XLSX 的 `<f>` 元素存的是不带 `=` 的公式（如 `A1+B1`），
   因此 `office_to_univer.py` 在生成 `f` 字段时补前导 `=`（已修复并回归验证：
   浏览器端 B11 实时算出 320；无头端 8 个公式 f 全部被引擎识别）。
5. **Pro 导入的公式输出形态无法在 OSS 环境验证**：`sheets-exchange-client` 产出的快照中 `f`
   是否带 `=`，本 POC 无法实测。按 §5.1.1 的契约，**假设 Pro 输出带 `=`**（与 Univer 快照规范一致），
   上线前需用 Pro 环境做一次对照验证（列入 §7 遗留项）。

### 5.2 无头（1.0.4 node preset）行为差异（均为预期，文档化留档）

1. **无公式引擎重算**：node-core 不计算公式，`getValue()` 只返回存储的缓存值 `v`；
   桥接 JSON 中的 `v`（由 Python 预计算写入）因此是无头链路读到公式值的唯一来源。
   浏览器端有引擎，实时重算（§4.3 已证明）。
2. **结构性编辑清除公式缓存值**：`insertRows` 等结构变更会把相关公式标记为脏并**清除缓存 `v`**
   （`f` 文本保留）。无头端因此 `getValue()` 读不到值（预期，无引擎重算）；浏览器端引擎立即重算恢复。
   本 POC 的 verify-sheets 用快照断言了该行为（G10 插行后 raw = `{"f":"=E10*F10","s":{...}}`，无 `v`）。
3. **docs node preset 缺 facade 副作用导入**：`preset-docs-node-core` 不自动引入
   `@univerjs/docs/facade` 的副作用注册，需显式 import，否则文档 facade API 不可用。
4. **`IParagraph.startIndex` 是 END 偏移**（命名反直觉）：段落区间为 `[startIndex, endIndex)` 之外还需注意
   其 `startIndex` 语义为"段尾偏移"，拼接 dataStream 时按此处理才不会错位。
5. **RichTextEditingMutation 硬注入 IRenderManagerService**：无头环境无渲染服务，
   需在 redi 容器中以元组方式 stub（`add([token, stub])`；1.0.4 redi 只支持元组式 add，不支持装饰器式）。
6. **表格 `tableSource` 为顶层字段**：docs 表格数据存于文档顶层 `tableSource`，
   快照往返完整 → 表格保真无损。
7. **1.0.4 redi**：token map 的键是装饰器函数，需按 `decoratorName` 反查；元组式 add 可用。

### 5.3 浏览器（1.1.0）集成要点

1. **无 `Univer.render()`**：1.1.0 core 的 `Univer` 类没有 render 方法（与 1.0.x 文档示例不符）；
   渲染由 preset 内 `UniverUIPlugin` 的 `container`（DOM id）选项自动完成。
2. **locales 是 `createUniver` 顶层选项**：`{ locale, locales: { zhCN: mergeLocales(sheetsZhCN, docsZhCN) } }`，
   不再属于 preset 配置；多 preset 语言包用 core 的 `mergeLocales` 合并。
3. **方法重命名**：`getUnit` 系方法在 1.1.0 facade 中调整为 `getWorkbook`/`getDocument`/`getSheetByName` 等。
4. **createUniver 按 pluginName 去重**：多个 preset 注册同名插件时**后者覆盖前者**，
   因此 sheets + docs + CF preset 可混装于同一实例（官方组合模式）。
5. **公式计算是异步的**：触发器要等 workbench 渲染到 Rendered 生命周期才启动，
   程序化写入公式后需轮询回读（本 POC 轮询 250ms×最长 10s，实测首次命中 <1s）。

### 5.4 性能（20k 行 × 10 列，无头链路 perf-large.mjs）

| 指标 | 数值 |
|---|---|
| 载入（createWorkbook） | 115–123ms |
| 程序化编辑 | 8ms |
| 快照导出（wb.save） | ~156ms |
| **总计** | **~280–287ms** |
| RSS | 161MB → 197MB |
| JS Heap | 74.9MB → 105.5MB |
| 快照体积 | 4,831,494 字节（4.61MB） |

结论：**万行级工作簿在无头链路加载 + 编辑 + 导出全程 <300ms、内存增量 <40MB**，
20k 行对服务端批处理与版本快照存储没有压力；快照 ~4.6MB/万行可作为版本存储的容量基线。
浏览器端同数据规模未单独压测（初始化 + 双文档载入 ~57MB JS 内存，万行渲染属常规场景）。

### 5.5 许可证审计（scripts/audit-licenses.sh，逐包扫描 node_modules/.pnpm）

- 全部 `@univerjs*` 包均为 **Apache-2.0**；
- **无任何 `@univerjs-pro` 包**；无空 license 包；
- 唯一非 Apache-2.0 依赖：传递依赖 `@univerjs/icons@1.46.0`（**MIT**，浏览器项目引入，宽松许可，兼容）；
- 审计脚本对宽松许可白名单（MIT/BSD/ISC/0BSD/Unlicense/Zlib/BlueOak-1.0.0）标记"[宽松许可，兼容]"不误报。
- **审计结论：通过。POC 依赖树许可证干净，可安全用于 M2 开发。**

## 6. M2 建议

1. **XLSX / DOCX 在线编辑：通过 M2 门禁**。
   编辑器内核（sheets/docs preset）能力完整、性能达标、许可证干净。
2. **Office 文件导入导出的两条路线，需商务/技术二选一**：
   - **路线 A（Pro）**：接入 `@univerjs-pro/{sheets,docs,slides}-exchange-client`（浏览器端）或
     `@univerjs-pro/exchange-node`（服务端）。一次授权覆盖三格式导入导出 + 图表/透视等增强；
     需确认 Pro 授权范围、计费与是否允许嵌入我方 SaaS。
   - **路线 B（OSS + 自建桥接）**：本 POC 的 Python 桥接已证明"Office → Univer 快照"可行，
     保真度为"核心内容无损、CF/图片/图表/TOC/脚注按 §4.4 丢失"。工程化成本主要在：
     图片/图表资源对象化存储、CF 规则搬运、导出方向（Univer 快照 → Office 二进制）需自建，工作量显著。
   - 建议：**M2 编辑器本体按路线 B 推进（数据模型 + 编辑 + 版本快照全部 OSS 可控），
     文件导入导出接口预留 exchange 抽象层**，Pro 授权到位后无缝切路线 A。
3. **PPTX：M2 降级**。OSS 无 slides 内核，在线编辑不可行；按需求 §14.1 约定降级为
   "预览 + 下载 + 提示暂不支持在线编辑"。若 Pro 授权包含 slides，则 PPTX 在线编辑可提升为 M2+ 范围。
4. **公式契约（§5.1）必须写入 M2 开发规范**：任何自建的导入/桥接层输出 `f` 一律带前导 `=`，
   否则公式静默失效（不报错，极难排查）。
5. **无头/浏览器能力差异（§5.2/§5.3）纳入服务端设计**：服务端（node preset）不能依赖公式重算，
   公式缓存值需在导入层预写（如本 POC 的 `v` 字段）；涉及公式的值校验逻辑不要放在无头端。

## 7. 遗留项（需人工/后续跟进）

| # | 事项 | 依赖 |
|---|---|---|
| 1 | Pro 环境实测 `sheets-exchange-client` 导入 XLSX 的快照形态（重点：`f` 是否带 `=`、图片/图表/CF 承载字段），与 §5.1 假设对照 | Pro 授权/试用 |
| 2 | Pro `exchange-node` 服务端互转性能与内存（20k 行基线对照 §5.4） | Pro 授权/试用 |
| 3 | PPTX 预览方案选型（若 Pro 未授权）：服务端渲染缩略图 vs 前端轻量渲染 | 商务决策 |
| 4 | 浏览器端 20k 行渲染压测（无头链路已验证 <300ms，渲染层未压） | 可选 |
| 5 | CF 桥接搬运（当前桥接不搬 CF 规则，浏览器端 CF 预设已验证可用，缺数据层） | 路线 B 工程化 |
| 6 | 图片对象化存储方案（OSS 数据模型无二进制承载，需文件服务 + 资源引用改造） | 路线 B 工程化 |

## 8. 复现方式

```bash
# 依赖安装（浏览器项目 1.1.0 线）
cd poc/univer && pnpm install

# 依赖安装（无头项目 1.0.4 线，独立 pnpm 项目）
cd poc/univer/headless && pnpm install

# 样本生成 + 桥接（python3，依赖 openpyxl/python-docx/python-pptx）
cd poc/univer && python3 samples/gen_samples.py      # 生成 sample.xlsx/docx/pptx
python3 samples/office_to_univer.py                  # 桥接为 univer/*-sample.json + *-expected.json

# 无头验证
node headless/verify-sheets.mjs      # 期望 21/21 PASS
node headless/verify-docs.mjs        # 期望 25/25 PASS
node headless/perf-large.mjs         # 20k 行性能

# 保真度复核（依赖上面产出的 headless/out/*.json）
python3 samples/check_fidelity.py    # 汇总见 headless/out/fidelity-report.json

# 许可证审计
bash scripts/audit-licenses.sh       # 期望"结论: 通过"

# 浏览器 E2E（Vite dev + Playwright headless，步骤见 poc/univer/README.md）
```
