# VentoKnowledge 架构设计

> 版本：V1.1
> 上游依据：《文档管理系统需求说明》V1.0（需求基线）、《VentoDocs 页面设计方案》（视觉与交互基线，见 docs/02-ui-design.md）
> 已确认决策（2026-10-23 与用户确认）：
> - **实施范围：v1 = P0（文件管理核心）+ P1（Office 编辑/分享/网站发布）；Agent 智能体与 zvec-grep 向量检索/RAG 整体推迟到 v2**（用户决策：先不做，非常麻烦）。v2 设计保留在本文 §12/§13，数据模型与权限位提前预留
> - Agent 模型（v2）：OpenAI 兼容接口，base_url/api_key/model 全部可配置（兼容 vLLM/Ollama/OpenAI/DashScope 等）
> - RAG 向量化（v2）：zvec-grep 内置本地 embedding 模型（自部署、数据不出内网）
> - 管理员：两级——超级管理员 + 普通用户
> - 在线编辑：DOCX / XLSX / PPTX 三格式全部目标在线编辑（以 POC-1 验证结果为准，不支持的降级为预览）
> - 网站发布域名：不写死，部署时以环境变量配置（泛域名 + 泛证书）
> - 文件内容存储：本地磁盘

## 1. 总体架构

**v1 范围（本次实施）**：文件管理核心（目录/文件 CRUD、上传下载、预览、ACL、锁定、版本、回收站、分享、网站发布、用户/LDAP 管理、审计、在线 Office 编辑）。
**v2 范围（推迟，设计保留）**：全文内容检索与 RAG（zvec-grep）、文档页 Agent、全应用 RAG Agent。v1 的检索仅做 PG 文件名/元数据搜索；权限位 AGENT_READ/AGENT_WRITE 与 `index_jobs` 表提前保留，v2 接入时不破坏现有结构。

```
┌─────────────────────────────────────────────────────────────────────┐
│                        浏览器（React SPA）                           │
│  文件管理 │ 在线编辑器(Univer OSS) │ 分享/发布管理 │ 用户/权限管理      │
│  v2：AI 助手面板 / 智能体问答页                                       │
└──────────────┬──────────────────────────────────────────────────────┘
               │ HTTPS（REST + SSE + 静态资源）
┌──────────────▼──────────────────────────────────────────────────────┐
│                 Rust 单体二进制（vk-app，Axum）                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │  认证层   │ │ 权限引擎  │ │ 文件服务  │ │ 编辑/锁定 │ │ 分享/发布  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌────────────────────┐ ┌────────────────┐ ┌─────────────────────┐  │
│  │ v2: vk-search 适配层 │ │ v2: vk-agent   │ │ 审计（同事务写入）     │  │
│  │ SearchProvider trait│ │ LLM 客户端/RAG │ │                     │  │
│  └─────────┬──────────┘ └───────┬────────┘ └─────────────────────┘  │
└────────────┼────────────────────┼───────────────────────────────────┘
             │（v2）               │（v2）
   ┌─────────▼─────────┐   ┌─────▼─────────────┐
   │ zvec-grep 引擎     │   │ OpenAI 兼容 LLM   │
   │（进程内库 或 管理   │   │（base_url 可配置，  │
   │  的守护进程，POC 定）│   │  流式 SSE）        │
   └───────────────────┘   └───────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ PostgreSQL（目录树/元数据/ACL/版本/锁/分享/发布/审计）                  │
│ Redis（限流、热缓存；v2：索引同步队列）                                │
│ 本地磁盘对象存储（data/objects，内容寻址）+ 索引视图（data/index-view）  │
└─────────────────────────────────────────────────────────────────────┘
```

设计原则（对应需求 §1/§2.3）：

1. **后端是权限判断的最终依据**。前端只负责呈现与交互；文件列表、正文读取、下载、分享访问、网站发布访问、检索结果读取、Agent 工具调用、文件写入，共 8 个入口全部在服务端鉴权（§8.3）。
2. **三类存储各司其职**：文件系统存内容、PostgreSQL 存目录树与元数据、检索索引只服务内容检索。索引不替代目录树（§11.1）。
3. **检索实现通过适配层隔离**：业务代码只依赖 `SearchProvider` trait，zvec-grep 是可替换实现（§11.1）。
4. **单一 Rust 二进制 + 内嵌前端静态资源**，Docker 与二进制两种部署方式功能一致（§2.2）。

## 2. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 后端语言 | Rust（edition 2024，stable） | 需求指定 |
| Web 框架 | axum 0.8 + tower | 单体二进制，中间件链做认证/审计 |
| 数据库 | PostgreSQL 16 + sqlx（编译期检查） | 需求指定；迁移用 sqlx migrate |
| 缓存/队列 | Redis 7 + redis-rs | 索引同步队列、分布式锁、热缓存、限流 |
| 在线编辑 | Univer OSS（@univerjs/* 1.2.x） | 需求指定；格式矩阵以 POC-1 为准 |
| 内容检索/RAG | zvec-grep（Rust 引擎 `zg_engine`） | 需求指定；集成方式以 POC-2 为准 |
| 前端 | Vite + React 19 + TypeScript（react-swc-ts 模板） | fe-init 流程生成 |
| 前端基建 | pnpm + UnoCSS + zustand + ahooks + antd 5 | fe-init/fe-coding 约定 |
| 对象存储 | 本地磁盘，内容寻址 | 用户决策；存储接口预留 S3 扩展位 |
| LLM | OpenAI 兼容 HTTP API（reqwest） | 用户决策；流式 SSE |
| LDAP | ldap3 客户端（单向导入） | §3.2 约束 |

## 3. 代码组织（Rust workspace）

```
VentoKnowledge/
├── Cargo.toml                 # workspace
├── crates/
│   ├── vk-core/               # 领域核心：纯逻辑，零 I/O，可独立单测
│   │   ├── 实体类型（Dir/File/Grant/Version/Lock/Share/Publish/Audit）
│   │   ├── 权限引擎（10 项权限位、继承求值、管理员旁路判定）
│   │   ├── 并发控制（保存时的乐观并发 + 锁复查逻辑）
│   │   ├── 发布 ID / 分享 token 生成（CSPRNG）
│   │   └── 错误类型（vk::Error → HTTP 状态映射）
│   ├── vk-store/              # PostgreSQL 数据访问（sqlx）
│   │   ├── migrations/        # 编号 SQL 迁移
│   │   ├── repositories/      # 每个聚合一个 repo，事务边界在此层之上由服务组合
│   │   └── object_store/      # 本地内容寻址存储（接口预留 S3）
│   ├── vk-search/             # 检索适配层
│   │   ├── provider.rs        # SearchProvider trait（业务唯一依赖）
│   │   └── zvec/              # zvec-grep 实现（进程内库或守护进程，POC 决定）
│   ├── vk-agent/              # LLM 客户端（OpenAI 兼容、SSE 流式）+ RAG 组装
│   │   └── tools.rs           # Agent 工具：search / read_file / propose_change
│   ├── vk-api/                # Axum 路由、中间件（认证/鉴权/审计/限流）、SSE、静态资源
│   └── vk-app/                # 二进制入口：配置、静态资源 include_dir、后台任务
│       └── tasks/             # 回收站清理、索引同步 worker、版本清理、发布失效
├── web/                        # 前端（fe-init 生成，fe-coding 约定）
└── docs/
```

依赖方向：`vk-app → vk-api → {vk-core, vk-store, vk-agent?}`；`vk-core` 不依赖任何其他 crate。v2 增加 `vk-search`、`vk-agent`。

## 4. 数据模型（PostgreSQL）

主键统一 UUIDv7（时间有序）。时间一律 `timestamptz`，存 UTC。

```sql
-- 用户与团队
users(
  id uuid PK, username text UNIQUE NOT NULL, email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  password_hash text NULL,            -- local 用户必填
  auth_provider text NOT NULL CHECK (auth_provider IN ('local','ldap')),
  ldap_dn text NULL,                  -- LDAP 用户记录来源 DN，仅信息性
  role text NOT NULL CHECK (role IN ('admin','user')),
  disabled bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
)
teams(id uuid PK, name text UNIQUE NOT NULL, description text,
      created_by uuid REFERENCES users, created_at timestamptz)
team_members(team_id uuid REFERENCES teams, user_id uuid REFERENCES users,
             PK(team_id, user_id))

-- 目录树（含回收站根目录）
directories(
  id uuid PK,
  parent_id uuid NULL REFERENCES directories,
  name text NOT NULL,
  path text NOT NULL,                 -- 物化路径 '/a/b/'，唯一便于子树查询
  is_root bool NOT NULL DEFAULT false,
  is_trash bool NOT NULL DEFAULT false,   -- 系统回收站根目录标记
  owner_id uuid REFERENCES users,
  deleted_at timestamptz NULL,         -- 进入回收站时间（180 天清理依据）
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_id, name)            -- 同级不重名（含回收站路径）
)
CREATE INDEX ON directories (path);   -- 子树：path LIKE prefix || '%'

-- 文件元数据
files(
  id uuid PK,
  dir_id uuid NOT NULL REFERENCES directories,
  name text NOT NULL,
  mime text NOT NULL,
  size bytes bigint NOT NULL,
  content_hash text NOT NULL,          -- sha256，指向对象存储
  current_version int NOT NULL DEFAULT 1,
  deleted_at timestamptz NULL,         -- 文件级删除（目录删除时批量置位）
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dir_id, name)
)

-- 版本（默认开启；每次内容变更 +1；恢复 = 新增版本）
file_versions(
  id bigint PK,
  file_id uuid NOT NULL REFERENCES files ON DELETE CASCADE,
  version int NOT NULL,
  content_hash text NOT NULL,
  size bigint NOT NULL,
  note text,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version)
)

-- 用户锁（持久化，不随会话失效）
file_locks(
  file_id uuid PK REFERENCES files ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  note text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES users NULL,
  released_at timestamptz NULL
)

-- 授权（principal：user 或 team；挂在目录上，子树继承）
grants(
  id uuid PK,
  principal_type text NOT NULL CHECK (principal_type IN ('user','team')),
  principal_id uuid NOT NULL,
  directory_id uuid NOT NULL REFERENCES directories ON DELETE CASCADE,
  perms int NOT NULL DEFAULT 0,        -- 权限位集合（见 §5）
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_type, principal_id, directory_id)
)

-- 分享链接
shares(
  id uuid PK,
  resource_type text NOT NULL CHECK (resource_type IN ('file','dir')),
  resource_id uuid NOT NULL,
  token text NOT NULL UNIQUE,          -- 256bit 随机，base62，不可猜测
  password_hash text NULL,
  expires_at timestamptz NULL,
  max_downloads int NULL,              -- NULL = 不限
  used_downloads int NOT NULL DEFAULT 0,
  preview_only bool NOT NULL DEFAULT false,
  revoked bool NOT NULL DEFAULT false,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
)

-- 目录网站发布（标识持久，复启复用）
published_dirs(
  directory_id uuid PK REFERENCES directories,
  publish_id char(16) NOT NULL UNIQUE, -- [a-z2-9] 16 位，CSPRNG
  enabled bool NOT NULL DEFAULT true,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)

-- 审计日志
audit_logs(
  id bigint PK,
  ts timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NULL,                  -- 匿名分享访问为 NULL + token
  actor_name text NOT NULL,
  category text NOT NULL,              -- auth|file|share|publish|lock|agent|admin
  action text NOT NULL,                -- 如 file.download / lock.acquire
  resource_type text NULL,
  resource_id text NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  ip inet
)
CREATE INDEX ON audit_logs (ts), (category, action), (resource_type, resource_id);

-- 索引任务队列（POD 级失败重试与状态）
index_jobs(
  id bigint PK,
  job_type text NOT NULL,              -- upsert|remove|rebuild
  file_id uuid NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)
```

## 5. 权限模型

### 5.1 十项操作权限（§8.2，拆分为独立权限项）

| 位 | 权限 | 说明 |
|---|---|---|
| 1 | READ_PREVIEW | 列表可见 + 预览 |
| 2 | DOWNLOAD | 下载原文件 |
| 4 | CREATE_UPLOAD | 新建目录/上传文件 |
| 8 | MODIFY_RENAME | 重命名（文件/目录） |
| 16 | MOVE_COPY | 移动、复制 |
| 32 | DELETE_RESTORE | 删除、回收站恢复、永久删除 |
| 64 | SHARE | 创建/撤销分享 |
| 128 | PUBLISH | 开启/关闭目录网站发布 |
| 256 | AGENT_READ | Agent 读取该文件内容（独立于 READ_PREVIEW） |
| 512 | AGENT_WRITE | Agent 修改该文件 |

`ALL = 0x3FF`。授权界面按位勾选；预设模板：只读(1|2)、可读写(全部基础位)、可编辑(除 AGENT_*)、完全控制(ALL)。

### 5.2 继承与求值规则（§8.1，需求留待技术设计阶段明确，此处定案）

- 授权**只能挂在目录上**，子目录不可单独设置（硬约束，API 与 UI 均拒绝子目录覆盖）。
- 有效权限 = 节点自身 + 所有祖先目录上、命中该主体（本人或所属团队）的全部授权**按位取并集**（union）。
- 团队授权与个人授权同样按并集组合；不提供"拒绝"位（拒绝通过不授予实现）。
- 目录创建者自动在该目录获得 ALL（创建即授权，写入 grants）。
- 超级管理员对所有目录/文件恒有 ALL，不做旁路漏洞：管理员操作同样走同一鉴权函数，只是该函数对 admin 返回 ALL；管理员**解锁他人锁不授予写权限**（§7.2，锁与权限是两套独立检查）。
- 根目录默认授权：系统创建时给第一个超管 ALL；其余用户无隐式权限。
- 求值实现：`effective_perms(user, dir_id) = admin?ALL : union(grants on path-chain)`，结果按 (user, dir, grants-rev) 做短 TTL 缓存（Redis，默认 60s），授权变更时主动失效该目录子树的缓存键。

### 5.3 八个强制鉴权入口（§8.3）

| 入口 | 检查 |
|---|---|
| 文件/目录列表 | 过滤掉无 READ_PREVIEW 的条目 |
| 正文读取/预览 | READ_PREVIEW + 分享策略 |
| 下载 | DOWNLOAD（分享：分享策略 ∧ DOWNLOAD） |
| 分享访问 | token/密码/有效期/次数/撤销/preview_only 全服务端校验 |
| 网站发布访问 | Host 匹配 + enabled + 发布访问控制（默认匿名可读，可配置需登录） |
| 检索结果读取 | UI 搜索：结果仅含 READ_PREVIEW 的文件；正文拉取再次检查 |
| Agent 工具调用 | 工具内部逐一校验 AGENT_READ / AGENT_WRITE + 锁 + 版本 |
| 文件写入（全部入口） | 写权限 ∧ 锁检查（§6） |

## 6. 文件锁与并发（§7）

- 锁记录在 PG `file_locks`，**持久**：登出/关浏览器/会话过期不释放（需求明确）。
- 加锁原子性：`INSERT ... ON CONFLICT (file_id) DO NOTHING`，成功行数 1 才算拿到锁。
- 解锁：仅锁定人或超级管理员；写权限持有者若**非锁定人**，不能解锁、不能写入。
- **所有写入路径统一收口**到 `FileWriter.save(file_id, user, new_hash, base_version)`：
  1. 同一 PG 事务内：`SELECT lock FOR UPDATE` 复查锁（锁定人==user 或无锁）；
  2. 乐观并发：`UPDATE files SET current_version=current_version+1, ... WHERE id=$1 AND current_version=$base`，影响行数 0 → 返回 409（版本已被他人推进）；
  3. 插入 `file_versions` 行；提交事务；
  4. 提交后：对象已落盘（见 §7），异步入索引队列。
- 在线编辑、Agent 修改、恢复历史版本、上传覆盖、移动（改元数据不产生版本）全部走该入口，前端禁用只是体验层。
- 锁与保存的竞态（检查后锁被加）：步骤 1 在事务内行锁复查，保证 TOCTOU 安全。

## 7. 文件存储（本地磁盘，内容寻址）

```
data/
├── objects/xx/yy/<sha256>        # 内容对象；xx yy 为哈希前 4 位两级目录
├── index-view/<目录物化路径>/<文件名>  # 硬链接视图：真实路径+文件名，供检索引擎索引
└── tmp/                          # 上传暂存（哈希校验后原子 rename 进 objects/）
```

- 上传：流式写 `tmp/` 边写边算 sha256 → 校验通过 → `link`/`rename` 到 `objects/`（已存在则跳过，天然去重）→ 建元数据行。
- 版本/恢复不复制数据：新 hash 若已存在直接引用；**恢复历史版本 = 用旧 hash 生成新版本行**（§5 需求：作为新变更 + 触发索引）。
- 对象删除引用计数：物理删除仅当该 hash 不再被任何 `file_versions` 引用（永久删除/版本清理时检查）。
- 上传限制：单文件默认 500MB（可配 `VIENTO_MAX_UPLOAD_MB`）；超过拒绝并明确报错。
- `ObjectStore` trait 定义在 vk-store，本地实现现在，S3 实现留扩展位（用户已确认本期本地磁盘）。

## 8. 目录/文件生命周期

- **删除**：文件与目录都是软删除——`deleted_at` 置位；目录删除时级联置位其子树全部文件，并把子树整体移入回收站根目录（path 重写）。
- **回收站**：默认保留 180 天（`VIENTO_TRASH_RETENTION_DAYS`），后台任务每日清理：超期目录/文件 → 永久删除（PG 行 + 索引 `remove` + 无引用对象清理）。
- **恢复**：恢复到原路径；原路径被占（同名文件/目录已存在）→ API 返回 409 + 冲突详情，由用户选择"重命名恢复"（追加 `(n)`）或"恢复到指定目录"。恢复 = 内容不变的新状态 + 索引 upsert。
- **移动/复制**：移动只改 `path`/`dir_id` 与 `index-view` 路径（索引增量更新路径）；复制生成新 `files` 行、复用同一 content_hash、版本从 1 开始。
- **重命名**：改 `name` + 索引 upsert。
- **压缩包**：上传时可选"解压到此目录"（zip/tar.gz，rust 实现，限制递归深度与总大小防 zip bomb）；目录右键"打包下载 zip"（流式）。
- **排序/筛选**：名称/时间/类型/大小排序，按名称文件名搜索（PG `name` trigram 索引），多条件组合走查询参数。

## 9. 在线 Office 编辑（Univer OSS）

- 前端按 MIME 选择编辑器：xlsx → Univer Sheets；docx → Univer Docs；pptx → Univer Slides（**以 POC-1 验证的格式矩阵为准**；某格式不支持导入/导出时，该格式只给预览 + "暂不支持在线编辑"提示，不静默转换）。
- 打开编辑：前端先 `POST /files/:id/lock`（或已持有锁/自己是锁定人）→ 拉取编辑数据（GET `/files/:id/edit-data`，按格式返回 Univer 数据或 Office 字节供前端插件导入）。
- 保存：PUT `/files/:id/edit-save` 携带 `base_version` + 前端导出的文件字节（xlsx/docx/pptx）→ 统一走 §6 `FileWriter.save`。
- 并发：`base_version` 乐观锁；冲突时前端弹出版本对比提示（"文件已被更新"，可选择放弃/覆盖为我的内容需再次确认）。
- 编辑会话心跳：编辑期间每 30s 上报 `heartbeat`，仅用于 UI 显示"谁在编辑"，不改变锁语义（锁持久）。
- 保真度兜底：POC-1 若发现某格式往返丢失结构（公式/图表/复杂样式），该格式默认"预览 + 导出前提示"，并记录在部署文档。

## 10. 分享（§9）

- 对象：单文件或目录。创建时配置：密码（可选，argon2id 哈希存储）、有效期（默认 7 天，可不限）、下载次数（默认不限）、仅预览（可选，默认允许下载——见 §15 决策记录）。
- token：128bit+ 随机（256bit），base62 编码，**不可枚举**；服务端校验 token → 密码（常时间比对）→ 有效期 → 次数（原子 `UPDATE ... WHERE used_downloads < max` 递增）→ 撤销标志。
- 仅预览分享：只提供预览流接口，下载接口返回 403；预览内容按文件类型渲染（Office 走预览、图片直出、文本直出），**不得**暴露原文件下载接口。
- 分享访问不授予任何系统权限：分享页是无登录态的独立路由，不产生会话。
- 每次分享访问写审计（category=share）。

## 11. 目录网站发布（§10）

- `published_dirs.publish_id`：16 位 `[a-z2-9]`（去掉易混淆字符），CSPRNG 生成，**每目录唯一且持久**；关闭→再开启复用同一 ID（表行保留，只切 `enabled`）。
- 访问域名：`https://<publish_id>.<VIENTO_PUBLISH_DOMAIN>/...`。`VIENTO_PUBLISH_DOMAIN` 环境变量（如 `s.example.com`）；**未配置时发布功能整体禁用**并在 UI 明确提示（不写死域名）。
- 路由：Axum 按 Host 头匹配 `<publish_id>.<publish_domain>` → 发布目录路由；`enabled=false` 或 ID 不存在 → 立即 410/404（需求：关闭后旧地址立即失效，服务端拒绝，无缓存残留——响应头 `Cache-Control: no-store`）。
- 访问控制：默认**匿名可读**该目录树（只读浏览 + 下载受发布策略控制：可配置"需登录/仅预览"）；随机子域名只降低猜测概率，不构成访问控制（需求明确）。
- 发布的内容范围 = 目录子树当前状态；文件变更后发布内容自动跟随（无快照）。
- 缓存策略：发布页资源 `no-cache` + ETag；正文按内容 hash 缓存（长 TTL），失效靠 hash 变化自然失效。

## 12. 搜索与索引（zvec-grep，§11）【v2 预留，本次不实施】

### 12.1 适配层

```rust
#[async_trait]
pub trait SearchProvider: Send + Sync {
    async fn upsert(&self, job: IndexUpsert) -> Result<()>;   // 含路径变更
    async fn remove(&self, job: IndexRemove) -> Result<()>;
    async fn rebuild(&self) -> Result<()>;
    async fn search(&self, q: SearchQuery) -> Result<SearchHit>;
}
pub struct SearchQuery { pub text: String, pub file_types: Vec<Mime>, pub limit: u32, pub fresh: bool }
```

业务代码（UI 搜索、Agent RAG）只依赖该 trait；zvec-grep 细节全部在 `vk-search::zvec`。

### 12.2 zvec-grep 集成方式（POC-2 决定，倾向 A）

- **A. 进程内**：Cargo 直接依赖 `zg_engine` crate（git 依赖 `zvec-ai/zvec-grep`，rust 子目录；crates.io 暂未发布，已验证）。优点：无进程管理、延迟低；`ZvecGrep` 单实例共享，`root` 是请求态，天然支持单实例多工作区。
- **B. 守护进程**：管理 `zg --server` 子进程，HTTP/MCP 通信。作为 A 不可行时的后备。
- 模型运行期由引擎自管理（本地权重缓存、空闲 15min 过期），无需额外进程。

### 12.3 索引布局与增量

- 索引根 = `data/index-view/`（真实目录路径 + 文件名的硬链接视图，§7）。zvec-grep 在索引根下维护 `.zvec-grep/` 索引状态。
- 增量：`index_jobs` 队列（PG 持久化 + Redis 锁防多 worker 重入）→ worker 调 `provider.upsert/remove`；失败重试（指数退避，最多 5 次，`last_error` 落库）；支持 `rebuild` 全量重建兜底（管理界面触发）。
- 触发点：上传、编辑保存、Agent 修改、恢复、移动/重命名（路径 upsert）、永久删除（remove）。全部异步，最终一致（§16 验收原则）。
- 可检索格式（POC-2 验证）：txt/md/csv/json/代码类直接；docx/xlsx/pptx/pdf 走 zvec-grep 内容抽取能力验证；无法可靠抽取的格式只索引文件名 + 元数据，并在 UI 标注"仅文件名可搜"。
- 多用户隔离：**索引不按用户隔离**；所有结果在返回前经服务端按请求用户权限过滤（§5.3）。UI 搜索仅返回有 READ_PREVIEW 的命中；Agent 仅返回 AGENT_READ 的命中（检索不授权）。

## 13. Agent（§12）【v2 预留，本次不实施】

### 13.1 两类入口

- **文档页右侧面板**：上下文 = 当前文件（全文抽取/按块截断）+ 会话历史。能力：解释、问答、提出修改建议、生成修改后内容。
- **全应用 RAG Agent**：用户多选来源目录 → 检索范围 = 所选目录 ∩ 用户 AGENT_READ 文件；综合多目录回答，回答附**文件引用**（文件名 + 路径 + 命中片段定位）。

### 13.2 工具与写回（服务端硬约束）

Agent 可用工具（服务端执行，非提示词约束）：
1. `search(queries[], scope_dir_ids[])` → 走 SearchProvider，结果按用户 AGENT_READ 过滤；
2. `read_file(file_id, range)` → 校验 AGENT_READ，返回正文片段；
3. `propose_change(file_id, patch, rationale)` → 只生成**修改建议对象**，不写盘；UI 展示 diff，用户点"应用"后调 `apply_change` API → 完整走 §6 `FileWriter.save`（写权限 ∧ 锁 ∧ base_version ∧ 生成新版本 ∧ 索引更新），任一失败明确反馈给 Agent 与用户。

LLM 客户端：OpenAI 兼容 `/chat/completions`，SSE 流式到前端（`POST /agent/chat` SSE）；模型参数全部配置（`VIENTO_LLM_BASE_URL/KEY/MODEL`、温度、max_tokens）；单次会话上下文预算可配；Agent 无独立身份——每次工具调用以**当前用户**身份执行（§12.3）。

### 13.3 内容抽取（Agent 上下文）

Rust 侧 `TextExtractor`：txt/md/csv 直接；xlsx → calamine（表格转文本行）；docx → quick-xml 解析 document.xml；pptx → quick-xml 解析 slide XML 文本；pdf → pdf-extract（若 POC 验证质量不足，Agent 对 PDF 仅答文件名级）。Office 编辑格式 ≠ 必然可抽取（§11.3），抽取结果仅用于 LLM 上下文，不入库。

## 14. 审计与运行状态（§13）

- 写点：分享访问、加锁/解锁、权限变更、发布开关、Agent 写操作、管理员操作、认证事件——**与业务同事务写入**（失败即业务失败）。
- 类别：auth / file / share / publish / lock / agent / admin（§15.11 定案）。
- 保留：默认 365 天（`VIENTO_AUDIT_RETENTION_DAYS`），后台任务清理；导出 CSV（管理员界面，按条件筛选）。
- 管理界面：审计列表 + 筛选（时间/类别/操作人/资源）+ CSV 导出。

## 15. 认证与用户管理（§3）

- 本地用户：email/用户名 + 密码（argon2id），登录签发 JWT（HS256，TTL 默认 24h，`VIENTO_JWT_TTL_HOURS`）；Bearer 头。
- 管理员：`role='admin'`（两级：超管 + 普通用户，§15.1 定案；"管理员"即超管，负责用户管理与授权）。首个用户经引导流程创建（无用户时 `/api/bootstrap` 可用，创建后永久关闭）。
- LDAP（§3.2）：管理员触发"从 LDAP 导入"——ldap3 连接（host/port/base_dn/绑定账号/用户过滤器/字段映射均可配），导入用户名/姓名/邮箱到 `users(auth_provider='ldap')`；**LDAP 用户初始不可登录**（系统不存其密码），需管理员为其设本地密码或后续接入 LDAP 绑定登录（二期）；LDAP 删除不联动删除本地用户；LDAP 用户密码修改只改本地，不回写 LDAP；导入不得绕过权限规则（导入即普通用户，无隐式授权）。
- 限流：登录接口按 IP+账号限流（Redis 计数）。

## 16. 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIENTO_DATA_DIR` | `./data` | 对象存储 + 索引视图根 |
| `VIENTO_DB_URL` | 必填 | PG 连接串 |
| `VIENTO_REDIS_URL` | 必填 | Redis 连接串 |
| `VIENTO_JWT_SECRET` | 必填 | JWT 密钥 |
| `VIENTO_MAX_UPLOAD_MB` | 500 | 单文件上传上限 |
| `VIENTO_TRASH_RETENTION_DAYS` | 180 | 回收站保留 |
| `VIENTO_VERSION_KEEP` | 20 | 每文件保留版本数（超出最旧清理，对象按引用计数） |
| `VIENTO_AUDIT_RETENTION_DAYS` | 365 | 审计保留 |
| `VIENTO_PUBLISH_DOMAIN` | 空=禁用发布 | 发布泛域名后缀 |
| `VIENTO_LLM_BASE_URL/KEY/MODEL` | 空=禁用 Agent | OpenAI 兼容 |
| `VIENTO_ZVEC_EMBEDDING` | 引擎默认本地模型 | 可指定模型标识 |
| `VIENTO_BIND_ADDR` | `0.0.0.0:8080` | 监听地址 |

配置经环境变量；`docker compose` 与二进制部署使用同一套变量（§2.2 一致性）。

## 17. 安全设计

- 密钥全走环境变量/文件，不落库、不落代码；JWT/分享 token/发布 ID 用 CSPRNG。
- 密码 argon2id；LDAP 绑定账号凭据仅存配置。
- HTTP 安全头：CSP、X-Content-Type-Options、X-Frame-Options；上传 MIME 白名单校验（以 magic bytes 复核）；路径穿越防御（文件名清洗）；zip bomb 防御（递归深度 + 解压后总量上限）。
- 预览流按用户权限逐请求检查；分享/发布路由不共享主站会话。
- 搜索/Agent 结果不过滤等于泄露元数据——服务端强制过滤（§5.3）。
- 依赖安全：cargo audit 纳入 CI。

## 18. 部署

- **二进制**：`cargo build --release` 单二进制，前端 `web/dist` 经 `include_dir` 编译期内嵌；`./vento serve` 启动；data 目录可配。
- **Docker**：多阶段构建（node:22 构建前端 → rust 构建 → debian:trixie-slim 运行，含 libssl/ca-certificates）；官方 compose 提供 postgres:16 + redis:7 + 应用三服务；数据卷 `data`。
- 两种部署功能/配置一致（§2.2）；部署文档在 `docs/04-deployment.md`（实施期产出）。

## 19. 与需求 §15 待确认事项的定案映射

| # | 待确认项 | 本设计定案 |
|---|---|---|
| 1 | 分层管理员 | 两级：超管（用户/授权/审计/运维全权）+ 普通用户（按 ACL） |
| 2 | LDAP 规则 | §15：导入单向；用户名冲突跳过并报告；禁用=本地 disabled；重导入只更新不删；字段映射可配 |
| 3 | 权限冲突/组合 | 无"拒绝"位，个人+团队按位并集；继承见 §5.2 |
| 4 | 格式与大小限制 | 预览：Office 三格式 + PDF + 图片 + 文本类；编辑：Office 三格式（POC 门）；上传 500MB 可配 |
| 5 | 版本保留 | 默认每文件 20 版，可配；清理为后台任务；对象引用计数回收 |
| 6 | 分享默认 | 有效期 7 天、不限次数、无密码、允许下载（创建时可改） |
| 7 | 发布域名/认证 | 环境变量配置；未配置=功能禁用；默认匿名只读，可配需登录 |
| 8 | Univer 格式范围 | POC-1 后定案，降级策略见 §9（P1 实施前完成） |
| 9 | zvec-grep 集成 | **推迟 v2**；v1 仅 PG 文件名/元数据搜索。v2 时 POC-2 定案，倾向进程内库，后备守护进程（§12.2） |
| 10 | Agent 模型/工具/交互 | **推迟 v2**；设计见 §13。v1 权限位 AGENT_* 保留不启用 |
| 11 | 日志/审计 | 7 类别、365 天保留可配、管理界面筛选+CSV 导出 |
| 12 | 运维 | 备份=PG dump + data 目录（文档化流程）；配额默认关闭可配；单实例部署（水平扩展留设计位：状态均在 PG/磁盘，无本地会话） |

## 20. 实施阶段

| 阶段 | 内容 | 前置 |
|---|---|---|
| M0 | 仓库骨架、CI、docker-compose（PG/Redis）、配置、迁移、认证与用户管理 API、前端脚手架与全局框架 | — |
| M1 | 文件管理核心：目录树、文件 CRUD、上传/下载/预览、ACL、锁定、版本、回收站、审计、文件名搜索 | M0 |
| M2 | 在线 Office 编辑（Univer OSS：POC-1 通过后按格式矩阵接入） | POC-1 |
| M3 | 文件分享 + 目录网站发布 | M1 |
| v2 | 全文/向量检索（zvec-grep，POC-2）、文档页 Agent、全应用 RAG Agent | POC-2 + M1 |

POC 明细与验收标准见 `docs/04-poc-milestones.md`。
