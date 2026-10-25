/**
 * 桌面设置 store（zustand）。
 *
 * 本地立即生效；变更经 500ms 防抖后 PUT /api/v1/settings/desktop 全量对象同步（借鉴 VentoOS）。
 * 解析主题写入 <html data-theme>，驱动 app.css 的 --vd-* 变量与 antd 算法。
 */

import { client } from '@/api'
import type { DesktopSettings } from '@/api/schema'
import { create } from 'zustand'

export type ThemeMode = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'auto') {
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return mode
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved
}

let _syncTimer: ReturnType<typeof setTimeout> | null = null
const SYNC_DEBOUNCE_MS = 500

interface SettingsState {
  loaded: boolean
  themeMode: ThemeMode
  wallpaper: string
  accentColor: string | null
  resolvedTheme: ResolvedTheme
  setThemeMode: (mode: ThemeMode) => void
  setWallpaper: (url: string) => void
  setAccentColor: (color: string | null) => void
  /** 启动时从后端加载（需已登录；失败则静默使用默认值）。 */
  loadFromBackend: () => Promise<void>
}

export const useSettings = create<SettingsState>()((set, get) => {
  function scheduleSync() {
    if (_syncTimer) clearTimeout(_syncTimer)
    _syncTimer = setTimeout(async () => {
      const { themeMode, wallpaper, accentColor } = get()
      try {
        await client.put('/api/v1/settings/desktop', {
          body: {
            theme_mode: themeMode,
            wallpaper,
            ...(accentColor !== null ? { accent_color: accentColor } : {})
          }
        })
      } catch {
        // 同步失败不打断本地 UI（client errorHandler 已弹错误提示）
      }
    }, SYNC_DEBOUNCE_MS)
  }

  return {
    loaded: false,
    themeMode: 'light',
    wallpaper: '',
    accentColor: null,
    resolvedTheme: 'light',

    setThemeMode(mode) {
      const resolvedTheme = resolveTheme(mode)
      set({ themeMode: mode, resolvedTheme })
      applyTheme(resolvedTheme)
      scheduleSync()
    },

    setWallpaper(url) {
      set({ wallpaper: url })
      scheduleSync()
    },

    setAccentColor(color) {
      set({ accentColor: color })
      scheduleSync()
    },

    async loadFromBackend() {
      if (get().loaded) return
      const { error, data } = await client.get('/api/v1/settings/desktop')
      if (error || !data) {
        const resolvedTheme = resolveTheme(get().themeMode)
        set({ loaded: true, resolvedTheme })
        applyTheme(resolvedTheme)
        return
      }
      const d = data as DesktopSettings
      const themeMode: ThemeMode =
        d.theme_mode === 'dark' || d.theme_mode === 'auto' ? d.theme_mode : 'light'
      const resolvedTheme = resolveTheme(themeMode)
      set({
        loaded: true,
        themeMode,
        wallpaper: d.wallpaper ?? '',
        accentColor: d.accent_color ?? null,
        resolvedTheme
      })
      applyTheme(resolvedTheme)
    }
  }
})
