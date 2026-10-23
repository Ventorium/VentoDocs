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
}

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

/** 目录子项（serde tag = "kind"）。 */
export type Entry =
  | { kind: 'directory'; directory: Directory }
  | { kind: 'file'; file: FileMeta }

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
}

export type LdapImportRow = {
  username: string
  display_name?: string
}

export type LdapImportResult = {
  created: string[]
  skipped: string[]
  failed: string[]
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

export type LdapImportReq = {
  users: LdapImportRow[]
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
  parent_id: string
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

export type VersionsQuery = {
  limit?: number
  offset?: number
}

// ---------------- 路由表 ----------------
// 每个条目：query / params / body / headers / response 五键齐全，未使用写 any。

type IdParams = { id: string }
type TeamIdParams = { team_id: string }
type GrantParams = { id: string; ptype: PrincipalType; pid: string }
type VersionParams = { id: string; version: number }

export type OpenAPIs = {
  get: {
    '/api/v1/auth/me': { query: any; params: any; body: any; headers: any; response: AuthUser }
    '/api/v1/users': { query: any; params: any; body: any; headers: any; response: User[] }
    '/api/v1/users/{id}': { query: any; params: IdParams; body: any; headers: any; response: User }
    '/api/v1/teams': { query: any; params: any; body: any; headers: any; response: Team[] }
    '/api/v1/teams/{team_id}': { query: any; params: TeamIdParams; body: any; headers: any; response: Team }
    '/api/v1/directories/root': { query: any; params: any; body: any; headers: any; response: DirectoryPage }
    '/api/v1/directories/{id}': { query: any; params: IdParams; body: any; headers: any; response: DirectoryPage }
    '/api/v1/directories/{id}/grants': { query: any; params: IdParams; body: any; headers: any; response: { grants: GrantItem[] } }
    '/api/v1/trash/directories': { query: any; params: any; body: any; headers: any; response: Directory[] }
    '/api/v1/trash/files': { query: any; params: any; body: any; headers: any; response: FileMeta[] }
    '/api/v1/files/{id}': { query: any; params: IdParams; body: any; headers: any; response: FileOut }
    '/api/v1/files/{id}/versions': { query: VersionsQuery; params: IdParams; body: any; headers: any; response: VersionInfo[] }
    // 二进制内容：客户端不解析非 JSON，实际经 raw fetch 下载，见 api/index.ts 的 fetchFileContent。
    '/api/v1/files/{id}/content': { query: any; params: IdParams; body: any; headers: any; response: Response }
  }
  post: {
    '/api/v1/auth/bootstrap': { query: any; params: any; body: BootstrapReq; headers: any; response: LoginResp }
    '/api/v1/auth/login': { query: any; params: any; body: LoginReq; headers: any; response: LoginResp }
    '/api/v1/users': { query: any; params: any; body: CreateUserReq; headers: any; response: User }
    '/api/v1/users/{id}/password': { query: any; params: IdParams; body: SetPasswordReq; headers: any; response: OkResp }
    '/api/v1/users/ldap/import': { query: any; params: any; body: LdapImportReq; headers: any; response: LdapImportResult }
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
  }
  put: {
    '/api/v1/directories/{id}/grants': { query: any; params: IdParams; body: SetGrantReq; headers: any; response: { ok: boolean; perms: number } }
  }
  patch: {
    '/api/v1/users/{id}': { query: any; params: IdParams; body: UpdateUserReq; headers: any; response: User }
    '/api/v1/teams/{team_id}': { query: any; params: TeamIdParams; body: UpdateTeamReq; headers: any; response: Team }
  }
  delete: {
    '/api/v1/teams/{team_id}/members/{user_id}': { query: any; params: TeamIdParams & { user_id: string }; body: any; headers: any; response: OkResp }
    '/api/v1/directories/{id}': { query: any; params: IdParams; body: any; headers: any; response: OkResp }
    '/api/v1/directories/{id}/grants/{ptype}/{pid}': { query: any; params: GrantParams; body: any; headers: any; response: OkResp }
    '/api/v1/files/{id}/purge': { query: any; params: IdParams; body: any; headers: any; response: OkResp }
  }
}
