import { globalNavigate } from '@/components/GlobalHistory'

const TOKEN_KEY = 'user.access_token'

export function getAccessToken(): string | null {
  // 优先从 URL 参数中获取 token
  const urlParams = new URLSearchParams(window.location.search)
  const urlToken = urlParams.get('token')
  if (urlToken) {
    setAccessToken(urlToken)
    // 清除 URL 中的 token 参数
    urlParams.delete('token')
    const newUrl = window.location.pathname + (urlParams.toString() ? `?${urlParams.toString()}` : '')
    window.history.replaceState({}, '', newUrl)
    return urlToken
  }
  return localStorage.getItem(TOKEN_KEY)
}

export function setAccessToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** Token 失效统一出口：清 token 并跳登录页（供 api 层 401 拦截与 useAuth 复用） */
export function onExpired(): void {
  clearToken()
  globalNavigate('/auth/login', { replace: true })
}
