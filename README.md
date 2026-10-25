# VentoDocs（智能文档管理平台）

自部署 Web 文档管理系统：文件管理、Office 在线编辑、目录级权限、文件分享、目录网站发布、检索与 Agent 智能体。

## 当前范围（v1）

- P0：文件管理核心（目录/文件 CRUD、上传下载、预览、ACL、锁定、版本、回收站、审计、用户管理）
- P1：ranuts/document 在线 Office 编辑（docx/xlsx/csv/pptx 可编辑，xls/xlsm/ods/doc/odt/rtf/ppt 只读）、文件分享、目录网站发布

v2（另行排期）：zvec-grep 全文/向量检索、文档页 Agent、全应用 RAG Agent。架构设计已预留（见 `docs/01-architecture.md` §12/§13）。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Rust（axum + sqlx + tokio），单一二进制，前端编译期内嵌 |
| 数据库 | PostgreSQL 16（目录树/元数据/ACL/版本/锁/分享/发布/审计） |
| 缓存/队列 | Redis 7 |
| 在线编辑 | ranuts/document（AGPL-3.0，纯前端静态资源 + 同源 iframe，见「在线编辑器许可证」） |
| 前端 | Vite + React 19 + TypeScript + antd 5 + UnoCSS（fe-init / fe-coding 规范） |
| 存储 | 本地磁盘对象存储（内容寻址），接口预留 S3 扩展 |

## 文档

- `docs/01-architecture.md` — 架构设计（数据模型、权限、存储、部署）
- `docs/02-ui-design.md` — UI 设计基线（视觉 Token、页面、交互）
- `docs/03-conventions.md` — 项目规范（Rust / API / 前端 / 数据库 / Git / 安全）
- `docs/04-poc-milestones.md` — POC 验证项、里程碑与风险
- `docs/05-deployment.md` — 部署文档（实施期产出）

## 快速开始（开发）

```bash
# 1. 启动依赖（PostgreSQL + Redis）
docker compose up -d pg redis

# 2. 配置
cp .env.example .env   # 按需修改（JWT secret 等）

# 3. 后端
cargo run -p vk-app          # 默认 http://127.0.0.1:8080
# 首次访问：无用户时 /api/v1/bootstrap 可创建管理员（创建后永久关闭）

# 4. 前端
cd web && pnpm install && pnpm dev   # http://127.0.0.1:5173，代理 /api 到 8080
```

## 构建与部署

```bash
# 在线编辑器静态资源（首次或升级时执行，约 460MB，需 Docker）
bash scripts/fetch-editor.sh

make build      # 前端 dist + release 二进制（前端内嵌）
docker build -t vento:latest .
docker compose -f compose.prod.yml up -d
```

详见 `docs/05-deployment.md`（实施期产出）。

## 在线编辑器许可证

在线 Office 编辑由 [ranuts/document](https://github.com/ranuts/document)（edit.chaxus.com，AGPL-3.0，基于 OnlyOffice Docs 构建）提供。本仓库**不包含其源码**：`scripts/fetch-editor.sh` 拉取其官方预构建镜像中的静态资源（`/public`，约 460MB）并放入 `editor-dist/`（已 gitignore）。运行时该编辑器以独立同源 iframe 文档运行，VentoDocs 前端不与其代码混合，亦不修改其产物。

部署方运行包含该组件的系统，AGPL-3.0 的源码披露等义务由部署方按许可证条款承担；生产对外部署前请评估自身分发形态与 AGPL-3.0 的合规要求。
