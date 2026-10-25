# VentoDocs 项目规范

> 适用范围：本仓库全部代码。与 `docs/01-architecture.md` 配套；冲突时以架构文档的决策为准。

## 1. 仓库结构

```
VentoDocs/
├── Cargo.toml                  # workspace（edition 2024）
├── rust-toolchain.toml         # stable
├── .gitignore
├── Makefile                    # dev/test/build/deploy 快捷命令
├── docker-compose.yml          # 开发用 postgres:16 + redis:7
├── Dockerfile                  # 生产镜像（多阶段：node 构建前端 → rust 构建 → slim 运行）
├── crates/
│   ├── vk-core/                # 领域核心：实体、权限引擎、ID 生成、错误类型（零 I/O）
│   ├── vk-store/               # sqlx + PG：migrations/、repositories/、object_store/
│   ├── vk-search/              # v2：SearchProvider trait + zvec-grep 实现
│   ├── vk-agent/               # v2：LLM 客户端 + RAG
│   ├── vk-api/                 # axum 路由、中间件、SSE
│   └── vk-app/                 # 二进制入口：配置加载、静态资源内嵌、后台任务
├── web/                        # 前端（fe-init 生成，fe-coding 规范）
└── docs/                       # 01 架构 / 02 UI / 03 规范 / 04 POC 里程碑 / 05 部署
```

## 2. Rust 规范

- **工具链**：stable（rust-toolchain.toml 锁定），edition 2024。
- **质量门**：`cargo clippy --all-targets --all-features -- -D warnings` 必须通过；`cargo fmt --check` 必须通过。
- **错误处理**：库 crate（vk-core/vk-store 等）用 `thiserror` 定义具体错误类型；vk-app 顶层用 `anyhow` 组合。禁止 `unwrap()`/`expect()`（测试除外）；禁止裸 `panic!`。
- **异步**：axum + tokio 多路复用；阻塞 I/O（文件读写）走 `tokio::fs` 或 `spawn_blocking`；禁止在异步任务里同步 `std::fs`。
- **数据库**：sqlx，连接池默认 max 20；事务内完成"锁复查 + 版本自增 + 版本行插入"，提交后才落对象/触发索引。SQL 用 `sqlx::query!` 编译期检查或 `query_as` + 显式列名，禁止字符串拼接。
- **时间**：一律 UTC `chrono::DateTime<Utc>` 存储；展示层转本地。
- **日志**：`tracing` + `tracing-subscriber`（生产 JSON，开发 pretty）；关键路径（鉴权失败、锁冲突、版本冲突）必须 `warn!` 带 file_id/actor。
- **命名**：模块 `snake_case`，类型 `CamelCase`，常量 `SCREAMING_SNAKE`；API 路由函数 `<action>_<resource>`。
- **测试**：vk-core 权限引擎必须有单元测试覆盖继承/并集/管理员旁路/锁冲突矩阵；vk-store 集成测试用 `docker compose up pg` 的实例（`VIENTO_TEST_DB_URL`）。
- **依赖**：新增依赖需在 PR 描述说明理由；优先选活跃维护、无重依赖的 crate。

## 3. API 规范

- 前缀 `/api/v1`；JSON（`application/json; charset=utf-8`）。
- 鉴权：`Authorization: Bearer <jwt>`；公开接口（登录、bootstrap、分享访问、发布站点）显式标注。
- 错误格式（RFC 9457 problem+json 简化）：
  ```json
  { "error": { "code": "FILE_LOCKED", "message": "文件已被 张三 锁定", "details": {} } }
  ```
- 核心错误码：`UNAUTHENTICATED` `FORBIDDEN` `NOT_FOUND` `FILE_LOCKED` `VERSION_CONFLICT` `UPLOAD_TOO_LARGE` `SHARE_EXPIRED` `SHARE_REVOKED` `PUBLISH_DISABLED` `CONFLICT`。
- HTTP 状态：401 未认证；403 无权限；404 不存在或无读权（不泄露存在性）；409 锁/版本/重名冲突；413 超限；410 发布已关闭。
- 分页：`?cursor=<opaque>&limit=`（默认 50，上限 200）；返回 `{ items, next_cursor }`。
- 上传：`POST /files` multipart 流式；返回前流式算 sha256。
- 下载/预览：`GET /files/:id/content?purpose=download|preview`，逐请求鉴权。

## 4. 前端规范（fe-coding 固化）

### 4.1 初始化（fe-init 已执行，不得重做）

- pnpm + Vite + react-swc-ts；`engines.node >= 20.19.0`。
- 依赖基线：ahooks clsx dayjs react-router react-router-dom tailwind-merge zustand；dev：unocss @unocss/reset vite-plugin-pages vite-plugin-svgr。
- UI：antd 5 + @ant-design/icons + lucide-react；Agent 面板（v2）用 @ant-design/x。
- `tsconfig.app.json`：`types: ["vite/client","vite-plugin-pages/client-react","vite-plugin-svgr/client"]`，`paths: {"@/*": ["./src/*"]}`。
- `build: "tsc -b && vite build"`；biome 由 package.json script 驱动（无 eslint.config.js）。

### 4.2 目录与文件约定（硬性）

- 必备目录：`src/{api,assets,components,hooks,layouts,lib,pages,auth,app,store}`。
- 组件：`src/components/Xxx/index.tsx`（子文件同目录）；一个文件默认一个组件，≥3 个独立子组件才拆分。
- hooks：`src/hooks/useXxx.ts`；≥2 个调用点的逻辑必须抽 hook。
- 类型：`src/api/types.ts`；API 请求与类型集中在 `src/api/schema.ts`；接口定义**不使用 `type` 关键字**（用 `interface`）。
- 页面：`src/pages/**/index.tsx` 默认导出；vite-plugin-pages 文件路由。
- 样式：UnoCSS 原子类为主；**禁止** `.css`/`.module.css`，仅允许 CSS 变量方式处理动画、复杂布局、动态值、暗色、响应式；禁止 UnoCSS 任意值（`[--var]` 形式）。
- 状态：zustand store 放 `src/store/`；跨页状态才进 store，页面内状态用 useState/useMemo。
- 下载：统一走 `file-saver`。
- 2 行以内的函数直接内联；禁止过度抽象。
- 注释：中文、简洁，只解释"为什么"。
- **禁止 emoji**（UI 文案与代码注释均用图标组件）。
- 每次功能完成后更新 `CLAUDE.md` 与 `AGENTS.md`。

### 4.3 交互与状态（与 docs/02-ui-design.md 一致）

- 设计 Token：主色 `#2563EB`、页面背景 `#F7F8FA`、卡片白；经 antd ConfigProvider + CSS 变量落地。
- 五类必做状态：加载 / 空 / 错误 / 无权限 / 锁定。
- 危险操作（删除、永久删除、改权限、撤销分享）一律 antd 确认弹窗。
- 编辑器与 AI 面板独立适配；窄屏右侧面板转 Drawer。

## 5. 数据库规范

- 表/列 snake_case；主键 UUIDv7（`uuidv7` crate）；外键显式声明。
- 所有表带 `created_at timestamptz NOT NULL DEFAULT now()`；可变表带 `updated_at`。
- 迁移：sqlx migrate，文件 `crates/vk-store/migrations/NNNN_描述.sql`，只增不改（改 schema 走新迁移）。
- 索引：`directories(path)`、`grants(directory_id)`、`grants(principal_id)`、`file_versions(file_id, version)`、`shares(token)`、`published_dirs(publish_id)`、`audit_logs(ts)`。
- 删除策略：文件/目录软删除（`deleted_at`）；`file_versions` 随文件级联；对象文件物理删除仅在无引用时（后台任务）。

## 6. Git 与提交

- Conventional Commits：`feat|fix|refactor|chore|docs|test|build|perf` + 范围（api/store/ui/core/search）+ 中文描述。
- 分支：`main` 可发布；开发走 `feat/<scope>-<desc>`。
- 提交粒度：一个可独立验证的功能/修复；禁止混合"重构 + 新功能"。
- 每个里程碑结束前必须：`cargo test`、`pnpm -C web build`、`docker compose up` 冒烟全绿。

## 7. 安全规范

- 密钥（JWT secret、LLM key、LDAP 凭据、DB/Redis 连接串）只从环境变量/挂载 secret 读取；仓库内禁止出现任何真实密钥。
- 密码 argon2id（memory 64MiB, iterations 3, parallelism 4）。
- 分享 token / 发布 ID / UUID 一律 `rand::thread_rng()` CSPRNG；发布 ID 字符集去 `0/o/1/i/l`。
- 上传：MIME 白名单（扩展名 + magic bytes 双重校验）、大小上限、文件名清洗（去 `..`/控制字符）。
- 响应头：`X-Content-Type-Options: nosniff`、发布站点 `Cache-Control` 显式控制。
- 审计：所有写操作 + 分享访问 + 认证事件落 `audit_logs`（同事务）。

## 8. 部署规范

- 单一二进制 `vento`，子命令 `serve`；前端 dist 编译期内嵌（`include_dir`），无运行时外部静态目录依赖。
- Docker 镜像与二进制共享同一配置面（环境变量），功能行为一致。
- 数据目录 `VIENTO_DATA_DIR` 必须持久化（卷/挂载）；镜像内不预置数据。
- 健康检查：`GET /api/v1/health`（PG/Redis 可达性 + 版本）。
