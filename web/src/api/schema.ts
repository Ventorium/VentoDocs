/**
 * API 类型定义（手工维护版 OpenAPI schema）。
 *
 * 偏差说明：后端未提供 OpenAPI 文档，o2t 亦无 codegen CLI，
 * 本文件与 `crates/vk-api/src/lib.rs` 路由表手工同步（已在 docs/03 记录）。
 *
 * 约定：
 * - 类型一律用 `type`；
 * - `OpenAPIs[method][path]` 五个键缺一不可（o2t 约束），未使用的选项键写 `any`；
 * - 路径参数用 `{name}` 占位符，调用时经 `params` 传入。
 */

export type Role = 'admin' | 'user'
export type AuthProvider = 'local' | 'ldap'
export type PrincipalType = 'user' | 'team'

export type User = {
  id: string
  username: string
  display_name: string
  auth_provider: AuthProvider
  role: Role
  disabled: boolean
  created_at: string
}

/** /api/v1/auth/me 与 JWT 中间件注入的当前用户。 */
export type AuthUser = {
  id: string
  username: string
  display_name: string
  role: Role
  is_admin: boolean
}

export type Team = {
  id: string
  name: string
  created_at: string
  member_count: number
}

export type Directory = {
  id: string
  parent_id: string | null
  name: string
  path: string
  is_trash: boolean
  deleted_at: string | null
  created_by: string | null
  created_at: string
}

export type FileMeta = {
  id: string
  directory_id: string
  name: string
  size: number
  mime: string
  current_version: number
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

/** M2.15：zip 包内条目（扁平相对路径，目录由后端标记）。 */
export type ZipEntryOut = {
  name: string
  size: number
  is_dir: boolean
  modified: string | null
}

/** M2.15：zip 包条目列表。 */
export type ZipListOut = {
  name: string
  size: number
  entry_count: number
  entries: ZipEntryOut[]
}

/** 回收站目录项：Directory + 删除前可读路径。 */
export type TrashedDirectory = Directory & { original_path: string }

/** 回收站文件项：FileMeta + 删除前可读路径。 */
export type TrashedFile = FileMeta & { original_path: string }

export type FileLock = {
  locked_by: string
  locked_by_name: string
  locked_at: string
}

/** 文件详情：元数据 + 锁 + 当前用户权限位。 */
export type FileOut = {
  file: FileMeta
  lock: FileLock | null
  my_perms: number
}

/** 目录页：当前目录 + 子项 + 当前用户在该目录的权限位。 */
export type DirectoryPage = {
  directory: Directory
  children: Entry[]
  my_perms: number
}

/** 目录子项（serde tag = "kind"）；文件项附带当前锁状态。 */
export type Entry =
  | { kind: 'directory'; directory: Directory }
  | { kind: 'file'; file: FileMeta; lock: FileLock | null }

export type GrantItem = {
  id: string
  directory_id: string
  principal_type: PrincipalType
  principal_id: string
  principal_name: string
  perms: number
  created_at: string
}

export type VersionInfo = {
  id: string
  file_id: string
  version: number
  size: number
  note: string | null
  created_by: string
  created_at: string
  created_by_name: string
  /** office = 原始文件字节（上传与在线编辑保存均为此值）；univer = 历史 Univer 快照（存量数据）。 */
  encoding: 'office' | 'univer'
}

/** 审计日志条目（管理员列表接口返回）。 */
export type AuditEntry = {
  id: number
  ts: string
  actor_id: string | null
  actor_name: string | null
  category: string
  action: string
  resource_type: string | null
  resource_id: string | null
  detail: Record<string, unknown>
  ip: string | null
}

/** LDAP 连接配置（GET /users/ldap/config，不含密码明文）。
 *  source: 'database' = 系统设置中保存的在线配置；'env' = 环境变量 VIENTO_LDAP_* 回退。 */
export type LdapConfigInfo = {
  source: 'database' | 'env'
  host: string
  port: number
  startTls: boolean
  baseDn: string
  bindDn?: string
  bindDnSet?: boolean
  passwordSet?: boolean
  userFilter: string
  attrUsername: string
  attrName: string
  attrEmail: string
}

/** LDAP 在线配置保存请求（PUT /users/ldap/config）。
 *  注意：请求体为 snake_case（后端 LdapConfigReq）；bind_password 缺省/空 = 沿用已有密码，不覆盖。 */
export type LdapConfigUpdate = {
  host: string
  port: number
  start_tls: boolean
  base_dn: string
  bind_dn: string
  bind_password?: string
  user_filter: string
  attr_username: string
  attr_name: string
  attr_email: string
}

/** LDAP 连接测试结果（POST /users/ldap/test，始终 200，看 ok 字段）。 */
export type LdapTestResult = {
  ok: boolean
  entries?: number
  sample?: string[]
  error?: string
}

/** LDAP 连接测试请求：全部字段可选（snake_case，后端 LdapTestReq）。
 *  host 省略（发 `{}`）= 测试当前生效配置；host 有值 = 用表单值测试（保存前测试）。
 *  bind_password 留空 = 沿用已有密码（库中或环境变量）。 */
export type LdapTestReq = {
  host?: string
  port?: number
  start_tls?: boolean
  base_dn?: string
  bind_dn?: string
  bind_password?: string
  user_filter?: string
  attr_username?: string
  attr_name?: string
  attr_email?: string
}

/** LDAP 导入结果（POST /users/ldap/import，无请求体）。 */
export type LdapImportResult = {
  created: number
  skipped: number
  failed: string[]
}

// ---------------- M3：分享 ----------------

export type ShareResourceType = 'file' | 'directory'

/** 分享记录（后端已剥离 password_hash，补 has_password 视图字段）。 */
export type Share = {
  id: string
  token: string
  resource_type: ShareResourceType
  resource_id: string
  has_password: boolean
  /** ISO 时间；null = 永久有效 */
  expires_at: string | null
  /** null = 不限下载次数 */
  max_downloads: number | null
  download_count: number
  access_count: number
  preview_only: boolean
  revoked: boolean
  created_by: string | null
  created_at: string
}

export type ShareCreateReq = {
  resource_type: ShareResourceType
  resource_id: string
  /** 空/省略 = 不设密码 */
  password?: string | null
  /** 省略字段 = 默认 7 天；null = 永久有效；n = n 天（1–3650） */
  expires_in_days?: number | null
  /** null/省略 = 不限；n ≥ 1 */
  max_downloads?: number | null
  preview_only?: boolean
}

export type ShareOut = {
  share: Share
  url: string
}

export type ShareListOut = {
  shares: Share[]
}

/** 公开分享元信息（camelCase，未鉴权）。 */
export type PublicShareMeta = {
  resourceType: ShareResourceType
  resourceId: string
  name: string
  hasPassword: boolean
  /** 过期但链接仍可达时返回 expired（meta 不 410） */
  status: 'ok' | 'expired'
  previewOnly: boolean
  expiresAt: string | null
  maxDownloads: number | null
  downloadCount: number
  /** 仅文件分享返回；目录分享为 null */
  size: number | null
  updatedAt: string | null
  currentVersion: number | null
}

// ---------------- M3：目录网站发布 ----------------

export type PublishPolicy = 'anon' | 'login' | 'preview_only'

export type PublishedDir = {
  id: string
  directory_id: string
  publish_id: string
  enabled: boolean
  policy: PublishPolicy
  created_by: string | null
  created_at: string
  updated_at: string
}

/** POST /directories/{id}/publish 启用响应。 */
export type PublishOut = {
  publish: PublishedDir
  /** 配置了 VIENTO_PUBLISH_DOMAIN 时为 https://{publish_id}.{domain}/，否则 null */
  url: string | null
}

/** GET /directories/{id}/publish 查询响应（从未发布时 publish 为 null）。 */
export type PublishGetOut = {
  publish: PublishedDir | null
  url: string | null
}

export type PublishEnableReq = {
  policy: PublishPolicy
}

/** 公开站点元信息（camelCase，未鉴权；login 策略需 Bearer JWT）。 */
export type PublicPublishMeta = {
  name: string
  publishId: string
  policy: PublishPolicy
  directoryId: string
}

/** 公开站点条目（与目录页 Entry 同形，但文件项无 lock）。 */
export type PublicEntry =
  | { kind: 'directory'; directory: Directory }
  | { kind: 'file'; file: FileMeta }

// ---------------- M3：文件名搜索 ----------------

export type SearchQuery = {
  q: string
  limit?: number
}

// ---------------- M4：通知中心 ----------------

export type NotificationQuery = {
  limit?: number
}

export type SearchHit = {
  /** 所属目录面包屑路径（" / " 连接，根目录显示"根目录"） */
  directoryPath: string
  id: string
  /** 是否文件名前缀匹配（排序优先级高于相似度） */
  isPrefixMatch: boolean
  mime: string
  name: string
  /** pg_trgm 相似度，0–1 原始浮点（前缀命中且无相似计算时可为 0） */
  similarity: number
  size: number
  updatedAt: string
}

export type LoginResp = {
  token: string
  expires_in: number
  user: User
}

export type OkResp = {
  ok: boolean
}

// ---------------- 请求体 ----------------

export type BootstrapReq = {
  username: string
  display_name?: string
  password: string
}

export type LoginReq = {
  username: string
  password: string
}

export type CreateUserReq = {
  username: string
  display_name?: string
  password: string
  role?: Role
}

export type UpdateUserReq = {
  display_name?: string
  role?: Role
  disabled?: boolean
}

export type SetPasswordReq = {
  password: string
}

export type CreateTeamReq = {
  name: string
}

export type UpdateTeamReq = {
  name?: string
}

export type AddMemberReq = {
  user_id: string
}

export type CreateDirReq = {
  parent_id: string
  name: string
}

export type RenameDirReq = {
  name: string
}

export type MoveDirReq = {
  target_parent_id: string
}

export type SetGrantReq = {
  principal_type: PrincipalType
  principal_id: string
  perms: number
}

export type SaveFileReq = FormData

export type MoveFileReq = {
  target_directory_id: string
  new_name?: string
}

export type CopyFileReq = {
  target_directory_id: string
  new_name?: string
}

export type UnlockReq = {
  force?: boolean
}

export type RestoreRenameReq = {
  new_name: string
}

export type RenameFileReq = {
  new_name: string
}

export type VersionsQuery = {
  limit?: number
  offset?: number
}

export type AuditListQuery = {
  category?: string
  action?: string
  actor_id?: string
  limit?: number
  offset?: number
}

/** 团队详情（GET /teams/{team_id}?with_members=true）。 */
export type TeamDetail = {
  team: Team
  members: User[]
}

// ---------------- 路由表 ----------------
// 每个条目：query / params / body / headers / response 五键齐全，未使用写 any。

type IdParams = { id: string }
type TeamIdParams = { team_id: string }
type GrantParams = { id: string; ptype: PrincipalType; pid: string }
type VersionParams = { id: string; version: number }

/** 桌面外观设置（GET/PUT /settings/desktop，整对象读写）。 */
export type DesktopSettings = {
  theme_mode: 'auto' | 'light' | 'dark'
  wallpaper: string
  accent_color: string | null
}

export type OpenAPIs = {
  get: {
    '/api/v1/auth/me': { query: any; params: any; body: any; headers: any; response: AuthUser }
    '/api/v1/users': { query: any; params: any; body: any; headers: any; response: User[] }
    '/api/v1/users/{id}': { query: any; params: IdParams; body: any; headers: any; response: User }
    '/api/v1/teams': { query: any; params: any; body: any; headers: any; response: Team[] }
    '/api/v1/teams/{team_id}': { query: any; params: TeamIdParams; body: any; headers: any; response: TeamDetail }
    '/api/v1/audits': { query: AuditListQuery; params: any; body: any; headers: any; response: AuditEntry[] }
    '/api/v1/notifications': { query: NotificationQuery; params: any; body: any; headers: any; response: AuditEntry[] }
    '/api/v1/directories/root': { query: any; params: any; body: any; headers: any; response: DirectoryPage }
    '/api/v1/directories/{id}': { query: any; params: IdParams; body: any; headers: any; response: DirectoryPage }
    '/api/v1/directories/{id}/grants': { query: any; params: IdParams; body: any; headers: any; response: { grants: GrantItem[] } }
    '/api/v1/trash/directories': { query: any; params: any; body: any; headers: any; response: TrashedDirectory[] }
    '/api/v1/trash/files': { query: any; params: any; body: any; headers: any; response: TrashedFile[] }
    '/api/v1/files/{id}': { query: any; params: IdParams; body: any; headers: any; response: FileOut }
    '/api/v1/files/{id}/versions': { query: VersionsQuery; params: IdParams; body: any; headers: any; response: VersionInfo[] }
    // 二进制内容：客户端不解析非 JSON，实际经 raw fetch 下载，见 api/index.ts 的 fetchFileContent。
    '/api/v1/files/{id}/content': { query: any; params: IdParams; body: any; headers: any; response: Response }
    // M2.15：zip 包内条目列表（二进制 zip-entry 经 raw fetch，见 fetchFileContent）
    '/api/v1/files/{id}/zip': { query: any; params: IdParams; body: any; headers: any; response: ZipListOut }
    '/api/v1/shares': { query: { resource_type: string; resource_id: string }; params: any; body: any; headers: any; response: ShareListOut }
    '/api/v1/directories/{id}/publish': { query: any; params: IdParams; body: any; headers: any; response: PublishGetOut }
    '/api/v1/search': { query: SearchQuery; params: any; body: any; headers: any; response: SearchHit[] }
    '/api/v1/users/ldap/config': { query: any; params: any; body: any; headers: any; response: LdapConfigInfo }
    '/api/v1/settings/desktop': { query: any; params: any; body: any; headers: any; response: DesktopSettings }
  }
  post: {
    '/api/v1/auth/bootstrap': { query: any; params: any; body: BootstrapReq; headers: any; response: LoginResp }
    '/api/v1/auth/login': { query: any; params: any; body: LoginReq; headers: any; response: LoginResp }
    '/api/v1/users': { query: any; params: any; body: CreateUserReq; headers: any; response: User }
    '/api/v1/users/{id}/password': { query: any; params: IdParams; body: SetPasswordReq; headers: any; response: OkResp }
    // LDAP 导入无请求体（配置全部来自服务端环境变量）
    '/api/v1/users/ldap/import': { query: any; params: any; body: any; headers: any; response: LdapImportResult }
    '/api/v1/users/ldap/test': { query: any; params: any; body: LdapTestReq; headers: any; response: LdapTestResult }
    '/api/v1/teams': { query: any; params: any; body: CreateTeamReq; headers: any; response: Team }
    '/api/v1/teams/{team_id}/members': { query: any; params: TeamIdParams; body: AddMemberReq; headers: any; response: Team }
    '/api/v1/directories': { query: any; params: any; body: CreateDirReq; headers: any; response: Directory }
    '/api/v1/directories/{id}/rename': { query: any; params: IdParams; body: RenameDirReq; headers: any; response: Directory }
    '/api/v1/directories/{id}/move': { query: any; params: IdParams; body: MoveDirReq; headers: any; response: Directory }
    '/api/v1/directories/{id}/restore': { query: any; params: IdParams; body: any; headers: any; response: Directory }
    '/api/v1/directories/{id}/files': { query: any; params: IdParams; body: SaveFileReq; headers: any; response: FileMeta }
    '/api/v1/files/{id}/save': { query: any; params: IdParams; body: SaveFileReq; headers: any; response: FileMeta }
    '/api/v1/files/{id}/lock': { query: any; params: IdParams; body: any; headers: any; response: { locked: true } }
    '/api/v1/files/{id}/unlock': { query: any; params: IdParams; body: UnlockReq; headers: any; response: OkResp }
    '/api/v1/files/{id}/restore': { query: any; params: IdParams; body: any; headers: any; response: FileMeta }
    '/api/v1/files/{id}/restore/rename': { query: any; params: IdParams; body: RestoreRenameReq; headers: any; response: FileMeta }
    '/api/v1/files/{id}/versions/{version}/restore': { query: any; params: VersionParams; body: any; headers: any; response: FileMeta }
    '/api/v1/files/{id}/move': { query: any; params: IdParams; body: MoveFileReq; headers: any; response: FileMeta }
    '/api/v1/files/{id}/copy': { query: any; params: IdParams; body: CopyFileReq; headers: any; response: FileMeta }
    '/api/v1/files/{id}/rename': { query: any; params: IdParams; body: RenameFileReq; headers: any; response: FileMeta }
    '/api/v1/shares': { query: any; params: any; body: ShareCreateReq; headers: any; response: ShareOut }
    '/api/v1/shares/{id}/revoke': { query: any; params: IdParams; body: any; headers: any; response: OkResp }
    '/api/v1/directories/{id}/publish': { query: any; params: IdParams; body: PublishEnableReq; headers: any; response: PublishOut }
  }
  put: {
    '/api/v1/directories/{id}/grants': { query: any; params: IdParams; body: SetGrantReq; headers: any; response: { ok: boolean; perms: number } }
    '/api/v1/settings/desktop': { query: any; params: any; body: Partial<DesktopSettings>; headers: any; response: DesktopSettings }
    '/api/v1/users/ldap/config': { query: any; params: any; body: LdapConfigUpdate; headers: any; response: LdapConfigInfo }
  }
  patch: {
    '/api/v1/users/{id}': { query: any; params: IdParams; body: UpdateUserReq; headers: any; response: User }
    '/api/v1/teams/{team_id}': { query: any; params: TeamIdParams; body: UpdateTeamReq; headers: any; response: Team }
  }
  delete: {
    '/api/v1/teams/{team_id}': { query: any; params: TeamIdParams; body: any; headers: any; response: OkResp }
    '/api/v1/teams/{team_id}/members/{user_id}': { query: any; params: TeamIdParams & { user_id: string }; body: any; headers: any; response: OkResp }
    '/api/v1/directories/{id}': { query: any; params: IdParams; body: any; headers: any; response: OkResp }
    '/api/v1/directories/{id}/grants/{ptype}/{pid}': { query: any; params: GrantParams; body: any; headers: any; response: OkResp }
    '/api/v1/files/{id}': { query: any; params: IdParams; body: any; headers: any; response: OkResp }
    '/api/v1/files/{id}/purge': { query: any; params: IdParams; body: any; headers: any; response: OkResp }
    '/api/v1/directories/{id}/publish': { query: any; params: IdParams; body: any; headers: any; response: OkResp }
    '/api/v1/users/ldap/config': { query: any; params: any; body: any; headers: any; response: { ok: boolean; deleted: boolean } }
  }
}
