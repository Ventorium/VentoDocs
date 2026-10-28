# 工程验证记录（AGENTS.md）

> 与 `docs/03-conventions.md` §4 配套：每次任务完成后必须完成「任务 → 验证 → 记录」闭环，验证命令与实际结果记录在本文档，禁止无验证声明完成。

## 1. 闭环规则

1. 每个功能/修复完成后，在 §2 追加一条记录：日期、任务、验证命令、实际结果。
2. 验证命令必须可复现（本地服务地址、测试文件 id、基线路径等环境信息随记录给出）。
3. 编辑器静态资源 `editor-dist/` 为 gitignored 运行时产物，验证记录须注明其部署基线（镜像/构建身份）。
4. 验证未全部通过时，记录须标记「未完成/失败」并列出失败项，不得声明完成。

## 2. 验证记录

### 2026-10-27（UTC+8）M2.3 编辑器调试日志回退（sdk / app.js / api.js）

**任务**：`editor-dist/` 三个编辑器文件中移除全部临时调试日志（`[dbg-*]` 共 17 处：sdk 7、app.js 9、api.js 1），保留 3 处功能性修复；回退后重跑全量 e2e 确认零功能回归。

**回退方法**：
- 基线 `/tmp/pristine-editor-dist` = 镜像 `ghcr.io/ranuts/document:sha-e06953c` 的 `/public`，其 `build-identity.json` 与部署目录逐字节一致（revision `e06953cf25bb1d1849ba9af6c959d8b805388226`，contentSha256 `d86a39a90ac205a6ec8fbe44198999a15f7d4318e942ead5f026e12fc9bcfbec`），确认为 3 个目标文件的原始版本。
- 对每个文件断言 `当前文件 − 调试日志 == 基线 + 功能性修复`（逐字节相等）后才写回；原文件备份于 `/tmp/dbg-revert-backup/`。
- 已知非目标状态（不动）：部署树相对基线另有 99 个多出的旧文件（5 月 30 日 `assets/*` 旧哈希块、顶层 `wasm/x2t/`、`img/`、额外字体），为 `scripts/fetch-editor.sh` 增量 `docker cp` 的既有残留；`sw.js`/`sw-register.js` 缺失为脚本设计行为。

**保留的功能性修复**（回退后仍须存在，各恰 1 处）：

| 文件 | 保留内容 |
|---|---|
| `editor-dist/sdkjs/word/sdk-all-min.js` | `asc_getEditorPermissions` 权限桩：`setLicenseType(Success)` + `setCanBranding/Customization(!0)` + `setRights(Edit)` + `setBuildVersion("9.3.0")` + `sendEvent("asc_onGetEditorPermissions",q)`（离线门控依赖） |
| `editor-dist/web-apps/apps/documenteditor/main/app.js` | SETUP-PATH `asc_LoadDocument(!0)`（长动作计数配平；LATE-PATH 保持 `asc_LoadDocument()`） |
| `editor-dist/web-apps/apps/api/documents/api.js` | 离线 url 守卫 `if (_config.document && _config.document.url)`（含中文注释）+ `openDocumentInfo: _openDocument` 命令导出（含中文注释） |

**验证命令与结果**：

| 验证 | 命令 | 结果 |
|---|---|---|
| 调试日志清零 | `grep -rn '\[dbg' editor-dist/` | 0 匹配（sdk/app/api 三文件及全树） |
| 语法解析 | `node --check` × 3 文件 | 全部通过 |
| 相对基线差异 | 行级 diff（difflib，autojunk=False） | 仅 4 个功能 hunk：sdk 1 处（L2362 权限桩）、app.js 1 处（L8 `(!0)`）、api.js 2 处（url 守卫 + 3 行中文注释、L1175 `openDocumentInfo` 导出 + 2 行中文注释） |
| 服务端生效 | `curl -s http://127.0.0.1:8080/document/{sdkjs/word/sdk-all-min.js,web-apps/apps/documenteditor/main/app.js,web-apps/apps/api/documents/api.js}` 比对字节数 | 1998296 / 2168184 / 75941，与磁盘一致；服务端 `sdk` 内容 0 处 `dbg` |
| 全量 e2e | `node /tmp/pw-check/check7.mjs`（31 项） | **31/31 通过**：登录/桌面/窗口链路、docx 编辑器 `state=ready`、`asc_Save` → POST /save 200、版本 v3→v4、保存后自动退出编辑、xlsx/pptx 加载 ready、分享页免登录预览、无未捕获 JS 错误 |

**环境**：app `http://127.0.0.1:8080`（登录 admin / Admin@12345）；服务端 `./target/debug/vento`（pid 3503045，日志 /tmp/vento-server.log）；editor-dist 经 `/document/` 路由从磁盘实时服务，文件改动无需重启；测试文件 `sample.docx` id `01a16905-6375-707d-b419-9520619e9bc4`（本次保存 v3→v4）。

**结论**：调试日志已全部移除，editor-dist 最终状态 = 基线 + 3 处功能性修复，31/31 e2e 零回归。

### 2026-10-27（UTC+8）M5 UI 四 bug 修复（图标位置 / antd 痕迹 / 编辑器打开 / 内容 padding）

**任务**：用户反馈 4 个问题：① 桌面图标应从左上角开始、不被顶部状态栏遮挡；② 应用页面仍有 antd 元素痕迹；③ office 编辑器无法打开；④ 应用内容全部顶着窗户、没有 padding。

**关键发现（部署链）**：SPA 前端经 `include_dir!("web/dist")`（`crates/vk-app/src/main.rs:14`）**编译时嵌入二进制**，不是磁盘实时服务。此前「`pnpm -C web build` 后无需重启」的结论**错误**（editor-dist 才是磁盘实时服务）。本轮起 SPA 变更生效流程固定为：`pnpm -C web build` → `cargo build` → 重启 `./target/debug/vento`。这也解释了为何用户在 10-26 20:15 构建后持续看到旧 UI。

**代码改动**（editor-dist 零改动，仍为 sha-e06953c 基线 + 4 处功能 hunk）：

| 文件 | 改动 |
|---|---|
| `web/src/assets/styles/app.css` | `.vd-desktop-icons`：`top:40px; left:12px; right:auto`（28px 状态栏 + 12px 间距，左列）；`.vd-content`：`display:flex; flex-direction:column; padding:12px; flex:1; min-height:0`（内容不顶窗边）；`.vd-btn-danger`：实色 #ff453a → 红色 tint（`rgba(255,69,58,.12)` 底 + 红字）；`.vd-tabs`/`.vd-tab`：蓝色下划线 → 胶囊分段（`border-radius:8px`、选中 `accent 20%` 底 + 600 字重、无边框下划线）；`.vd-btn-primary`：平面纯色 → 亮面渐变 + 同色光晕 + hover brightness（去 antd 平面蓝） |
| `web/src/apps/audits.tsx` / `trash.tsx` / `teams.tsx`（团队列表/用户列表/页面根） | 页面根容器追加 `flex:1; minHeight:0`，使 `.vd-table-wrap` 获得确定高度、表内滚动生效且不溢出 |
| `web/src/apps/settings.tsx` | 页面根追加 `flex:1; minHeight:0; overflow:auto` |
| `web/src/shell/DesktopShell.tsx` | 图标注释 右列→左列（拖拽排序为索引制，布局无关，逻辑不动） |

**验证命令与结果**：

| 验证 | 命令 | 结果 |
|---|---|---|
| SPA 重建 | `pnpm -C web build` | 成功，新 hash `index-u22_3hoi.js` / `index-Gu1tGMl4.css` |
| 二进制重嵌 + 重启 | `cargo build` → kill 3503045 → `nohup ./target/debug/vento > /tmp/vento-server.log 2>&1 &` | 新 pid 3651382；`GET /` 200；`curl /` 引用新 hash 资产；二进制内 12 处新 hash 字符串 |
| UI 新校验 | `node /tmp/pw-check/check8.mjs`（10 项，新脚本） | **10/10 通过**：图标容器 `left=12/top=40`（左列、避开 28px 状态栏）、首图标 `elementFromPoint` 无遮挡、窗口内容 `gapL=13/gapT=51`（12px padding 生效）、`.vd-tab.on` 胶囊样式（8px 圆角 + accent 底）、DOM `[class*="ant-"]`=0、docx 只读预览编辑器 ready |
| 全量回归 | `node /tmp/pw-check/check7.mjs`（31 项） | **31/31 通过**：docx 编辑器 `state=ready`、`asc_Save` → POST /save 200、版本 v4→v5、保存后自动退出编辑、xlsx/pptx ready、分享页免登录预览、无未捕获 JS 错误 |
| 截图留证 | `/tmp/pw-check/fix8-desktop.png`、`fix8-explorer.png`、`fix8-teams.png`、`fix8-users.png`、`fix8-docx-preview.png` | 图标左上角、内容 padding、胶囊标签、无 antd 痕迹 |

**bug③（编辑器无法打开）专项**：服务端新浏览器复测**通过**（check8 只读预览 ready、check7 编辑+保存 ready，均 ~3s 内）。用户侧失败最可能为：旧标签页/浏览器缓存停留在 SDK 补丁前构建（editor-dist 于 10-26 晚间才完成补丁+回退），或旧部署（docker 镜像）未更新。处置：已给用户硬刷新指引（Ctrl+Shift+R / 清除站点数据 / 新标签页），并在收尾前 `POST /api/v1/files/{id}/unlock` 清除了 admin 残留文件锁（确认 `"lock":null`，v5）。

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 pid 3651382；editor-dist 基线 `sha-e06953c`（未变）；测试文件 `sample.docx` id `01a16905-6375-707d-b419-9520619e9bc4`（本轮 v4→v5，收尾已解锁）。

**结论**：4 项 UI 修复完成并双 e2e 全过（check8 10/10 + check7 31/31）；bug③ 服务端侧通过，用户侧按缓存/旧部署处置。

### 2026-10-27（UTC+8）M2.4 VentoOS 同款文件查看/编辑（分类型打开 + 极简工具栏）

**任务**：用户反馈（原话）："文件查看/编辑器的逻辑还是没有参考ventos 的，ventos 针对不同的文件有不同的打开逻辑，而且页面按钮也不一样，没有现在的什么返回 下载啥的，你直接把ventos的那一套搬过来"。即：按文件类型区分打开/渲染逻辑；文件详情页改为 VentoOS 同款极简布局（文件图标 + 文件名 + 唯一上下文化操作），去掉「返回 / 下载」按钮；下载/分享/版本历史/锁管理保留在文件管理器右键菜单。

**代码改动**（editor-dist 零改动，仍为 sha-e06953c 基线 + 4 处功能 hunk）：

| 文件 | 改动 |
|---|---|
| `web/src/apps/file/[id].tsx`（重写，199 行） | VentoOS 同款文件详情页：顶栏 = FileIcon + 文件名 + 唯一「进入编辑/编辑」按钮（无返回/下载）；页脚 = 大小 · 当前版本 · 更新时间；进入编辑自动加锁（409 仅警告），卸载时自动释放自己的锁 |
| `web/src/apps/file/components/FilePreview.tsx`（重写，297 行） | 分类型分发：office→`DocEditor`（docx/xlsx/csv/pptx 可编辑，其余 office 只读）；image→`ImageViewer`（缩放/平移）；pdf→`PdfEmbed`；video/audio→`MediaPlayer`；markdown→`marked` 渲染；text/code→`pre` 直显（>4MB 仅前 4MB，NUL 字节检测降级 hex；编辑态内联 textarea 编辑，Ctrl+S 保存走 multipart /save，409 版本冲突弹提示并可重载）；binary→前 4KB 十六进制转储；不支持类型→图标占位 |
| `web/src/apps/file/components/FileViewer.tsx`（新增，431 行） | 查看器族：`classifyFile`/`isTextFamily`/`readCapped`/`hasNulByte`/`MAX_TEXT_BYTES` + `ImageViewer`/`PdfEmbed`/`MediaPlayer`/`MdView`/`TextPre`/`HexView` |
| `web/src/components/DocEditor.tsx`（重写，398 行） | OnlyOffice 编辑器集成：bridge iframe（`office-editor.html`）加载 → 保存链 `asc_onSaveDocument` → `handleSaveRef`（`x2t.convertBinToDocument` 转换，`onlyoffice-file-stream` 协议已带转换结果则直通）→ `POST /api/v1/files/{id}/save`（multipart file+base_version）；`[readonly]` 变化时 `retry()` 整栈重建（权限仅在 init 时下发） |
| `web/public/office-editor.html`（新增，228 行） | OO 桥接页：`openDocumentInfo`（空 url）→ `openDocument(bin)`；appOption `canSaveDocumentToBinary:true`（**必需**——app.js 仅在此为真时注册 `asc_onSaveDocument`→`onSaveDocumentBinary`）；`OO_FILE_STREAM_ONLY` 模式 |
| `web/src/components/office/x2t.ts`（新增，618 行） | 客户端 x2t 文档转换辅助（保存链 `convertBinToDocument`） |
| `web/src/components/ui/kit.tsx` + `toast.tsx`（新增） | VentoOS 深色玻璃风组件（Btn/Spin 等）与 toast |
| `web/src/assets/styles/app.css` | `.vd-file-toolbar` / `.vd-text-edit` / `.vd-truncate-banner` 等文件详情页样式 |
| `web/src/components/FileIcon/index.tsx` | 文件图标扩展（预览占位/分类型展示） |

**关键发现（docx 保存 e2e 反复失败的根因，已闭环）**：
1. 「进入编辑」触发 `[readonly]` effect → `retry()` → bridge + 整个 app frame 栈重建，旧只读帧短暂残留。旧 check7 `findAppFrame` 无 `!isDetached()` 过滤且复用同一 frame 对象 → 门控/打字/`asc_Save` 落在**陈旧只读帧**：输入被 viewer 模式丢弃；其 `onSaveDocument` postMessage 发往**旧 bridge**，被 SPA `event.source !== iframeRef.current?.contentWindow` 丢弃 → 90s 内无 POST /save。
2. `asc_Save` 是**变更驱动**的（SDK 未登记变更时静默 no-op），且**返回值双向不可靠**（`ret=false` 后 0.8s 保存成功、`ret=true` 却不保存均实测）——唯一可信信号是 POST /save 网络响应。
3. 文档内容加载前（`document_content_ready` 前）键盘输入被静默丢弃。
4. **遗留锁 bug（本轮修复）**：`[id].tsx` 卸载解锁条件原为 `s.editing && s.isLockOwner`，但「保存成功 → 退出编辑态（editing=false）→ 关窗」路径下锁仍归自己，条件不成立 → 锁残留（e2e 实测 sample.docx、e2e-viewer.txt 各遗留一锁，API `POST /unlock` 手工清理后修复为仅判 `s.isLockOwner`，重新构建复测关窗后 `lock:None`）。

**验证命令与结果**：

| 验证 | 命令 | 结果 |
|---|---|---|
| SPA 重建 + 重嵌 + 重启 | `pnpm -C web typecheck && pnpm -C web build` → `cargo build` → kill 3703191 → `nohup ./target/debug/vento &`（新 pid 3780746） | 成功，部署资产 `index-D-Dc4pyu.js` / `index-DHX41fiR.css` |
| 全量回归（修复前基线构建 D6siw5R9） | `node /tmp/pw-check/check7.mjs`（31 项） | **31/31 通过**（此前 28/31，3 项 docx 保存失败项因 §7 重写为 probe5 验证过的流程而通过） |
| UI 校验 | `node /tmp/pw-check/check8.mjs`（10 项） | **10/10 通过**（图标/padding/胶囊 tab/无 antd/docx 预览 ready） |
| VentoOS 查看器契约 | `node /tmp/pw-check/check9.mjs`（35 项） | **35/35 通过** |
| 全量回归（修复后构建 D-Dc4pyu，含解锁修复） | `node /tmp/pw-check/check7.mjs` + `check8.mjs` | **31/31 + 10/10 通过**；docx 保存 `asc_Save 触发保存 POST /save 200 [HTTP 200]`、`版本递增 v12 → v13`；关窗后 `GET /files/{id}` → `lock:None`（自动解锁修复生效） |
| check7 §7 修复流程（已固化） | probe5 原型 → check7 §7 | 点击「进入编辑」**前**给当前 app 帧打 `window.__preEdit=1`；门控=非 detached + 无 `__preEdit` 标记 + mask GONE + `editor.isLoadFullApi`（1s 轮询 ≤120s，防热缓存 ~2s 快速重建误判）；轮询 `window.document_content_ready`（500ms ≤150s）；overlay (150,60) 点击 ×≤3 并验证 `activeElement===TEXTAREA#area_id`（800ms 间隔）；`keyboard.type` 标记文本（delay 50）；静置 2s 等待变更登记；`asc_Save` 重试循环（≤3 次，预算 90/60/60s，**先**挂 `waitForResponse(POST /save)` **再**触发），仅认 HTTP 200 |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep -c '\[dbg'` | 1998296 / 2168184 / 75941（合计 4242421），`[dbg` 0/0/0，与 M2.3 基线一致 |
| 服务端内容核实 | `GET /api/v1/files/{id}/content` + python3 zipfile | v12 含 `E2E-M5-TEST-保存校验` ×4、`P5-ASCII-XYZ` ×1，docx zip 无 media（image-1.jpg 404 属预期） |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid 3780746（日志 /tmp/vento-server.log，**仅启动日志、无逐请求行**，排障靠客户端响应监听 + API GET + python3 zipfile）；SPA 编译时 `include_dir!` 嵌入，改动须 `pnpm build → cargo build → 重启`；editor-dist 经 `/document/` 从磁盘实时服务（基线 sha-e06953c）；测试文件 `sample.docx` id `01a16905-6375-707d-b419-9520619e9bc4`（本轮 v12→v13，收尾 `lock:None`）；播放断言用 webm（id `01a17b08-1621-7654-928f-df65fee4f21e`，headless chromium-1148 **无 H.264 解码**）。

**其他备注**：
- ventos 参考（/tmp/ventoos-ref，只读）为**不同 OO 构建**（三文件 md5 全异：api.js 13454B vs 75941B、word sdk 1455417B vs 1998296B、doceditor app.js 2938388B vs 2168184B），且其 SPA 同样不等待 `documentReady`；本实现额外做了 `document_content_ready` 门控，可靠性高于参照。
- 冷/热差异：预览加载会预热 HTTP 缓存，「进入编辑」重建帧热缓存下 ~2s 就绪；冷缓存首次编辑加载明显更慢（e2e 门控上限 120s 覆盖）。
- 浏览器硬关闭不触发 unmount 解锁（残留锁需 `POST /unlock`；200=释放、400=本就未锁，无害）。
- 保存链前提：`canSaveDocumentToBinary` 必须为 true，否则 app.js 不注册 `asc_onSaveDocument`，`asc_Save` 无任何出口。

**结论**：VentoOS 同款文件查看/编辑移植完成——分类型打开逻辑（office 在线编辑 / 图片 / PDF / 音视频 / Markdown / 文本内联编辑 / 二进制 hex）+ 极简工具栏（无返回/下载）全部落地；docx 保存 e2e 失败根因（重建后陈旧帧锁死 + SPA 丢弃旧 bridge 消息 + `asc_Save` 变更驱动且返回值不可靠）查明并固化为 check7 §7 标准流程；顺带修复「保存后关窗遗留锁」bug 并复测生效；check7 31/31、check8 10/10、check9 35/35 全绿，editor-dist 字节锁未动（4242421B / 零 `[dbg`）。

### 2026-10-27（UTC+8）M2.5 UI 两项修复（红绿灯图标居中/正确 + 文件列表单击选中、双击打开）

**任务**：用户反馈 2 个问题（原话）：① "窗口hover时的红绿灯 图标显示不居中 不太正确"；② "文件单击不要直接打开 双击才打开 单击只是选中"。

**关键发现（bug① 诊断）**：Playwright 几何探针（`/tmp/pw-check/probe-tl.mjs`）实测按钮 14×14、glyph 容器与 svg 与按钮中心 **dx/dy 全部 = 0**（.5 像素级居中），DOM 布局本身无偏移；「不居中/不正确」实为**视觉设计问题**——glyph 9px 撑在 14px 圆内显拥挤（VentoOS 参照为 6px）、最大化图标为裸斜杠（非 VentoOS 的全屏角括号箭头）、描边 1.2 无圆头。故按 VentoOS 参照（`/tmp/ventoos-ref/web/src/shell/Window/index.tsx`，"Inline SVG icons for pixel-perfect centering (6×6 canvas, stroke-width 1.5)"）整体搬移其图标实现。

**代码改动**（editor-dist 零改动，仍为 sha-e06953c 基线 + 4 处功能 hunk）：

| 文件 | 改动 |
|---|---|
| `web/src/shell/Window.tsx` | 3 个红绿灯 glyph 替换为 VentoOS 像素级 SVG：显式 `width=6 height=6 viewBox="0 0 6 6" stroke-width=1.5 stroke-linecap=round`；close = 两条 `<line>` 对角（1,1)-(5,5)/(5,1)-(1,5)；minimize = `<line>` (1,3)-(5,3)；maximize = 两个角括号 `<polyline>`（左下 1,3.5→1,5→2.5,5 / 右上 4.5,1→5,1→5,2.5）+ 对角线，替代原裸斜杠；保留 `.vd-tl-glyph` span 作淡入过渡容器 |
| `web/src/assets/styles/app.css` | `.vd-tl-btn .vd-tl-glyph`：9×9 → **6×6**（14px 圆内四周留 4px，光学居中）+ flex 居中；svg `display:block`；hover 显隐（`.vd-titlebar:hover` → opacity 1）、聚焦/失焦配色、失焦 0.5px 边框均保留 |
| `web/src/apps/files/components/EntryTable.tsx` | 新增 `selectedId` state：行 `onClick` 仅 `setSelectedId`（保留 `contains(e.target)` 防 body-portal 弹层误触），`onDoubleClick` 文件→`onOpenFile` / 目录→`onOpenDir`（原单击打开、双击进目录的行为全部迁移到双击）；选中行 `tr.sel`（既有 CSS `background: var(--vd-bg-selection)` 直接复用）；表格空白处单击取消选中 |
| `web/src/apps/files/components/SearchResults.tsx` | 搜索结果行同款行为：单击选中（`tr.sel`）、双击 `onOpenFile` |
| e2e 脚本 | `check7.mjs` L102/L230、`check8.mjs` §5、`check9.mjs` `openFile()`：文件行 `.click()` → `.dblclick()`（check7 L245 右键分享菜单不动）；check8 §5 新增 2 条断言：单击后行含 `.sel` 类、且**未**打开文件窗口 |

**验证命令与结果**：

| 验证 | 命令 | 结果 |
|---|---|---|
| 红绿灯几何探针（修复前基线） | `node /tmp/pw-check/probe-tl.mjs` | 按钮 14×14 居中，glyph 9×9 dx/dy=0 → 确认布局无偏移，问题在图标设计（9px 过大/斜杠最大化） |
| 红绿灯几何探针（修复后） | 同上（重跑） | glyph **6×6**，dx/dy=0；`tl-zoom.png` 4× 截图目视：×/− 清晰居中，最大化为角括号+对角箭头 |
| SPA 重建 + 重嵌 + 重启 | `pnpm -C web typecheck && pnpm -C web build` → `cargo build` → kill 3780746 → `nohup ./target/debug/vento &`（新 pid **3832343**） | 成功，部署资产 `index-gRdKZPbY.js` / `index-BGmGaaQ7.css` |
| 全量回归 | `node /tmp/pw-check/check7.mjs`（31 项，文件行已改 dblclick） | **31/31 通过**；docx 保存 v13→v14 |
| UI 校验 + 新交互断言 | `node /tmp/pw-check/check8.mjs`（12 项 = 原 10 + 2 新） | **12/12 通过**，含「单击选中行（.sel 类）」「单击未打开文件窗口」「双击打开文件详情」 |
| VentoOS 查看器契约 | `node /tmp/pw-check/check9.mjs`（35 项，openFile 已改 dblclick） | **35/35 通过**；txt 保存 v5→v6、docx 保存 v14→v15 |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep -c '\[dbg'` | 1998296 / 2168184 / 75941（合计 4242421），`[dbg` 0/0/0，与基线一致 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid 3832343（日志 /tmp/vento-server.log）；SPA 改动经 `pnpm build → cargo build → 重启` 生效（`include_dir!` 编译期嵌入）；测试文件 `sample.docx` id `01a16905-6375-707d-b419-9520619e9bc4`（本轮 check7 v13→v14、check9 v14→v15）；editor-dist 基线 `sha-e06953c`（零改动）。

**结论**：两项修复完成——① 红绿灯图标按 VentoOS 像素级实现（6px / 1.5 圆头描边 / 角括号最大化）整体搬移，探针复测 dx/dy=0 且截图目视居中；② 文件列表（含搜索结果）单击仅选中、双击才打开，e2e 新增行为断言；check7 31/31、check8 12/12、check9 35/35 全绿，editor-dist 字节锁未动（4242421B / 零 `[dbg`）。

### 2026-10-27（UTC+8）M2.6 回收站与文件管理器多选交互改造（Windows 风格）

**任务**：用户原话："回收站 不需要显示前面的多选 用cmd支持多选 后面的恢复按钮也不要 应该是通过右键 或者上面的批量恢复 还有文件"。经 ask_user_question 确认范围：① 回收站去掉**整列**操作（前置复选框列 + 后置操作列的行内 恢复/彻底删除 按钮一并移除），操作只走行右键菜单 + 顶部「批量恢复 / 批量彻底删除」，右键作用于多选；② 文件管理器（EntryTable）也加 Cmd/Ctrl 多选，右键作用于多选（批量菜单**仅删除**，其他操作是单项模态，无批量后端——已文档化为已知限制）。

**关键发现**：
1. **上传冲突检测包含回收站**：`POST /api/v1/directories/{id}/files` 对「原路径同名且已入回收站」的文件也返回 409「同级已存在同名文件」→ e2e 种子/清理必须走循环：目录内 m26-* 先 `DELETE /api/v1/files/{id}`（进回收站），再 `DELETE /api/v1/files/{id}/purge`（彻底删除），重复至干净。
2. token 的 localStorage 键是 `user.access_token`（`web/src/store/token.ts` `TOKEN_KEY`），非 `token`/`accessToken`。
3. 后端返回**裸 JSON 无包裹**（curl 实测：login 为 `{token,user,expires_in}`，trash/files 为裸数组，directories/{id} 为 `{directory,children,my_perms}`）；`children` 是 serde tag Entry：`{kind:'file',file:FileMeta}` / `{kind:'directory',directory}`，取 name/id 须 `x.file?.name` / `x.file?.id`。
4. 右键菜单宿主 `ContextMenuHost` 挂在 DesktopShell 级（DOM 类 `.vd-ctx` / `.vd-ctx-item`），跨窗口全局可见 → Playwright 用 `page.locator('.vd-ctx')` 即可，无需窗口内定位。
5. 文件管理器批量菜单**故意只含删除**：重命名/移动/复制/分享/授权均为单项模态（每目标一次 API + 一次 UI 流），批量需后端新接口，不overbuild。

**代码改动**（editor-dist 零改动，仍为 sha-e06953c 基线 + 4 处功能 hunk）：

| 文件 | 改动 |
|---|---|
| `web/src/apps/trash.tsx` | 删复选框列 + 操作列（行内 恢复/彻底删除 `Btn`）；行改 `tr.clickable`（选中加 `sel`），`onClick`：Shift=自 `anchorId` 连选（visible id 列表切片）/ Cmd\|Ctrl=切换选中 / 普通=单选，均设 anchor；`onContextMenu`：多选中该行→批量菜单「恢复（N 项）」+（全为文件时）分隔线 +「彻底删除（N 项）」danger，否则单选该行出单项菜单；新增 `restoreTargets`/`purgeTargets`（逐个调 API，文件 409→改名模态、目录 409→报错、purge 仅文件）；`selectedFileCount` memo 驱动顶部「批量恢复/批量彻底删除」启用态（彻底删除需全选皆文件）；提示文案「点击选中，Cmd/Ctrl+单击 多选，Shift+单击 连选；右键或顶部按钮恢复 / 彻底删除（仅文件）。」；表格空白单击清空选择；thead 六列 名称\|类型\|大小\|原路径\|删除时间\|剩余保留 |
| `web/src/apps/files/components/useEntryActions.ts` | 新增 `delete-many` 模态类型 + `confirmDeleteMany` + `doConfirmDeleteMany`（循环 `doDelete`，`deleting` 态，完成按成功计数 toast），并入 return |
| `web/src/apps/files/components/EntryTable.tsx` | `selectedIds`/`anchorId` 多选（语义同回收站，`e.currentTarget.contains(e.target)` 守卫）；`multiCtxItems()`：单选删除项「删除所选 N 项（移入回收站）」danger（`PERM.DELETE_RESTORE` 门控）；行右键：多选中该行→批量菜单，否则回落到 `rowCtxItems(r)` 单项菜单；表格空白单击清空；`delete-many` Modal 分支（标题「删除 N 项」、danger 删除 `loading={deleting}`） |
| `web/src/apps/files/components/SearchResults.tsx` | 搜索结果行同款多选（单击/Ctrl/Shift，`tr.sel`；该页无右键菜单） |
| e2e 脚本 | 新增 `check10.mjs`（16 项，自含预清理/收尾清理循环） |

**验证命令与结果**：

| 验证 | 命令 | 结果 |
|---|---|---|
| SPA 类型检查 + 构建 | `pnpm -C web typecheck && pnpm -C web build` | 通过；产物 `index-tL3B2JRJ.js` / `index-BGmGaaQ7.css` |
| 重嵌 + 重启 | `cargo build` → kill 3832343 → `nohup ./target/debug/vento &`（新 pid **3874330**） | `curl -s http://127.0.0.1:8080/` 含新 hash，部署生效 |
| M2.6 交互 e2e | `node /tmp/pw-check/check10.mjs`（16 项：种子→文件管理器单击 1 sel/Ctrl 2 sel→多选右键「删除所选 2 项（移入回收站）」→确认框「删除 2 项」→行消失→API 确认双双入回收站→回收站无 checkbox/无行内按钮→单击/Ctrl 多选→多选右键「恢复（2 项）」「彻底删除（2 项）」→单选右键恢复 m26-b→API 确认回到原目录且离开回收站） | **16/16 通过**；跑完环境无 m26 残留（收尾清理循环验证） |
| 全量回归 | `node /tmp/pw-check/check7.mjs`（31 项） | **31/31 通过** |
| UI 校验回归 | `node /tmp/pw-check/check8.mjs`（12 项） | **12/12 通过** |
| VentoOS 查看器契约回归 | `node /tmp/pw-check/check9.mjs`（35 项） | **35/35 通过**（docx 保存 v16→v17） |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep -c '\[dbg'` | 1998296 / 2168184 / 75941（合计 4242421），`[dbg` 0/0/0，与基线一致 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid **3874330**（日志 /tmp/vento-server.log，无逐请求行，排障靠客户端响应监听 + API GET）；SPA 改动经 `pnpm build → cargo build → 重启` 生效（`include_dir!` 编译期嵌入）；测试目录「预览测试」id `01a16905-6338-7575-b0df-1c0c76d7fb9d`；测试文件 `sample.docx` id `01a16905-6375-707d-b419-9520619e9bc4`（本轮 check9 v16→v17）；editor-dist 基线 `sha-e06953c`（零改动）。

**结论**：M2.6 完成——回收站去复选框列 + 去行内操作按钮，改 Windows 风格行多选（单击/Ctrl/Shift/空白清空）+ 行右键批量（恢复 N 项 / 彻底删除 N 项，全文件时）+ 顶部批量按钮，单选恢复回原目录经 API 核实；文件管理器同步获得多选 + 右键批量删除（确认框按 N 计数）。**已知限制（by design）**：文件管理器批量右键菜单仅含「删除」——其余操作（重命名/移动/复制/分享/授权）为单项模态且无批量后端，未 overbuild。check10 16/16、check7 31/31、check8 12/12、check9 35/35 全绿，editor-dist 字节锁未动（4242421B / 零 `[dbg`）。

### 2026-10-27（UTC+8）M2.7 文件管理器完整复刻 VentoOS 多列导航 + 文件窗口弱化布局

**任务**：用户反馈（原话）："文件查看工具 没必要保持padding 应该根据每个文件的特点来决策 也没必要加一行 文件名称 进入编辑 底部的meta信息也没必要占那么大 弱化它。不对啊 我看了文件管理器的交互 根本没把ventos的完整的交互复制过来啊 什么树形目录显示 文件查看交互 office现在还显示2层 正在加载中 做的不彻底"。经 ask_user_question 确认范围：① fm-nav=「完整复刻多列导航（推荐）」——Finder 式多列 + 右侧单击预览 + VentoOS 完整交互；② edit-btn=「放标题栏右侧」——删除文件窗口 `.vd-file-toolbar` 整行（含「文件名称」行），编辑入口上移标题栏。

**代码改动**（editor-dist 零改动，仍为 sha-e06953c 基线 + 4 处功能 hunk）：

| 文件 | 改动 |
|---|---|
| `web/src/apps/files/components/ColumnView.tsx`（重写，~1055L） | 单列表格 → Finder 式多列导航：`.vd-fm-cols` 下每目录一列（`.vd-fm-col`：`-head` 列头 + `-items`），列 N 显示第 N-1 列选中目录的 children；目录单击=展开新列（`.is-ancestor` 链高亮 + `.is-current` 当前列目录），文件单击=**仅右侧预览**（`.vd-fm-preview` 面板：名/图标/元信息/图片缩略，不改变列选中态）；双击文件=`onOpenFile` 打开文件窗口、双击目录=进入；pathbar 复刻（`.vd-fm-pathbar`：根 `button.vd-fm-path-seg` + 名称段（末段 `.is-last` 加粗）+ 搜索框 + 刷新按钮）；搜索态列区替换为 `.vd-table` 结果表、Escape 恢复；marquee 框选（`.vd-fm-marquee`，列内自下而上拖选，锚点=起点条目，Shift/Ctrl 语义同 M2.6）；Ctrl+单击多选（`.is-current` 主选保留、`.is-multi` 次选、Ctrl 点主选=取消）；行内重命名（F2/右键「重命名」→ `.vd-fm-rename` 输入框，Enter 提交/Esc 取消，409 保留可改重名）；键盘导航（↑↓/←→/Enter/Delete/F2/Esc，列容器 focus 后直接可用，锚点=当前目录或首个条目）；DnD 直接移动（`dataTransfer` 自定义 MIME `application/x-vento-entry`，drop 目标=被拖拽条目所在列的目录，同目录/祖先目录守卫，**无确认模态**；外部本地文件 drop → `uploadExternal` 上传）；空白右键=新建目录/上传文件/刷新；新建目录走 `createDir` 模态（409 保持模态）；多选右键=「删除所选 N 项（移入回收站）」（M2.6 delete-many 模态，无批量后端的操作不做批量） |
| `web/src/apps/file/[id].tsx`（243L） | 删除 `.vd-file-toolbar` 工具栏行（含「文件名称」行）；编辑入口上移标题栏右侧 `.vd-titlebar .vd-titlebar-action`：非编辑态 office→「进入编辑」、text→「编辑」（图片/PDF/音视频等只读类型无按钮）；编辑态标题栏 `.vd-titlebar-status`「正在编辑 v{n}」/「正在保存…」+ 保存（仅文本）+「退出编辑」；`onSaved` → `setEditing(false); refresh()`（**文本保存成功自动退出编辑**）；「退出编辑」=丢弃未保存（不解锁）；解锁条件 `s.isLockOwner`（M2.4 修复，窗口关闭释放） |
| `web/src/apps/file/components/FilePreview.tsx` / `FileViewer.tsx` | 文本内容区 `.vd-file-content--text` padding 按类型特点 `16px 20px`（图片无 padding 全屏舞台、PDF/音视频/Markdown 各按自身特点）；底部 meta 弱化为单行 `.vd-viewer-footer`：11px tertiary 字重 `{size} · v{N} · {datetime}`（无「当前版本：」前缀，实测高 23.5px，原 meta 条 3 行占高取消） |
| `web/src/components/DocEditor.tsx` | office 加载 overlay 文案统一为「正在加载文档…」；overlay 在 app frame 文档内容就绪前移除，与编辑器 iframe 零重叠（修复「2 层正在加载中」）；保存链 `asc_onSaveDocument → convertBinToDocument → POST /save` 不变 |
| e2e 脚本 | 新增 `check11.mjs`（47 项 FM 交互对拍，自含种子/预清理/收尾清理）、`check12.mjs`（21 项文件窗口弱化布局 + 编辑保存）；旧回归 `check7/8/9/10` 全部适配新 DOM：`.vd-breadcrumb`→`.vd-fm-pathbar`、`tr` 行→`.vd-fm-item[data-fm-entry=...]`（目录单击展开、文件双击打开、右键菜单）、metaBar `当前版本：v`→`.vd-viewer-footer` + `/· v(\d+) ·/`、overlay `正在加载在线编辑器`→`正在加载文档`、check8 单击选中 `.sel` 断言改为「预览面板出现 + 列选中态不变」、check10 FM 侧 `tr.sel`→`.vd-fm-item.is-multi`（Ctrl 单击） |

**关键交互语义（与 VentoOS 严格对齐，经用户确认的决策）**：
1. 文件单击=预览 only，不设列高亮；列选中态=隐式键盘光标（锚点），Ctrl/Shift 多选语义同 VentoOS。
2. DnD drop=**直接移动**（无确认模态），同父/祖先守卫基于已物化 `path`；目标目录取自被拖拽条目自身所在列（非当前打开列）。
3. pathbar=根按钮+名称段（末段粗体，非完整面包屑链）+ 搜索框（右侧）+ 刷新；搜索态替换列区为结果表。
4. 剪贴板 Ctrl+C/X/V 未实现（记录为简化项）；上传入口=空白右键菜单 + 外部文件拖入两个。
5. 文件窗口标题栏=唯一操作区（无独立工具栏行）；文本保存成功自动退出编辑（`onSaved`）；「退出编辑」=丢弃（不解锁）；office 保存经 asc_Save 链（同 M2.5 门控流程）。
6. 回收站（M2.6）与分享/授权（单项模态）交互不变；文件管理器批量右键仍仅「删除」（无批量后端，不 overbuild）。

**验证命令与结果**：

| 验证 | 命令 | 结果 |
|---|---|---|
| FM 交互对拍（新） | `node /tmp/pw-check/check11.mjs`（47 项：多列展开/列头/ancestor 链→pathbar 段+末段粗体→单击文件预览面板（名/元信息/图片缩略）+选中态不变→双击打开+关闭→Ctrl 多选 `.is-multi`→marquee 框选 4 项锚点 sample.xlsx→行内重命名 F2+提交+Esc 取消→键盘 ↑↓/←→/Enter/Delete/F2→DnD 跨列移动（API 核实入目标目录）+同目录守卫+祖先目录守卫→外部文件拖入上传→空白右键三项→新建目录（含 409 重名保持模态）→搜索替换列区+Escape 恢复→无 JS 错误→清理无残留） | **47/47 通过** |
| 文件窗口弱化布局（新） | `node /tmp/pw-check/check12.mjs`（21 项：无 `.vd-file-toolbar`→标题栏「编辑」(txt)→`.vd-viewer-footer` 存在且 h<30px（实测 23.5）→`.vd-file-content--text` padding `16px 20px`→编辑态 textarea+状态条「正在编辑 v{n}」+保存/退出编辑→Ctrl+S 保存 toast「已保存为新版本 v{n}」+API 核实内容→**保存后自动退出编辑**（文本框消失、标题栏恢复「编辑」）→再次进入编辑→「退出编辑」丢弃路径→office 加载 overlay/iframe 帧序列 250ms 轮询 `[{13ms overlay=1,iframe=0},{286ms overlay=1,iframe=0},{555ms overlay=0,iframe=1}]` **零重叠**且 <1.5s→docx 标题栏「进入编辑」→无 JS 错误） | **21/21 通过** |
| 全量回归（适配后） | `node /tmp/pw-check/check7.mjs`（31 项） | **31/31 通过**（docx 保存 v17→v18、xlsx/pptx ready、分享、团队/回收站/设置/审计） |
| 四 bug UI 回归（适配后） | `node /tmp/pw-check/check8.mjs`（21 项） | **21/21 通过**（图标/padding/多列进入/单击预览+选中态不变/双击打开/docx 只读预览 ready） |
| 查看器契约回归（适配后） | `node /tmp/pw-check/check9.mjs`（37 项） | **37/37 通过**（txt 保存 v9→v10 自动退出编辑、docx 保存 v18→v19） |
| 回收站+多选回归（适配后） | `node /tmp/pw-check/check10.mjs`（16 项，FM 侧 Ctrl 多选 `.is-multi`） | **16/16 通过** |
| editor-dist 字节锁 | `stat -c%s` 三文件 + `grep -rc '\[dbg' editor-dist` | 1998296 / 2168184 / 75941（合计 4242421）精确匹配基线，`[dbg` 0 处 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid **4003252**（日志 /tmp/vento-server.log，无逐请求行，排障靠客户端响应监听 + API GET）；部署资产 `index-2NlcRr2e.js`（M2.7 构建，`include_dir!` 编译期嵌入）；测试目录「预览测试」id `01a16905-6338-7575-b0df-1c0c76d7fb9d`；`sample.docx` id `01a16905-6375-707d-b419-9520619e9bc4`（本轮 v17→v18→v19）；`e2e-viewer.txt` id `01a17aee-f685-7261-b0af-025e218069f3`（本轮 v9→v10，测试内容）；editor-dist 基线 `sha-e06953c`（零改动）。

**结论**：M2.7 完成——文件管理器整体复刻 VentoOS 多列导航（列展开/右侧单击预览/列头与 ancestor 链/pathbar 名称段/marquee 框选/Ctrl 多选/行内重命名/键盘导航/DnD 直接移动含守卫/外部拖入上传/搜索替换列区/空白右键新建目录），文件窗口按用户要求弱化：删「文件名称」工具栏行（编辑入口上移标题栏右侧）、文本 padding 按类型 `16px 20px`、底部 meta 弱化为 23.5px 单行 `{size} · v{N} · {datetime}`，office 加载 overlay 与 iframe 零重叠（555ms 就绪，修复「2 层正在加载中」）。check11 47/47、check12 21/21、check7 31/31、check8 21/21、check9 37/37、check10 16/16 全绿（173 项），editor-dist 字节锁未动（4242421B / 零 `[dbg`）。**已知简化（记录在案）**：文件管理器无剪贴板 Ctrl+C/X/V；批量右键仅「删除」（无批量后端）；上传入口=空白右键 + 外部拖入。

### 2026-10-27（UTC+8）M2.8 文件窗口四项修复（csv 打不开 / 文本 padding / 编辑按钮图标化 / pathbar 布局）

**任务**：用户反馈 4 个问题（原话）：① "csv文件打开 报错 Document conversion failed: Conversion failed with code: 88"；② "我觉得在文件打开时的 vd-file-content vd-file-content--text 元素里的padding是不需要的"；③ "进入编辑这个按钮太丑 用一个图标+tooltip改动"；④ "文件浏览器里的 vd-fm-pathbar 这个元素不应该参与下面文件的左右布局 要加也是放上面"。

**关键发现（bug① 根因）**：csv 曾列在 `EDITOR_EDITABLE_EXT` 中 → 按 office 族走 DocEditor（OO 桥）→ 只读打开需 x2t wasm 转换，而当前 OO 构建（sha-e06953c 字节锁，不可升级）的 x2t `main1` **不支持 csv 输入，返回错误码 88**（`x2t.ts` L220 `Conversion failed with code: ${result}` → L312 拼成用户所见报错）。VentoOS 参照的 file-viewer `TEXT_EXTS` 本就含 `'csv'`（csv 走文本族）——本实现是偏离参照的旧决策。修复=把 csv 归入文本族（文本直显 + 内联编辑 + Ctrl+S 版本保存），与参照对齐。

**代码改动**（editor-dist 零改动，仍为 sha-e06953c 基线 + 4 处功能 hunk）：

| 文件 | 改动 |
|---|---|
| `web/src/components/DocEditor.tsx` | `EDITOR_EDITABLE_EXT` 移除 `'csv'`（`['xlsx','docx','pptx']`）→ csv 不再走 OO 桥；`classifyFile` 既有逻辑使 csv（∈TEXT_EXTS）落到 `'text'`，`OFFICE_EXT`/`isTextFamily`/FilePreview 分发全部派生自该集合，自动改走文本直显+内联编辑。注释记录原因 |
| `web/src/apps/file/components/FilePreview.tsx` | L43 注释同步（docx/xlsx/pptx 可编辑，csv 走文本族） |
| `web/src/assets/styles/app.css` | ② `.vd-file-content--text` padding `16px 20px` → **`0`**（用户要求，实测 computed `0px`）；④ `.vd-fm-nav` 补 **`flex-direction: column`**——原 `display:flex` 无方向=横向 row，pathbar 被排进「pathbar｜cols+preview」左右布局；改为纵向后 pathbar 独占顶行（原已有 `flex-shrink:0` + `border-bottom` 分隔），列区+预览面板在下方全宽展开。纯 CSS，JSX 无需改 |
| `web/src/apps/file/[id].tsx` | ③ 标题栏按钮全部 `Btn`（文字）→ `IconBtn`（26px 纯图标，38px 标题栏内）+ 原生 `title` tooltip（代码库无 Tooltip 组件，与 FM pathbar 段一致）：非编辑态=单个 `<PenLine>`（title=office「进入编辑」/文本「编辑」；被他人锁定时 title 说明锁定人，disabled）；编辑态=`.vd-titlebar-status` 状态条（不变）+ `<Save>`（title「保存」，保留 `canTextEdit` 守卫——office 无标题栏保存）+ `<X>`（title「退出编辑」）。`entering`/`saving` 期间 disabled |

**验证命令与结果**：

| 验证 | 命令 | 结果 |
|---|---|---|
| SPA 类型检查 + 构建 | `pnpm -C web typecheck && pnpm -C web build` | 通过；产物 `index-PIRoJ3kG.js` |
| 重嵌 + 重启 | `cargo build` → kill 4003252 → `nohup ./target/debug/vento &`（新 pid **4051629**） | `GET /` 引用新 hash；二进制内新 hash 12 处、旧 hash 0 处 |
| 文件窗口+csv（扩展） | `node /tmp/pw-check/check12.mjs`（33 项 = 原 21 适配 + 12 新：txt 内容区 padding `0px`、标题栏「编辑」图标 `button[title="编辑"]`、编辑态「保存/退出编辑」图标、Ctrl+S 保存 v+1 自动退出、docx「进入编辑」图标；**csv 新段**：种子唯一 csv→刷新→双击打开→`.vd-text-pre` 直显、**无 OO iframe**、**无 Conversion failed**、padding 0px、页脚 v1、标题栏「编辑」图标（非「进入编辑」）→编辑→Ctrl+S→toast v2、页脚 v2、自动退出→purge 清理） | **33/33 通过** |
| Office 全量回归（适配后） | `node /tmp/pw-check/check7.mjs`（31 项，3 处 `button:has-text("进入编辑")`→`button[title="进入编辑"]`） | **31/31 通过**（docx 保存 v19→v20、xlsx/pptx ready、分享/团队/回收站/设置/审计） |
| 四 bug UI 回归 | `node /tmp/pw-check/check8.mjs`（13 项，pathbar 移至顶行后选择器不变） | **13/13 通过** |
| 查看器契约回归（适配后） | `node /tmp/pw-check/check9.mjs`（37 项，标题栏文字选择器→title 属性选择器） | **37/37 通过**（txt 保存 v12→v13、docx 保存 v20→v21） |
| 回收站+多选回归 | `node /tmp/pw-check/check10.mjs`（16 项，无标题栏按钮依赖） | **16/16 通过** |
| FM 交互对拍回归 | `node /tmp/pw-check/check11.mjs`（47 项，pathbar 在顶行后全部交互选择器/几何断言不变） | **47/47 通过** |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep -rq '\[dbg' editor-dist` | 1998296 / 2168184 / 75941（合计 4242421）精确匹配基线，`[dbg` 零残留 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid **4051629**（日志 /tmp/vento-server.log，无逐请求行）；部署资产 `index-PIRoJ3kG.js`（M2.8 构建，`include_dir!` 编译期嵌入）；测试目录「预览测试」id `01a16905-6338-7575-b0df-1c0c76d7fb9d`；用户报错源文件 `111.csv` id `01a16bf9-c686-7386-a2a4-3d29fd384be8`（未动）；csv e2e 用每次运行唯一名文件，测毕 API purge；`sample.docx` 本轮 v19→v20→v21；`e2e-viewer.txt` 本轮 v12→v13；editor-dist 基线 `sha-e06953c`（零改动）。

**结论**：M2.8 四项全部完成——① csv 归文本族直显+内联编辑（x2t 不支持 csv 的 code 88 报错消除，与 VentoOS 参照 TEXT_EXTS 含 csv 对齐，**记录在案的偏离修正**）；② 文本内容区 padding 归 0；③ 标题栏「编辑/进入编辑/保存/退出编辑」全部图标化 + 原生 tooltip（锁定态 tooltip 说明锁定人）；④ pathbar 移出左右布局、独占顶行（`.vd-fm-nav` 补 `flex-direction: column`）。check12 33/33、check7 31/31、check9 37/37、check10 16/16、check11 47/47、check8 13/13 全绿（177 项），editor-dist 字节锁未动（4242421B / 零 `[dbg`）。**已知简化（沿袭 M2.7）**：无剪贴板 Ctrl+C/X/V；批量右键仅「删除」；上传入口=空白右键 + 外部拖入。

**补充（M2.8 追加）**：pathbar 段 `.vd-fm-path-seg` 为原生 `<button>`，此前漏了去 UA 默认样式，残留 `buttonface` 灰底 + outset 边框，视觉上像一排灰胶囊。补 `background: transparent; border: none; font: inherit`，并删去 hover 灰底、只保留 hover 文字变色反馈，另加 `:disabled` 半透明（根目录 `/` 在根列时禁用）。`probe-pathseg.mjs` 11/11 通过（无背景/无边框/继承字体/hover 无底/pathbar 顶行全宽无重叠），`pathseg-flat-4x.png` 留证；全量 6 套件回归仍 177/177。

### 2026-10-28 (UTC+8) M2.9 浅色模式窗口玻璃 tint 修复（`vd-win-body` 显黑）

**任务**：用户反馈（原文）：「vd-win-body 元素在浅色模式下有问题 显得黑」。

**根因**：窗口背景为多层叠放——`.vd-window.glass-theme` 用 `--vd-bg-window`（浅色下已是浅色 `rgba(248,248,250,0.68)`），但当设置了图片壁纸时 `Window.tsx` 额外渲染 `.vd-win-glass-slice`（壁纸切片，z-0）+ `.vd-win-glass-tint`（z-1 满窗遮罩、`pointer-events:none`），内容 `.vd-win-body` 本身透明（z-2），用户看到的正是 tint 层。tint 硬编码深色 `rgba(20,20,22,0.8)`（聚焦态 `rgba(28,28,30,0.7)`），**且无 `[data-theme='light']` 覆盖**，浅色下近黑遮罩盖满全窗，故「显得黑」。当前用户设置即 `theme_mode=light` + `wallpaper=/wallpapers/light-beach.jpg`（图片壁纸，tint 确实被渲染）。

**代码改动**（仅 `web/src/assets/styles/app.css`，无 TSX 改动）：
- `:root` 新增两 token（深色保留原值）：`--vd-glass-tint: rgba(20,20,22,0.8)` / `--vd-glass-tint-focused: rgba(28,28,30,0.7)`。
- `[data-theme='light']` 新增覆盖：`--vd-glass-tint: rgba(255,255,255,0.55)` / `--vd-glass-tint-focused: rgba(255,255,255,0.66)`（白色半透明罩，与浅色窗口玻璃底协调，聚焦态更亮，对应深色「聚焦更浅」的语义）。
- `.vd-win-glass-tint` 及其 `.vd-window.vd-win-focused` 聚焦态改为引用上述变量。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| 复现（修复前） | `node /tmp/pw-check/probe-lightwin.mjs before`（浅色+light-beach 壁纸） | `tintBg=rgba(28,28,30,0.7)`（深色）→ 复现；`lightwin-before.png` 留证 |
| SPA 类型检查 + 构建 | `pnpm -C web typecheck && pnpm -C web build` | 通过；产物 `index-C3GhMorj.js` |
| 重嵌 + 重启 | `cargo build` → kill 345853 → `nohup ./target/debug/vento &`（新 pid **368722**） | `curl /` 引用新 hash `index-C3GhMorj.js` |
| 验证（修复后） | `node probe-lightwin.mjs after` | **4/4**：`tintBg=rgba(255,255,255,0.66)`（浅色）、tint 层存在、无 JS 错误；`lightwin-after.png` 留证（窗口恢复浅色玻璃观感） |
| 浅色 UI 回归 | `node check8/check11/check12.mjs`（浅色环境） | **93/93**（13+47+33）通过 |
| 深色全量回归 | 临时切 `theme_mode=dark` 跑 check7/8/9/10/11/12 | **177/177**（31+13+37+16+47+33）通过 |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep -rq '\[dbg' editor-dist` | 1998296 / 2168184 / 75941（合计 4242421）精确匹配基线，`[dbg` 零残留 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid **368722**（日志 /tmp/vento-server.log，无逐请求行）；部署资产 `index-C3GhMorj.js`（`include_dir!` 编译期嵌入）；回归前用 `PUT /api/v1/settings/desktop` 临时切深色、测毕已还原用户原设置 `theme_mode=light` / `wallpaper=/wallpapers/light-beach.jpg` / `accent_color=null`（已校验）。

**结论**：M2.9 完成——浅色模式下窗口玻璃 tint 由硬编码深色改为主题感知 token（深色值不变、浅色白色半透明 `rgba(255,255,255,0.55/0.66)`），`vd-win-body` 显黑问题消除，纯 CSS 改动（2 token × 2 主题 + 2 处引用）。before/after 探针实测 tint `rgba(28,28,30,0.7)`→`rgba(255,255,255,0.66)`，`lightwin-before/after.png` 截图留证；浅色 UI 套件 93/93、深色全量 6 套件 177/177 全绿，editor-dist 字节锁未动（4242421B / 零 `[dbg`），用户设置已还原。

### 2026-10-28 (UTC+8) M2.10 大屏切换壁纸不填充/平铺修复（React 内联样式 shorthand clobber）

**任务**：用户反馈（原文）：「在大屏上 切换壁纸会出现壁纸没有填充满 出现 repeat壁纸图片的情况」。

**根因**：`wallpapers.ts` 的 `wallpaperStyle` 返回 `background` **shorthand** + `backgroundSize/Position` longhand 混合对象。首次渲染时 React 按键序设置（shorthand 先、longhand 后覆盖）→ 结果正确（cover）。但**切换壁纸/切换主题**等 live 更新时 React diff 内联样式：只有 `background` shorthand 值变化 → 仅重设该键，CSSOM shorthand 展开会把同元素的 `background-size: auto`、`background-position: 0% 0%`、`background-repeat: repeat` 一并重置，而未变化的 longhand（'cover'==='cover'）不重设 → 元素停留在 auto+repeat。1920px 宽壁纸在 1920px 以上宽视口（4K）即平铺。修复前 4K 探针实证：UI 切换壁纸后 `.vd-desktop` computed `size=auto, auto / repeat=repeat, repeat / pos=0% 0%, 0% 0%`，截图呈 2×2 平铺（太阳出现 4 次）。

**代码改动**：
- `web/src/lib/wallpapers.ts`：`wallpaperStyle` 改为纯 longhand（`backgroundImage` / `backgroundSize: 'cover[, cover]'` / `backgroundPosition: 'center[, center]'` / `backgroundRepeat: 'no-repeat'`），保留 `if (!wallpaper) return null` 语义；JSDoc 注明 shorthand clobber 陷阱（M2.10）。
- `web/src/assets/styles/app.css`：`.vd-desktop` 补 `background-repeat: no-repeat;`（防御纵深）。
- `web/src/shell/Window.tsx` + `app.css`：窗口玻璃切片 `.vd-win-glass-slice` 原用 `background-size: 100vw 100vh` + 默认 `repeat`（拉伸几何，非 16:9 视口下与桌面 cover 几何不一致）；改为切片内放视口尺寸图层 `.vd-win-glass-slice-img`（内联 `wallpaperStyle(url,false)` = cover/center/no-repeat，并按 `left/top = 24-x / 24-y` 补偿窗口位置），切片加 `overflow:hidden`。玻璃与桌面壁纸同几何严格对齐，同时消除平铺隐患。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| 复现（修复前） | `node /tmp/pw-check/probe-wall4k.mjs`（3840×2160，UI 切换壁纸） | 切换后 `.vd-desktop` = `auto, auto / repeat, repeat / 0% 0%, 0% 0%`，2×2 平铺（截图留证，太阳×4；原 before 截图已被修复后运行覆盖，computed 证据在探针输出） |
| SPA 类型检查 + 构建 | `pnpm -C web typecheck && pnpm -C web build` | 通过；产物 `index-qoFvTWXR.js` |
| 重嵌 + 重启 | `cargo build` → kill 464977 → `nohup ./target/debug/vento &`（新 pid **469774**） | `curl /` 引用新 hash `index-qoFvTWXR.js` |
| 修复后 4K 三路径探针 | `node /tmp/pw-check/probe-wall4k-after.mjs`（初始 / UI 切壁纸 / 设置页 UI 切主题 浅→深） | 全部路径 `.vd-desktop` = `cover[,cover]` + `no-repeat[,no-repeat]` + `50% 50%`（深色 2 层含 scrim、浅色 1 层）；切片内层 `cover / no-repeat / 50% 50%` 且 rect 精确覆盖视口 `(0,0,3840,2160)`（正常窗口与最大化两态）；`fix4k-1..6.png` 留证（切壁纸后落霞单太阳满幅、无平铺；浅色主题窗口观感正常） |
| 全量回归 | check7–12 六套件 | 浅色环境：check8 **13/13**、check9 **37/37**、check10 **16/16**、check11 **47/47**、check12 **33/33**；check7 临时切深色 **31/31**（浅色下 30/31，失败项「默认深色主题」为已知环境敏感断言，非回归） |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep -rq '\[dbg' editor-dist` | 1998296 / 2168184 / 75941（合计 4242421）精确匹配基线，`[dbg` 零残留 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid **469774**（日志 /tmp/vento-server.log，无逐请求行）；部署资产 `index-qoFvTWXR.js`（`include_dir!` 编译期嵌入）；探针测毕已还原用户原设置 `theme_mode=light` / `wallpaper=/wallpapers/light-beach.jpg` / `accent_color=null`（GET 已校验）。

**结论**：M2.10 完成——大屏（4K）切换壁纸/切主题后壁纸平铺、不填满问题消除。根因为 React 内联样式 shorthand 重设 clobber 掉 cover longhand，改为纯 longhand + `no-repeat` 后三条 live 路径（UI 切壁纸、主题浅→深、深→浅）computed 均稳定 `cover + no-repeat + center`，4K 截图无平铺；顺带把窗口玻璃切片由 `100vw×100vh` 拉伸改为与桌面同 cover 几何的视口尺寸内层，消除非 16:9 视口下玻璃/壁纸错位与平铺隐患。回归 177 项全绿（check7 深色 31/31），editor-dist 字节锁未动（4242421B / 零 `[dbg`），用户设置已还原。

### 2026-10-28 (UTC+8) M2.11 窗口背景色修复（浅/深色主题玻璃 tint）

**任务**：用户反馈（原文）：「还有窗口的背景色被你改的好难看 参考ventos的啊」——M2.9 把浅色主题窗口玻璃 tint 改成白色半透明后观感发雾、难看，要求参考 VentoOS。迭代中用户补充明确标准（原文）：「浅色系应该是浅底黑字 深色系应该是深底白字吧」。

**调研（VentoOS 参照，只读）**：
- `/tmp/ventoos-ref/web/src/shell/Window/index.tsx` L374-460 完整读取：图片壁纸时窗口根 `background: transparent` + `backdropFilter: none`；玻璃 = 切片（`inset:-24px`，壁纸 `100vw×100vh`，`blur(24px) saturate(180%)`）+ 硬编码**深色** tint（聚焦 `rgba(28,28,30,0.70)` / 非聚焦 `rgba(20,20,22,0.8)`，与主题无关）；标题栏与内容区均透明覆在玻璃上，无按主题变化的浅色 body 表面。
- 我方几何已与其完全一致（`.vd-win-glass-slice` inset -24px + 同滤镜；内层 100vw×100vh + JS 定位补偿，保持 M2.10 cover 几何），唯一可见差异 = M2.9 引入的浅色白 tint 令牌。
- VentoOS 浅色窗口令牌：`--vos-bg-window: rgba(248,248,250,0.68)` / `--vos-bg-window-active: rgba(255,255,255,0.82)`（theme.ts）。

**代码改动**（仅 CSS 2 行 + 注释）：
- `web/src/assets/styles/app.css` 浅色块：`--vd-glass-tint: rgba(248,248,250,0.68)` / `--vd-glass-tint-focused: rgba(255,255,255,0.82)`——直接采用 VentoOS 浅色窗口令牌；相比 M2.9 的 0.55/0.66 提高不透明度，消除"白雾"感，壁纸仅作轻微透出。
- 深色主题令牌不变（`rgba(20,20,22,0.8)` / `rgba(28,28,30,0.7)` = VentoOS 原值）。
- Window.tsx / wallpapers.ts 未改。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| 修复前探针 | `node /tmp/pw-check/probe-lightwin.mjs before` | tint = `rgba(255,255,255,0.66)`（白雾态），3/3，`lightwin-before.png` 留证 |
| SPA 构建（两轮） | `pnpm -C web build` | 第一轮（误按 VentoOS 深色值）产物 `index-BpHchYry.js`；用户补充"浅底黑字"标准后第二轮产物 `index-YvGbAhRD.js`（最终） |
| 重嵌 + 重启 | `cargo build` → kill → `nohup ./target/debug/vento &` | 最终 pid **501970**；`curl /` 引用 `index-YvGbAhRD.js` |
| 浅色探针 | `node /tmp/pw-check/probe-lightwin-m211.mjs` | 6/6：tint = `rgba(255,255,255,0.82)`、切片层存在、窗口聚焦态、无 JS 错误；`lightwin-m211b-light.png`（浅底黑字、壁纸轻透出） |
| 深色探针 | `settheme dark` → `node /tmp/pw-check/probe-darkwin-m211.mjs` → `settheme light` | tint = `rgba(28,28,30,0.7)`、标题文字 `rgb(220,220,220)`（深底白字）；`lightwin-m211b-dark.png` 留证 |
| 全量回归 | check7–12 六套件 | 浅色环境：check8 13/13、check9 37/37、check10 16/16、check11 47/47、check12 33/33；临时切深色后 check7 **31/31**（浅色下 30/31，失败项「默认深色主题」为已知环境敏感断言，非回归） |
| editor-dist 字节锁 | `wc -c` 三文件 | 1998296 / 2168184 / 75941（合计 4242421）精确匹配基线 |
| 设置还原 | `node /tmp/pw-check/getsettings.mjs`（鉴权 GET） | `{"accent_color":null,"theme_mode":"light","wallpaper":"/wallpapers/light-beach.jpg"}` 与用户原设置一致 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid **501970**（日志 /tmp/vento-server.log）；部署资产 `index-YvGbAhRD.js`（`include_dir!` 编译期嵌入）。

**结论**：M2.11 完成——窗口背景色按用户标准「浅底黑字 / 深底白字」修复：浅色 tint 由 M2.9 的白雾（0.55/0.66）改为 VentoOS 浅色窗口令牌 `rgba(248,248,250,0.68)` / 聚焦 `rgba(255,255,255,0.82)`（浅底、壁纸轻微透出、黑字可读），深色维持 VentoOS 深色玻璃 `rgba(20,20,22,0.8)` / `rgba(28,28,30,0.7)`（白字）。纯 CSS 2 行令牌改动，无 TS 变更；探针实测 + 双主题截图留证，回归 177 项全绿，editor-dist 字节锁未动（4242421B），用户设置已还原并 GET 校验。
### 2026-10-28 (UTC+8) M2.12 文件管理器文件选中修复（单击文件高亮 + 列栈截断）

**任务**：用户反馈（原文）：「在文件管理器中 选中某个长路径文件后 再点击短路径上的某个文件 不会选中该文件且 目录树不会选中这个文件的上一级 这不对」——FM 多列视图中，单击文件此前只更新预览面板：文件本身无高亮；选中深层文件后再点浅层文件，该文件不被选中，列栈/路径栏也不会收起至该文件的父级链。

**调研**：
- `web/src/apps/files/components/ColumnView.tsx` `navigate`：文件分支此前仅 `setPreviewEntry(entry)`、不动 `cols` —— 无高亮（渲染层 `is-current` 依据 `col.selected === name`）、无列截断；目录分支设置 `selected` 并展开右列，故目录正常。
- VentoOS 参照（/tmp/ventoos-ref 只读）：handleNavigate（L2511）对文件与目录均做 `selected` + 列栈 slice —— 单击文件同样高亮该文件并把列栈截断到文件所在列，路径栏/目录树跟随所点文件的父级链。我方 M2.7 时期「单击文件不改变列高亮」的旧设计与 VentoOS 及用户预期相悖，按用户新标准修正。
- 渲染层无需改动：`is-current`（选中文件，accent 底+白字）/ `is-ancestor`（选中目录的祖先）/ `is-multi` 样式与类逻辑本就齐备，纯 navigate 文件分支未设状态所致。
- 路径栏 `.vd-fm-pathbar` 纯由列栈名称派生（`segments = cols.slice(1).map(c => c.name)`）→ 列栈截断修复后路径栏陈旧问题自动消除。

**代码改动**（仅 `ColumnView.tsx`，4 处 = 1 个函数分支 + 3 处注释）：
- `navigate` 文件分支：新增 `setCols(prev => prev.slice(0, colIdx+1) 并将该列 selected 置为 entry 名)`；`setPreviewEntry(entry)` 上提至函数首行供目录/文件两分支共用；附 M2.12 对齐 VentoOS 的注释。
- JSDoc、onItemClick 普通单击分支注释、selectedEntries 锚点兜底注释同步更新为：文件 → 高亮自身 + 截断列栈 + 预览面板。
- 渲染层/CSS、双击、键盘、橡皮筋、右键菜单逻辑均未改动。

**测试更新**（原断言固守 M2.12 前旧行为，按新行为改写、断言数量不变）：
- `/tmp/pw-check/check8.mjs`（13 项）：sample.docx 单击断言「未改变列选中态」→「高亮该文件(is-current, data-fm-entry=sample.docx)」；保留预览面板出现、不打开文件窗口两项。
- `/tmp/pw-check/check11.mjs`（47 项）：① 单击 e2e-viewer.md 断言 → 高亮(is-current)；② Ctrl 多选前的复位步骤原为普通单击 md（新行为下 md 会被高亮导致 stale=1）→ 改为路径栏**根按钮**复位（清 selected/多选/锚点）+ 重新进入 预览测试 列。注意：末位路径段为 is-last、点击无操作，不可用作复位手段。
- check9/10/12 无文件选中断言，未受影响。断言计数保持 13/47，基线 177 不变。
- 新增复现探针 `/tmp/pw-check/probe-fmselect-m212.mjs`（17 项）：深文件选中→浅文件截断→中间层路径栏三段验证 + 截图留证。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| 复现探针（新增） | `node /tmp/pw-check/probe-fmselect-m212.mjs` | 17/17：深文件 e2e-viewer.md 单击 → is-current + 预览面板、列数不变；根级浅文件 outside-1792822558.csv 单击 → is-current + 列栈截断 1 列 + 路径栏无深层段 + 预览切换 + 无残留祖先高亮；中间层 2 列 + 路径栏仅剩 预览测试 段；m212-deep-selected / m212-shallow-selected / m212-mid-selected 三张截图留证 |
| 全量回归 | check8–12（浅色）→ `settheme dark` → check7 → 还原浅色 | check8 13/13、check9 37/37、check10 16/16、check11 47/47、check12 33/33；深色环境 check7 **31/31**；`probe-lightwin-m211` 6/6（M2.11 玻璃 tint 不受影响） |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep [dbg` | 1998296 / 2168184 / 75941（合计 4242421）精确匹配基线，`[dbg` 零残留 |
| 设置还原 | `node /tmp/pw-check/getsettings.mjs`（鉴权 GET） | `{"accent_color":null,"theme_mode":"light","wallpaper":"/wallpapers/light-beach.jpg"}` 与用户原设置一致 |

**环境**：app `http://127.0.0.1:8080`（admin / Admin@12345）；服务端 `./target/debug/vento` pid **575882**（日志 /tmp/vento-server.log）；部署资产 `index-jfsu9ZwW.js`（`include_dir!` 编译期嵌入）。

**结论**：M2.12 完成——文件管理器单击文件对齐 VentoOS 行为：高亮该文件（is-current）、列栈截断至文件所在列、路径栏/预览面板随之跟随；选中长路径文件后再点短路径文件，该文件立即被选中、视图收起至其父级链。改动集中在 navigate 文件分支一个函数 + 注释，渲染层/CSS 零改动；复现探针 17/17 + 全量回归 177 项全绿（check7 深色 31/31），editor-dist 字节锁未动（4242421B），用户设置已还原并 GET 校验。
### 2026-10-28 (UTC+8) M2.13 文件管理器 UI 微调（移除列头层 + 预览 meta 加 padding）

**任务**：用户反馈（原文）：「1. vd-fm-col-head 这一层不需要 2. vd-fm-preview-meta 应该和body一样加一点padding」。

**代码改动**（2 个文件，纯 UI）：
- `web/src/apps/files/components/ColumnView.tsx`：删除每列顶部的 `<div class="vd-fm-col-head">{col.name}</div>`（列名已由顶部路径栏面包屑呈现，属冗余）。
- `web/src/assets/styles/app.css`：
  - 删除 `.vd-fm-col-head` 样式块（无其他引用）。
  - `.vd-fm-preview-meta`：原 `margin-bottom: 10px` 且无 padding（文字贴面板左边缘）→ 改为 `padding: 12px 12px 0`，与 `.vd-fm-preview-body`（padding: 12px）水平对齐；meta 与 body 间距由 body 的 padding-top(12px) 承担。
- 无逻辑改动；测试未引用 `.vd-fm-col-head`，断言数不变。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| UI 探针（新增） | `node /tmp/pw-check/probe-ui-m213.mjs` | 6/6：col-head count=0；预览面板 meta 计算样式 padding 12px/12px/0/12px，与 body 左 padding 一致；无 JS 错误；截图 m213-fm-preview.png |
| 全量回归（浅色） | check8–12 | 13/13、37/37、16/16、47/47、33/33 全绿 |
| 全量回归（深色） | `settheme dark` → check7 → 还原 | 31/31 全绿 |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep [dbg` | 合计 4242421 精确匹配，零 `[dbg` |
| 设置还原 | `node /tmp/pw-check/getsettings.mjs` | `{"accent_color":null,"theme_mode":"light","wallpaper":"/wallpapers/light-beach.jpg"}` 一致 |

**环境**：app `http://127.0.0.1:8080`；服务端 `./target/debug/vento`（重启后新 pid，日志 /tmp/vento-server.log）；部署资产 `index-Cr9rDSky.js`（`include_dir!` 编译期嵌入，已确认 HTTP 200）。

**结论**：M2.13 完成——文件管理器移除每列列头层（更紧凑，路径栏已承担导航信息），预览面板 meta 区与 body 同样加 12px padding 不再贴边。探针 6/6 + 全量回归 177 项全绿，editor-dist 字节锁未动，用户设置已还原并 GET 校验。
### 2026-10-28 (UTC+8) M2.14 文件管理器右侧预览支持 mp3/mp4/wav/webm/pdf 等媒体

**任务**：用户反馈（原文）：「3. mp3 mp4 wav webm pdf 等等常见文件都应该可以在右侧预览」。

**代码改动**（2 个文件）：
- `web/src/apps/files/components/FileInfoPanel.tsx`：
  - 新增 `MEDIA_PREVIEW_CAP = 1GB`（pdf/video/audio 整文件抓取上限，防大文件全量进内存）。
  - 新增 `isPdf/isVideo/isAudio/isMedia`（复用 FileViewer 的 `classifyFile`：mp4/webm/ogv/mov…→video，mp3/wav/ogg/flac/weba…→audio，pdf→pdf）。
  - 新增媒体预览 effect：`GET /api/v1/files/:id/content`（Bearer）整文件 → `URL.createObjectURL` → 渲染原生组件；变更/卸载 abort + revoke；超限提示「文件过大，无法预览」，失败提示「媒体加载失败」，加载中 Spin。
  - 渲染分支：pdf → `<iframe src=blob#toolbar=1&navpanes=0 class=vd-fm-preview-pdf>`；video → `<video controls class=vd-fm-preview-video>`；audio → `<audio controls class=vd-fm-preview-audio>`。图片/文本/二进制分支不变。
- `web/src/assets/styles/app.css`：新增 `.vd-fm-preview-pdf`（100% 宽高、min-height 400px、无边框）、`.vd-fm-preview-video`（width 100%、max-height 100%、黑底圆角）、`.vd-fm-preview-audio`（width 100%）。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| 媒体探针（新增） | `node /tmp/pw-check/probe-media-m214.mjs` | 12/12：真实 WAV `<audio>` readyState>=2（真实解码）；真实 PDF `<iframe>` blob src；最小合法 MP3（3 静音帧）可解码 readyState>=2；mp4/webm 占位文件均渲染 `<video controls>` blob src；md 仍为文本 pre 回归；m14 种子文件已清理；无 JS 错误 |
| 全量回归（浅色） | check8–12 | 13/13、37/37、16/16、47/47、33/33 全绿 |
| 全量回归（深色） | `settheme dark` → check7 → 还原 | 31/31 全绿 |
| editor-dist 字节锁 | `wc -c` 三文件 + `grep [dbg` | 合计 4242421 精确匹配，零 `[dbg` |
| 设置还原 | `node /tmp/pw-check/getsettings.mjs` | `{"accent_color":null,"theme_mode":"light","wallpaper":"/wallpapers/light-beach.jpg"}` 一致 |

**环境**：app `http://127.0.0.1:8080`；服务端 `./target/debug/vento`（新 pid，日志 /tmp/vento-server.log）；部署资产 `index-CHpP36rS.js`（HTTP 200 确认）。

**坑**：
- 回收站为软删除，`DELETE /api/v1/files/:id` 后名字被占用，重传同名 409；需再 `DELETE /api/v1/files/:id/purge`（注意不是 `/trash/files/:id/purge`，后者 405）。
- 单帧 MP3（417B）Chromium 报 MEDIA_ERR_SRC_NOT_SUPPORTED（error 4）；3 帧拼接（1251B）可正常解码（readyState 4，duration 0.078s）。
- 原 e2e-viewer.mp3/mp4/wav/webm 是 91 字节 JSON 错误占位文件（`{"error":{"c…`），非真实媒体，只用于验证元素渲染。

**结论**：M2.14 完成——文件管理器右侧预览面板现支持 pdf（内嵌查看器）、video（mp4/webm 等，原生播放器）、audio（mp3/wav/webm 等，原生播放器），1GB 上限防大文件。探针 12/12（含真实 WAV/MP3 解码验证 + 真实 PDF 渲染）+ 全量回归 177 项全绿，editor-dist 字节锁未动，用户设置已还原并 GET 校验。
### 2026-10-28 (UTC+8) M2.15 zip 文件包内文件列表预览（Windows 风格）

**任务**：用户反馈（原文）：「1. zip文件打开应该是预览zip里的文件 然后双击zip里的文件可以打开 和windows体验一致」。

**实现**：
服务端（`crates/vk-api/src/files.rs` + `lib.rs`，zip 2.6.1，只读内联、不解压落盘）：
- `GET /api/v1/files/{id}/zip`：返回 `{name,size,entry_count,entries:[{name,size,is_dir,modified}]}`，`name` 为 zip 内完整相对路径（如 `docs/说明.txt`）。
- `GET /api/v1/files/{id}/zip-entry?path=<rel>`：取包内文件二进制（octet-stream，`content-disposition: inline; filename*=UTF-8''<basename>`）。
- 上限：单 zip ≤512MB、单条目 ≤128MB、≤100000 条目。
- 错误：路径不存在/目录路径无尾斜杠 → 404 NOT_FOUND「压缩包内不存在该文件」；路径穿越（`../`）→ 400 BAD_REQUEST「无效的压缩包内文件路径」；未登录 401。

客户端（5 文件）：
- `web/src/lib/zipEntry.ts`：虚拟文件 ID `zip:<zipFileId>@<encodeURIComponent(entryPath)>`，encode/parse 成对。
- `web/src/api/index.ts`：`fetchFileContent` 识别虚拟 ID 路由到 `/zip-entry?path=`。
- `web/src/api/schema.ts`：`ZipListOut`/`ZipEntryOut` 类型（OpenAPIs map 全覆盖）。
- `web/src/apps/file/[id].tsx`：zipRef 分支 → `ZipView`；包内 office 格式 → 居中提示不支持（DocEditor 无法加载虚拟 ID）。
- `web/src/apps/file/components/ZipView.tsx`（新增）：Windows 资源管理器式列表——行显 basename（title=完整路径）、单击=选中+省略号截断、双击目录=钻取、双击文件=新文件窗口打开（虚拟 ID）、Enter=打开选中项、面包屑可点击返回、目录行尾「N 项」、页脚「压缩包 · 大小」（包内条目窗口页脚「压缩包条目 · 大小」）。
- `web/src/assets/styles/app.css`：`.vd-zip*` 样式块。

**本轮修复的 bug**（e2e-viewer.zip 由 python zipfile 生成、无显式 `notes/` 目录条目，导致目录行缺失、子目录不可达）：
- 隐式父目录自动合成：`ZipView.children` 从所有文件路径祖先合成目录行（与已有目录条目去重）。
- 钻取路径：条目名即完整相对路径，改 `setDirPath(e.name)`（旧实现 `dirPath+'/'+name` 对嵌套目录双重前缀）。
- `dirCounts` 键：改用完整目录路径 `e.name` 直取。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| zip 探针（新增） | `node /tmp/pw-check/probe-zip-m215.mjs` | 17/17：根条目恰为 docs/image.png/notes.md/readme.txt/sound.mp3、目录行「1 项」、钻取 basename、CJK 内容正确、面包屑、图片渲染、无 JS 错误 |
| 全量 viewer 套件（重写） | `node /tmp/pw-check/check9.mjs` | 39/39：hex 步骤→zip 步骤（列表/页脚/合成目录钻取/双击 hello.txt 新窗口内容），其余 27 项不变全绿 |
| 全量回归 | check8/10/11/12 | 13/13、16/16、47/47、33/33 全绿（对新编译 dist） |
| check7 | `node /tmp/pw-check/check7.mjs` | 30/31：唯一失败=「默认深色主题」——服务端默认自 10-25 起即 theme_mode=light，该断言依赖 admin 持久化主题（当前为用户真实偏好 light），环境因素非回归 |
| editor-dist 字节锁 | `stat -c%s` 三文件 + `grep [dbg` | 1998296+2168184+75941=4242421 精确匹配，零 `[dbg` |
| 设置还原 | `node /tmp/pw-check/getsettings.mjs` | `{"accent_color":null,"theme_mode":"light","wallpaper":"/wallpapers/light-beach.jpg"}` 一致（验证期间曾临时重置为 null 后已还原） |

**环境**：app `http://127.0.0.1:8080`；服务端 `./target/debug/vento` pid 729269（重新编译后重启，日志 /tmp/vento-server.log）；部署资产 `pages-mOF23w6D.js`（已确认新 chunk hash 嵌入二进制）。

**坑**：
- zip 可能不含显式目录条目（python zipfile `writestr` 不写 `notes/` 条目）→ 客户端必须合成隐式父目录行，否则子目录不可见、不可达。
- `entries[].name` 为 zip 内完整相对路径，钻取用 `setDirPath(e.name)`；与当前目录拼接会双重前缀。
- zip-entry：目录路径无尾斜杠 → 404（非 400）；仅路径穿越返回 400。
- web 改动后必须重编二进制（`include_dir!` 编译期嵌入）；`cargo` 在 `~/.cargo/bin/cargo`（不在 PATH）；以二进制内 grep 新 chunk hash 验证嵌入。
- check9 基线 37→39 断言（hex 2 项 → zip 4 项）。
### 2026-10-28 (UTC+8) M2.16 审计日志详情改用 drawer 打开（修复无法返回）

**任务**：用户反馈（原文）：「2. 审计日志点击详情后无法返回 详情应该用drawer打开」。

**根因**：原实现里「查看」把详情块内联渲染在筛选栏与表格之间，把列表往下推、窗口内布局被挤乱，用户找不到关闭入口/回不去列表。

**代码改动**（1 个文件）：
- `web/src/apps/audits.tsx`：
  - 删除内联详情块（原 `{detail ? <div ...>详情·JSON</div> : null}` 段落）。
  - 复用现有通用 `Drawer` 组件（`web/src/components/ui/kit.tsx`，与版本历史/团队抽屉同款：fixed 右侧滑入、遮罩、Esc 关闭、✕ 按钮）渲染详情：标题「审计日志详情」+ 结构化字段表（时间/操作人/类别 Tag/操作/资源/IP）+ 详情数据 JSON `<pre>`（`--vd-bg-input` 底、max-height 360 滚动）。
  - 导入调整：`lucide-react` 去掉 `X` 加 `History`；kit 导入去掉 `IconBtn` 加 `Drawer`。
  - 关闭方式三通道：✕ 按钮、Esc、点遮罩（Drawer 组件自带），关闭后回到原列表、筛选/分页状态不变（state 未动）。

**验证命令与结果**：
| 验证 | 命令 | 结果 |
|---|---|---|
| drawer 探针（新增） | `node /tmp/pw-check/check13.mjs` | 21/21：查看→drawer 出现、标题「审计日志详情」、六字段齐全、操作列与首行一致（释放编辑锁）、JSON pre 为合法 JSON、Esc 关闭后列表仍在、遮罩点击关闭、✕ 关闭、无 JS 错误 |
| 全量回归 | check7/8/9/10/11/12 | check7 30/31（唯一失败=「默认深色主题」，环境因素见 M2.15 条目）、check8 13/13、check9 39/39、check10 16/16、check11 47/47、check12 33/33 全绿 |
| editor-dist 字节锁 | `stat -c%s` 三文件 | 1998296+2168184+75941=4242421 精确，零 `[dbg` |
| 设置状态 | `node /tmp/pw-check/getsettings.mjs` | `{"accent_color":null,"theme_mode":"light","wallpaper":"/wallpapers/light-beach.jpg"}` 未改动 |

**环境**：app `http://127.0.0.1:8080`；服务端 `./target/debug/vento` pid 750879（重新编译后重启，日志 /tmp/vento-server.log）；部署资产 `pages-ryLu3iO8.js`（新 chunk hash 已确认嵌入二进制，旧 `pages-mOF23w6D.js` 计数 0）。

**坑**：
- editor-dist 三文件在仓库根 `editor-dist/` 下，不在 `web/` 下。
- check13 初版误用 Puppeteer 的 `locator.scrollHeight()`（Playwright 无此 API）；改用 innerText 断言 JSON 前后花括号。
- Playwright 的 `check$c.mjs` 循环里 `c` 不能写成 `$c` 被 shell 二次展开，直接 `for c in 7 8 9 10 11 12; do node check$c.mjs; done` 即可（单引号 heredoc 内无此问题）。
