import { createFetchClient } from '@doremijs/o2t/client'
import { msg } from '@/components/GlobalMessage'
import { getAccessToken, onExpired } from '@/store/token'
import type { OpenAPIs } from './schema'

const PUBLIC_PATHS = ['/api/v1/auth/login', '/api/v1/auth/bootstrap']

export const client = createFetchClient<OpenAPIs>({
  requestTimeoutMs: 10000,
  requestInterceptor(request) {
    const token = getAccessToken()
    if (!PUBLIC_PATHS.includes(request.url) && token) {
      request.init.headers.Authorization = `Bearer ${token}`
    }
    return request
  },
  async responseInterceptor(request, response) {
    if (response?.status === 401 && !PUBLIC_PATHS.includes(request.url)) {
      onExpired()
    }
    return response
  },
  async errorHandler(_request, response, error) {
    if (error) {
      msg.error(error.message || '网络错误')
    } else {
      let detail = '服务器错误'
      try {
        const contentType = response?.headers.get('content-type')
        if (contentType?.includes('application/json')) {
          const resp = await response?.clone().json()
          detail = resp?.error?.message || '服务器错误'
        }
      } catch {
        // 保留默认提示
      }
      if (response?.status !== 401) {
        msg.error(detail)
      }
    }
  }
})

/** 下载文件内容（二进制，绕过 JSON 客户端）。 */
export async function fetchFileContent(fileId: string): Promise<Response> {
  const token = getAccessToken()
  const response = await fetch(`/api/v1/files/${fileId}/content`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  if (!response.ok) {
    let detail = '文件下载失败'
    try {
      if (response.headers.get('content-type')?.includes('application/json')) {
        detail = (await response.json())?.error?.message || detail
      }
    } catch {
      // 保留默认提示
    }
    if (response.status === 401) {
      onExpired()
    } else {
      msg.error(detail)
    }
    throw new Error(detail)
  }
  return response
}
