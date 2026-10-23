import { client } from '@/api'
import { create } from 'zustand'
import { globalNavigate } from '@/components/GlobalHistory'
import { getAccessToken, setAccessToken, clearToken, onExpired } from './token'

export type AuthUser = {
  id: string
  username: string
  display_name: string
  role: 'admin' | 'user'
  auth_provider: 'local' | 'ldap'
  disabled: boolean
  created_at: string
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
    set({ user: null })
    clearToken()
    globalNavigate('/auth/login', { replace: true })
  }
}))
