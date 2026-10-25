# 部署文档

VentoDocs 由**单一 Rust 二进制**提供全部服务：REST API、管理前端（构建期经 `include_dir` 内嵌）、目录网站发布（泛域名）、在线编辑器静态资源（运行时从磁盘目录读取）。依赖 PostgreSQL 16 与 Redis 7。

## 1. 组件清单

| 组件 | 说明 | 必需 |
| --- | --- | --- |
| `vento` 二进制 | 全部业务逻辑 + 内嵌前端 | 是 |
| PostgreSQL 16 | 目录/文件/权限/分享/发布/审计数据 | 是 |
| Redis 7 | 会话缓存、分享密码挑战等热数据 | 是 |
| `editor-dist/` | 在线编辑器静态资源（ranuts/document，AGPL-3.0，解压后约 270MB） | 否（缺失时编辑功能自动降级） |

## 2. 构建

```bash
# 前置：Rust 1.99+、Node 22+、pnpm 12+
git clone <repo> && cd VentoDocs

# 1. 前端（产物 web/dist，编译期内嵌到二进制）
cd web && pnpm install && pnpm build && cd ..

# 2. 在线编辑器静态资源（首次或升级时执行，需 Docker，解压后约 270MB）
bash scripts/fetch-editor.sh
#   从官方镜像 ghcr.io/ranuts/document 提取 /public 到 ./editor-dist/（已 gitignore）
#   脚本自动剥离 sw.js / sw-register.js（本服务以同源 iframe 文档加载，禁用 Service Worker）

# 3. 后端（release，前端已内嵌）
cargo build --release -p vk-app
#   产物：target/release/vento
```

Docker 镜像（一条命令完成前端 + 后端构建）：

```bash
docker build -t vento:latest .
```

## 3. 配置

所有配置通过环境变量注入（进程环境优先，未设置时从进程 CWD 下的 `.env` 读取）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VIENTO_BIND_ADDR` | `0.0.0.0:8080` | 监听地址 |
| `VIENTO_DB_URL` | （必填） | `postgres://vento:vento@127.0.0.1:5432/vento` |
| `VIENTO_REDIS_URL` | （必填） | `redis://127.0.0.1:6379` |
| `VIENTO_JWT_SECRET` | （必填，≥16 字符） | JWT 签名密钥 |
| `VIENTO_JWT_TTL_HOURS` | `24` | 登录态时长（小时） |
| `VIENTO_DATA_DIR` | `data` | 文件对象存储根目录（`{root}/objects/…`） |
| `VIENTO_MAX_UPLOAD_MB` | `500` | 单文件上传上限（MB） |
| `VIENTO_TRASH_RETENTION_DAYS` | `180` | 回收站保留天数（保留参数，v1 无自动清理任务） |
| `VIENTO_VERSION_KEEP` | `20` | 每文件保留版本上限（保留参数，v1 无自动清理任务） |
| `VIENTO_AUDIT_RETENTION_DAYS` | `365` | 审计日志保留天数（保留参数，v1 无自动清理任务） |
| `VIENTO_PUBLISH_DOMAIN` | 空 = 禁用 | 目录网站发布泛域名后缀，如 `publish.example.com`（需泛域名 + 泛证书，见 §6） |
| `VENTO_EDITOR_DIST` | `editor-dist`（相对 CWD） | 在线编辑器静态资源目录；目录缺失 `index.html` 时编辑功能自动降级 |
| `VIENTO_LDAP_HOST` | 空 = 禁用 | LDAP 目录导入（§15/16/17），配合下方变量 |
| `VIENTO_LDAP_PORT` | `389` | |
| `VIENTO_LDAP_START_TLS` | `false` | |
| `VIENTO_LDAP_BASE_DN` | — | 搜索根，如 `ou=people,dc=example,dc=com` |
| `VIENTO_LDAP_BIND_DN` | — | 只读绑定账号（仅存环境变量，不落库） |
| `VIENTO_LDAP_BIND_PASSWORD` | — | |
| `VIENTO_LDAP_USER_FILTER` | `(objectClass=inetOrgPerson)` | |
| `VIENTO_LDAP_ATTR_USERNAME` | `uid` | |
| `VIENTO_LDAP_ATTR_NAME` | `cn` | |
| `VIENTO_LDAP_ATTR_EMAIL` | `mail` | |

`RUST_LOG` 控制日志级别（默认 `info,sqlx=warn`）。

## 4. 部署方式一：裸二进制（推荐）

```bash
# 依赖（PostgreSQL + Redis）
docker compose up -d          # 开发/生产同用 docker-compose.yml

# 配置
cp .env.example .env          # 至少修改 VIENTO_JWT_SECRET、VIENTO_DB_URL、VIENTO_REDIS_URL

# 启动（生产建议 systemd）
./target/release/vento        # 前台；systemd 用 ExecStart=.../vento
```

systemd 单元示例：

```ini
[Unit]
Description=VentoDocs
After=network.target postgresql.service redis.service

[Service]
WorkingDirectory=/opt/vento
EnvironmentFile=/opt/vento/.env
ExecStart=/opt/vento/vento
Restart=always
User=vento

[Install]
WantedBy=multi-user.target
```

健康检查：

```bash
curl -s http://127.0.0.1:8080/_env
# {"editorBase":"/document/","publishDomain":"…"}  ← editorBase 为 null 表示编辑器资源缺失
```

数据库迁移在启动时自动执行（`db.migrate()`），无需手工迁移。

### 4.1 首次初始化

无用户时 `POST /api/v1/auth/bootstrap` 可创建管理员，**创建后该端点永久关闭**：

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<初始密码>","name":"管理员"}'
```

> 初始密码请通过受控渠道交付并立即修改（用户管理页 → 修改密码）。

## 5. 部署方式二：Docker

```bash
cp .env.example .env          # 按 §3 修改
bash scripts/fetch-editor.sh  # 可选，拉取编辑器资源到 ./editor-dist/

docker build -t vento:latest .
docker compose -f compose.prod.yml up -d
```

`compose.prod.yml` 起 3 个容器：`pg`（postgres:16）、`redis`（redis:7，均不发布端口）、`vento`（内嵌前端单二进制）。

- 数据卷：`./data`（对象存储）+ 命名卷 `pgdata`/`redisdata`。
- 编辑器：绑定挂载 `./editor-dist:/editor-dist:ro`（可选；不挂则自动降级）。
- 仅发布 `8080` 端口；PG/Redis 只在 compose 内网可达。
- 升级：`docker compose -f compose.prod.yml pull && up -d`（镜像名固定 `vento:latest`，本地构建时替换为 tag）。

## 6. 在线编辑器（AGPL-3.0）

- 来源：[ranuts/document](https://github.com/ranuts/document)（edit.chaxus.com）官方预构建镜像，**未修改**，以独立同源 iframe 文档（`/document/?embed=1`）运行；仓库不含其源码，`editor-dist/` 已 gitignore。
- 拉取：`bash scripts/fetch-editor.sh`（需 Docker；从 `ghcr.io/ranuts/document` 提取 `/public`，剥离 Service Worker）。
- 配置：`VENTO_EDITOR_DIST`（默认 `editor-dist`，相对进程 CWD；Docker 内为 `/editor-dist`）。
- **降级行为**：目录缺失 `index.html` 时启动告警，`/_env` 返回 `editorBase: null`，`/document/**` 返回 404 JSON（`EDITOR_NOT_DEPLOYED`），前端预览区提示"在线编辑器未部署，请下载后查看"；下载/版本/权限等其余功能不受影响。
- 可编辑格式：xlsx / csv / docx / pptx；xls / xlsm / ods / doc / odt / rtf / ppt 只读预览；编辑经带版本 API（`POST /api/v1/files/{id}/save`，multipart）保存，保存前自动锁文件。
- 升级编辑器：重新执行 `scripts/fetch-editor.sh`（可加 `--tag <版本>`）覆盖 `editor-dist/` 后重启即可；页面入口与字体转换 WASM 等无指纹资源带 `no-cache` 响应头，升级后刷新页面即加载新版本，`assets/**` 指纹化资源保持 `immutable` 缓存。
- **合规**：本组件为 AGPL-3.0。VentoDocs 仓库不含其源码；部署方运行包含该组件的系统时，源码披露等义务由部署方按许可证条款承担，生产对外部署前请评估自身分发形态与 AGPL-3.0 的合规要求。

## 7. 目录网站发布

1. 配置 `VIENTO_PUBLISH_DOMAIN=publish.example.com`（需将 `*.publish.example.com` 解析到本服务并配泛域名证书）。
2. 目录管理页 → 发布 → 生成 `https://publish.example.com/d/<token>` 站点；可选登录策略（匿名 / 需登录）与密码。
3. 停用发布后原 URL 返回 410 Gone（`GONE`），禁止缓存。
4. 发布页只读：文件预览（含在线编辑器只读模式）、下载；无编辑/删除入口。

## 8. 备份与数据

- **PostgreSQL**：`pg_dump -Fc vento > vento-$(date +%F).dump`（含目录结构、权限、分享、发布、审计）。
- **对象存储**：`$VIENTO_DATA_DIR/objects/` 为按 SHA-256 分片的内容寻址存储，`tar` 打包即可；对象不可变，冷备份安全。
- **保留策略**：`VIENTO_TRASH_RETENTION_DAYS` / `VIENTO_VERSION_KEEP` / `VIENTO_AUDIT_RETENTION_DAYS` 为保留参数，v1 不执行自动清理任务，请结合备份策略手动清理（`DELETE FROM file_versions WHERE …`、对象目录按版本行反查）。

## 9. 升级

```bash
# 1. 备份（§8）
# 2. 新代码构建（前端 + 后端），编辑器资源如有新版本重新拉取
# 3. 停旧进程 → 替换二进制 → 启动；迁移自动执行
# 4. 健康检查：/_env、/ 首页、登录、任一文件预览
```

升级不改变数据格式；二进制与 `editor-dist/` 相互独立，可分别灰度。

## 10. 常见问题

| 现象 | 排查 |
| --- | --- |
| `/_env` 返回 `editorBase: null` | `VENTO_EDITOR_DIST` 指向的目录无 `index.html`；执行 `scripts/fetch-editor.sh` 后重启 |
| 前端预览区提示"在线编辑器未部署" | 同上（前端按 `editorBase` 隐藏编辑能力） |
| 编辑器白屏 / 加载超时 | 浏览器控制台看 `/document/**` 是否有 404（资源不完整，重新拉取）；检查反向代理是否缓冲了大文件（`proxy_buffering off`）；注意入口 `index.html` 与子应用均为相对路径，必须经 `/document/`（带尾斜杠）访问 |
| 端口被占用 | 改 `VIENTO_BIND_ADDR`；确认 8080 未被其他进程监听 |
| 发布站点 410 | 发布被停用或 token 失效，属预期行为 |
| bootstrap 403 | 系统已初始化，端点已关闭；走用户管理页改密 |
