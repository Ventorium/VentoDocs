# VentoOS → VentoDocs 借鉴映射方案（待确认）

调研对象：`/tmp/ventoos-ref`（VentoOS，175MB，last commit a86da0a）。
两份深度调研报告（桌面层 / 文件管理+查看编辑）已于 2026-10-25 完成，本文档是综合后的实施方案。

## 0. 架构结论（30 秒版）

- VentoOS 前端是**纯网页 SPA 实现的桌面**：窗口 = 页面内绝对定位 div（zustand window store），**无 Tauri/Electron、无 IPC**，所有文件/设置操作都是普通 HTTP REST。
- 设置持久化本来就是 HTTP：zustand store → 500ms 防抖 → `PUT /api/settings/desktop` 全量对象；无 localStorage。对 VentoDocs（React19+antd6+axum+PG）是 **1:1 可移植**。
- office-editor 用的 ranuts 包与 VentoDocs **完全同版本**（0.1.0-alpha-23 / ranui 0.1.10-alpha-27），其接线方式（x2t 父侧转换 → postMessage → iframe DocsAPI）可对照学习。
- 注意：VentoOS 设计文档（docs/design/05 等）与代码脱节，实现以代码为准。

## 1. 系统背景（壁纸）

借鉴：
- 3 类壁纸源：内置 6 张 jpg（`web/public/wallpapers/`，共 ~1.7MB，dark-mountain/light-field/light-sunset/dark-aurora/light-beach/dark-ocean）、渐变字符串（`linear-gradient(...)` 直接存）、Bing 每日壁纸（reqwest 代理 + 按天缓存，**依赖外网，私有部署默认关闭**）。
- 渲染：单层 `background-image` + 渐变 fallback（`shell/Desktop/index.tsx:42-54`），`bg-cover bg-center`。
- 持久化：`GET/PUT /api/settings/desktop`（KV 表，partial merge + 默认值填充）→ VentoDocs 改为 PG `settings(key,value)` 表 + `/api/v1/settings/desktop`。

工作量：中（后端 ~1 天 + 前端背景层 0.5 天）
风险：用户环境有「加载不了」前科 → backdrop-filter 性能需先在受控环境（Playwright + 用户同款浏览器）验证。

## 2. 概念（设计语言）

借鉴：
- 三层材质：Desktop Material / Surface Material / Overlay Material，blur 刻度 12/32/48 随层递增。
- 完整 token 值（`web/src/theme.ts` 173L，可直接抄）：
  - 圆角：window 12 / panel 10 / control 8 / button 6
  - 模糊：desktop 12 / surface 32 / overlay 48
  - 阴影：window `0 8px 40px rgba(0,0,0,0.22)`；聚焦 `0 24px 72px rgba(0,0,0,0.35)`
  - 间距：base 8 / sm 8 / md 16 / lg 24 / xl 32 / xxl 48
  - 动效：窗口开 0.22s `[0.32,0.72,0,1]`；关 0.18s；面板 0.2s；右键菜单 0.12s
  - 色彩（浅色玻璃底）：surface rgba(255,255,255,0.72) / window rgba(248,248,250,0.68)；文字 #1d1d1f；强调 #007AFF（VentoDocs 可保持 #2563EB）
- 交互原则：少跳转、所见即所得、危险操作分级、耗时操作可感知、可撤销优先。

落地：VentoDocs `web/src/theme.ts` 扩展 + `--vd-*` CSS 变量 + antd ConfigProvider（colorPrimary/borderRadius/darkAlgorithm），避免与 antd 内置 token 混用。

工作量：低-中（约 2 天，含暗色模式视觉回归）。

## 3. 桌面设置

借鉴：
- 外观区：主题三态卡（auto/light/dark，auto 监听 `prefers-color-scheme`）、9 个强调色圆块、壁纸缩略图网格（3 列、高 64px、hover scale）。
- 设置 UI 基元：`settings-group / card / chip / slider / toggle`（`apps/settings/index.tsx:80-204` + `assets/styles/app.css:840-968`）。
- 简化：不做 Dock（VentoDocs 无 Dock）、锁屏、声音、快捷键自定义（VentoOS 自己也没实现完）。
- **超越 VentoOS 一项**：壁纸支持从自己文件库选图（复用 `/api/v1/files` 上传）——VentoOS 只有内置图+Bing，无本地上传。

后端：`GET/PUT /api/v1/settings/desktop`（PG KV 表，partial merge + 默认值），前端 zustand store + 500ms 防抖原样移植（VentoDocs 已有类似 fetch 层则复用）。

工作量：中（2-3 天）。

## 4. 文件资源管理

VentoOS explorer = 4485 行单文件（列视图 Finder 风格 + 橡皮筋多选 + DnD + 右键菜单 + 右侧信息面板 + 内联重命名）。

借鉴（按性价比排序）：

| # | 项 | 说明 | 工作量 |
|---|---|---|---|
| ① | 右键菜单 | 重命名/删除/复制路径/上传到此目录（antd Dropdown） | 0.5-1 天 |
| ② | 内联重命名 | F2/Enter 确认/Escape 取消，自动选中不含扩展名部分 | 0.5 天 |
| ③ | 面包屑路径栏 | 可点击面包屑 + 后退按钮 | 0.5-1 天 |
| ④ | 右侧信息/预览面板 | 280px：名称/大小/修改时间 + 图片(objectURL)/文本/JSON 预览，截断提示「仅预览前 1MB」 | 1-2 天 |
| ⑤ | 拖拽上传 | 外部 OS 文件 drop 到指定目录（HTML5 DnD） | 2-3 天 |
| ⑥ | 目录间拖拽移动 | 需后端 move API（现有 rename 可扩展），drop 防环检查 | 2-3 天 |
| ⑦ | 多选 | Shift/Ctrl+点击或橡皮筋框选（antd Table rowSelection 扩展） | 2 天 |
| ⑧ | 列视图 | 桌面感核心，220px 列 + 列内选中；成本最高：放弃 antd Table 虚拟滚动/密度，RBAC 权限点重挂 | 5 天+，可选 |

不借鉴：多挂载点 VFS / FUSE / 终端 / WebDAV（VentoDocs 单存储架构）；压缩/解压（可后续单独立项）。

## 5. 文件查看与编辑

查看侧借鉴（file-viewer 675L）：
- 图片缩放/平移查看器（wheel 0.1-10x + 拖拽平移 + 双击复位 + 百分比角标）
- 自绘视频/音频播放器（进度/音量/倍速，无第三方库）
- Markdown 渲染（`@ant-design/x-markdown`）
- 二进制 hex dump（前 4KB）、文本「仅预览前 4MB」截断提示

工作量：低-中（2-3 天）。

编辑侧：
- VentoOS 用**同版本 ranuts**，方案为「父侧 x2t.wasm 转换 → postMessage `{type:'openDocument', payload:{bin, media}}` → iframe 内 DocsAPI `asc_openDocument`」。VentoDocs 现有同源 `/document` + `document:open-buffer` 方案等价且**保存带版本控制**（base_version + 409 冲突弹窗）——这是 VentoOS 的明确短板（它直接覆盖写），**必须保留 VentoDocs 现有方案**。
- 可借鉴的细节：postMessage token 配对消息名模式（`iframeReady→editorReady→documentReady`，保存 `saveDocument`，出错 `editorError{error}`，卸载 `destroy` + revoke objectURL）；转换完成后延迟 200ms 再 post（等 WASM 就绪）。
- 已知 VentoOS 缺陷不抄：readOnly 未真正接进 DocsAPI（恒 edit:true）；错误只有一个字符串无分类。

工作量：低（消息协议打磨 0.5-1 天）。

## 6. 建议实施分期

| 期 | 内容 | 工作量 |
|---|---|---|
| P1 地基 ✅ | theme token + `--vd-*` 变量 + 暗色模式 + `GET/PUT /api/v1/settings/desktop`（PG KV） | 2-3 天（2026-10-25 完成，Chromium 回归 0 报错） |
| P2 桌面感 | UserLayout 壁纸层（渐变 fallback）+ `/app/settings` 设置页（外观/壁纸，含从文件库选图） | 2-3 天 |
| P3 文件管理基础 | ①右键菜单 ②内联重命名 ③面包屑 ④右侧预览面板 | 3-5 天 |
| P4 文件管理进阶 | ⑤拖拽上传 ⑥拖拽移动 ⑦多选 | 5-7 天 |
| P5 查看增强 | 图片缩放查看器 / 自绘媒体播放器 / MD / hex | 2-3 天 |
| (选) | ⑧列视图 | 另评估 |

依赖新增：zustand（剪贴板/默认打开，小库）、`@ant-design/x-markdown`（MD 预览）。其余用现有 antd 6。

## 7. 风险

1. antd 暗色切换需把现有写死颜色（#F7F8FA、白卡片）全部改成变量 → 一轮视觉回归。
2. 用户环境性能前科：壁纸 + backdrop-filter 属新增开销，先在受控环境验证帧率。
3. 内置壁纸 1.7MB 经 `include_dir!` 进二进制（可接受；可转 webp 减到 ~500KB）。
4. ⑧列视图风险最高，建议 P1-P5 验收后再决定。
