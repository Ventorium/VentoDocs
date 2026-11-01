import { client } from '@/api'
import { create } from 'zustand'
import { getAccessToken, setAccessToken, onExpired } from './token'

export type AuthUser = {
  id: string
  username: string
  display_name: string
  role: 'admin' | 'user'
  auth_provider: 'local' | 'ldap'
  disabled: boolean
  created_at: string
  /** 个人配额（字节，null = 不限制）与当前占用（M2.43；/auth/me 返回，用于上传预检）。 */
  quota_bytes?: number | null
  used_bytes?: number
}

export type LoginForm = { username: string; password: string }

export type AuthState = {
  user: AuthUser | null
  ready: boolean
  loading: boolean
  computed: {
    logged: boolean
    role: 'admin' | 'user'
  }
  init: () => Promise<void>
  login: (args: LoginForm) => Promise<AuthUser | null>
  logout: () => void
  refreshMe: () => Promise<AuthUser | null>
}

async function fetchMe() {
  const { error, data } = await client.get('/api/v1/auth/me')
  return { user: (error ? null : data) as AuthUser | null, error }
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  loading: false,
  computed: {
    get logged() {
      return !!get().user
    },
    get role() {
      return get().user?.role ?? 'user'
    }
  },
  async init() {
    if (get().loading) return
    set({ loading: true })
    const accessToken = getAccessToken()
    if (accessToken) {
      const { user } = await fetchMe()
      set({ user })
    }
    set({ loading: false, ready: true })
  },
  async login(args) {
    const { error, data } = await client.post('/api/v1/auth/login', { body: args })
    if (!error && data) {
      setAccessToken(data.token)
      set({ user: data.user })
      // 登录响应不含配额字段：补一次 /auth/me，供上传前配额预检使用
      void get().refreshMe()
      return data.user
    }
    return null
  },
  async refreshMe() {
    const { user } = await fetchMe()
    set({ user })
    if (!user) {
      onExpired()
    }
    return user
  },
  logout() {
    // M2.41：先让服务端吊销（token_version 自增），再清本地；失败也照常本地登出
    void client.post('/api/v1/auth/logout', { body: undefined }).catch(() => undefined)
    set({ user: null })
    onExpired()
  }
}))
