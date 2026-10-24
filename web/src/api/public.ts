import type { PublicPublishMeta, PublicShareMeta, PublicEntry } from './schema'

/**
 * 公开（未鉴权）API 客户端：/api/v1/public/*。
 *
 * 不走 o2t client（无全局 401 拦截），分享密码经 X-Share-Password 头传递，
 * 发布站点 login 策略经 Authorization: Bearer 传递（token 由调用方在内存中管理）。
 */

/** 公开 API 错误，携带 HTTP 状态与业务错误码。 */
export class PublicApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PublicApiError'
    this.status = status
    this.code = code
  }
}

async function parseError(res: Response): Promise<PublicApiError> {
  let code = `HTTP_${res.status}`
  let message = `请求失败（${res.status}）`
  try {
    const body = (await res.clone().json()) as {
      error?: { code?: string; message?: string }
      code?: string
      message?: string
    }
    code = body.error?.code ?? body.code ?? code
    message = body.error?.message ?? body.message ?? message
  } catch {
    // 非 JSON 响应体，保留默认提示
  }
  return new PublicApiError(res.status, code, message)
}

async function request(
  url: string,
  init: RequestInit,
  opts: { password?: string; bearerToken?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (opts.password) headers.set('X-Share-Password', opts.password)
  if (opts.bearerToken) headers.set('Authorization', `Bearer ${opts.bearerToken}`)
  const res = await fetch(url, { ...init, headers, credentials: 'omit' })
  if (!res.ok) throw await parseError(res)
  return res
}

// ---------------- 公开分享 ----------------

/** 获取分享元信息（未校验密码）。 */
export function getPublicShareMeta(token: string): Promise<PublicShareMeta> {
  return request(`/api/v1/public/shares/${encodeURIComponent(token)}`, {}).then((r) =>
    r.json() as Promise<PublicShareMeta>,
  )
}

/** 校验分享访问密码；成功后后续调用需携带 password。 */
export async function verifyPublicSharePassword(token: string, password: string): Promise<boolean> {
  const res = await request(
    `/api/v1/public/shares/${encodeURIComponent(token)}/verify`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) },
  )
  const body = (await res.json()) as { ok: boolean }
  return body.ok
}

/** 列目录条目；file 类型分享调用将得到 400。 */
export async function getPublicShareEntries(
  token: string,
  dirId: string,
  password?: string,
): Promise<PublicEntry[]> {
  const res = await request(
    `/api/v1/public/shares/${encodeURIComponent(token)}/entries?dir_id=${encodeURIComponent(dirId)}`,
    {},
    { password },
  )
  return (await res.json()) as PublicEntry[]
}

/** 文件预览（原始字节，未鉴权公开接口，带密码头）。 */
export function getPublicShareFilePreview(token: string, fileId: string, password?: string) {
  return request(
    `/api/v1/public/shares/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/preview`,
    {},
    { password },
  )
}

/** 文件下载（原始字节）。 */
export function getPublicShareFileDownload(token: string, fileId: string, password?: string) {
  return request(
    `/api/v1/public/shares/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/download`,
    {},
    { password },
  )
}

// ---------------- 目录网站发布 ----------------

/** 获取站点元信息；410 → PublicApiError(code=PUBLISH_DISABLED)。 */
export function getPublicPublishMeta(publishId: string, bearerToken?: string): Promise<PublicPublishMeta> {
  return request(`/api/v1/public/published/${encodeURIComponent(publishId)}`, {}, { bearerToken }).then(
    (r) => r.json() as Promise<PublicPublishMeta>,
  )
}

/** 列目录条目（包装为 {entries: [...]}）。 */
export async function getPublicPublishEntries(
  publishId: string,
  dirId: string,
  bearerToken?: string,
): Promise<PublicEntry[]> {
  const res = await request(
    `/api/v1/public/published/${encodeURIComponent(publishId)}/entries?dir_id=${encodeURIComponent(dirId)}`,
    {},
    { bearerToken },
  )
  const body = (await res.json()) as { entries: PublicEntry[] }
  return body.entries
}

/** 文件预览（原始字节）。 */
export function getPublicPublishFilePreview(publishId: string, fileId: string, bearerToken?: string) {
  return request(
    `/api/v1/public/published/${encodeURIComponent(publishId)}/files/${encodeURIComponent(fileId)}/preview`,
    {},
    { bearerToken },
  )
}

/** 文件下载（原始字节）。 */
export function getPublicPublishFileDownload(publishId: string, fileId: string, bearerToken?: string) {
  return request(
    `/api/v1/public/published/${encodeURIComponent(publishId)}/files/${encodeURIComponent(fileId)}/download`,
    {},
    { bearerToken },
  )
}
