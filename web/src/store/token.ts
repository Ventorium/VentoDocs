const TOKEN_KEY = 'user.access_token'

let expiredHandler: (() => void) | null = null

export function setExpiredHandler(cb: (() => void) | null): void {
  expiredHandler = cb
}

export function getAccessToken(): string | null {
  // 优先从 URL 参数中获取 token（?token= 直达入口）
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

/** Token 失效统一出口：清 token 并跳登录页（SPA 内走注册的处理，未注册时整页跳转） */
export function onExpired(): void {
  clearToken()
  if (expiredHandler) {
    expiredHandler()
  } else {
    window.location.href = '/auth/login'
  }
}
