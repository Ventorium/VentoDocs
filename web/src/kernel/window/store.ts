/**
 * 窗口内核（M2.19）：桌面窗口集合管理。
 * - windows 数组顺序 = z 序（最后一个在最前）
 * - 单窗口应用重开 = 聚焦 + 替换 appState
 * - multiWindow 应用按 appState.fileId 一窗一档
 * - multiInstance 应用（M2.20，文件管理器）每次打开新建窗口，唯一键打开时生成并持久化
 * - 桌面状态（打开的窗口 + 几何 + appState）持久化到 localStorage，
 *   按用户隔离（vk-win-desktop-v1:{userId}）：登录时由 App 调 bindUser 载入，
 *   登出清空；恢复时校验 appId / 收敛几何 / 最大化按当前视口重排。
 *   兼容旧键 vk-win-positions-v1（仅几何）的一次性迁移。
 */
import { create } from 'zustand'
import { appMeta } from '@/shell/apps/manifest'

export type WinRect = { x: number; y: number; w: number; h: number }
export type WinAppState = Record<string, string>

export type WinState = {
  id: string
  appId: string
  title: string
  rect: WinRect
  /** 最大化前几何，用于还原 */
  prevRect?: WinRect
  minimized: boolean
  maximized: boolean
  appState: WinAppState
}

/** 顶部栏高度（像素），窗口拖拽/最大化的边界（与 .vd-topbar 一致） */
export const TOPBAR_H = 28

/** 窗口唯一键：multiWindow 应用按 fileId 区分 */
export const windowKey = (appId: string, appState?: WinAppState): string => {
  const meta = appMeta(appId)
  if (meta?.multiWindow) return `${appId}:${appState?.fileId ?? 'new'}`
  return appId
}

/** M2.20：多实例应用窗口唯一键（打开时生成，持久化后按原 id 恢复） */
export const genWinId = (appId: string): string =>
  `${appId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

type Store = {
  windows: WinState[]
  /** 拖拽/缩放中：抑制 CSS 过渡 */
  dragging: boolean
  /** 窗口几何记忆（按窗口键），刷新后沿用上次位置 */
  positions: Record<string, WinRect>
  /** 当前绑定的登录用户 id：桌面状态按用户隔离持久化；null = 未绑定（只读不写） */
  _uid: string | null
  /** 打开窗口（已存在=聚焦+替换 appState）；返回窗口键 */
  open: (appId: string, appState?: WinAppState) => string
  focus: (id: string) => void
  close: (id: string) => void
  minimize: (id: string) => void
  restore: (id: string) => void
  toggleMaximize: (id: string) => void
  /** 拖拽/缩放过程中直接改几何（不记忆位置） */
  setRect: (id: string, rect: WinRect) => void
  /** 拖拽/缩放结束：写回几何并记忆位置 */
  saveRect: (id: string, rect: WinRect) => void
  setDragging: (v: boolean) => void
  setAppState: (id: string, appState: WinAppState) => void
  setTitle: (id: string, title: string) => void
  minimizeAll: () => void
  /** 绑定登录用户：载入该用户的桌面状态；null = 登出，清空内存状态（旧状态已写回） */
  bindUser: (uid: string | null) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const maxRect = (): WinRect => ({
  x: 0,
  y: TOPBAR_H,
  w: window.innerWidth,
  h: window.innerHeight - TOPBAR_H,
})

// ── 桌面状态持久化（按用户隔离，localStorage）──────────────────────

const DESKTOP_KEY_PREFIX = 'vk-win-desktop-v1:'
/** 旧版本（M2–M2.18）persist 中间件只存几何的键，用于一次性迁移 */
const LEGACY_KEY = 'vk-win-positions-v1'

const isRect = (r: unknown): r is WinRect => {
  if (!r || typeof r !== 'object') return false
  const q = r as Record<string, unknown>
  return (
    typeof q.x === 'number' &&
    typeof q.y === 'number' &&
    typeof q.w === 'number' &&
    typeof q.h === 'number'
  )
}

/** 校验并收敛一个持久化窗口：未知 appId 丢弃、几何收进视口、最大化按当前视口重排。 */
const sanitizeWindow = (raw: unknown): WinState | null => {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<WinState>
  if (typeof r.appId !== 'string') return null
  const meta = appMeta(r.appId)
  if (!meta) return null
  const appState: WinAppState = {}
  if (r.appState && typeof r.appState === 'object' && !Array.isArray(r.appState)) {
    for (const [k, v] of Object.entries(r.appState)) {
      if (typeof v === 'string' && v) appState[k] = v
    }
  }
  // M2.20：多实例应用保留创建时持久化的唯一键（windowKey 无法重建）
  const id = meta.multiInstance
    ? typeof r.id === 'string' && r.id
      ? r.id
      : genWinId(r.appId)
    : windowKey(r.appId, appState)
  const vw = window.innerWidth
  const vh = window.innerHeight
  let rect: WinRect = isRect(r.rect)
    ? { ...r.rect }
    : {
        x: 140,
        y: TOPBAR_H + 12,
        w: Math.min(meta.defaultSize.w, vw - 32),
        h: Math.min(meta.defaultSize.h, vh - TOPBAR_H - 96),
      }
  rect.w = Math.min(Math.max(rect.w, 200), Math.max(200, vw - 16))
  rect.h = Math.min(Math.max(rect.h, 150), Math.max(150, vh - TOPBAR_H - 24))
  rect.x = clamp(rect.x, -(rect.w - 80), Math.max(0, vw - rect.w))
  rect.y = clamp(rect.y, TOPBAR_H, Math.max(TOPBAR_H, vh - rect.h - 24))
  let prevRect: WinRect | undefined = isRect(r.prevRect) ? { ...r.prevRect } : undefined
  const maximized = r.maximized === true
  if (maximized) {
    prevRect = prevRect ?? { ...rect }
    rect = maxRect()
  }
  const title = typeof r.title === 'string' && r.title ? r.title : meta.name
  return {
    id,
    appId: r.appId,
    title,
    rect,
    prevRect,
    minimized: r.minimized === true,
    maximized,
    appState,
  }
}

const loadDesktop = (uid: string): { windows: WinState[]; positions: Record<string, WinRect> } => {
  const positions: Record<string, WinRect> = {}
  let rawWindows: unknown[] = []
  try {
    const raw = localStorage.getItem(DESKTOP_KEY_PREFIX + uid)
    if (raw) {
      const data = JSON.parse(raw) as { positions?: Record<string, unknown>; windows?: unknown }
      if (data.positions && typeof data.positions === 'object') {
        for (const [k, v] of Object.entries(data.positions)) {
          if (isRect(v)) positions[k] = v
        }
      }
      if (Array.isArray(data.windows)) rawWindows = data.windows
    }
  } catch {
    /* 损坏数据 → 按空处理 */
  }
  // 迁移：旧版本只持久化过几何（persist 包裹格式 { state: { positions } }）
  if (Object.keys(positions).length === 0) {
    try {
      const raw = localStorage.getItem(LEGACY_KEY)
      if (raw) {
        const data = JSON.parse(raw) as { state?: { positions?: Record<string, unknown> } }
        const p = data.state?.positions
        if (p && typeof p === 'object') {
          for (const [k, v] of Object.entries(p)) {
            if (isRect(v)) positions[k] = v
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  const windows: WinState[] = []
  const seen = new Set<string>()
  for (const raw of rawWindows) {
    const w = sanitizeWindow(raw)
    if (w && !seen.has(w.id)) {
      seen.add(w.id)
      windows.push(w)
    }
  }
  return { windows, positions }
}

export const useWindows = create<Store>()((set, get) => ({
  windows: [],
  dragging: false,
  positions: {},
  _uid: null,

  open: (appId, appState = {}) => {
    const meta = appMeta(appId)
    if (!meta) return ''
    // M2.20：multiInstance 应用每次打开新建窗口（唯一键新建，不会命中 existing）
    const id = meta.multiInstance ? genWinId(appId) : windowKey(appId, appState)
    const { windows, positions } = get()
    const existing = windows.find((w) => w.id === id)
    if (existing) {
      const updated: WinState = { ...existing, appState, minimized: false }
      set({ windows: [...windows.filter((w) => w.id !== id), updated] })
      return id
    }
    // 新窗口：级联偏移 + 视口内约束
    const n = windows.length
    const cascade = (n % 6) * 28
    const saved = meta.multiWindow || meta.multiInstance ? positions[id] : positions[appId]
    let rect: WinRect
    if (saved && saved.w > 100 && saved.h > 100) {
      rect = { ...saved }
    } else {
      const w = Math.min(meta.defaultSize.w, window.innerWidth - 32)
      const h = Math.min(meta.defaultSize.h, window.innerHeight - TOPBAR_H - 96)
      const x = clamp(140 + cascade, 16, Math.max(16, window.innerWidth - w - 16))
      const y = clamp(TOPBAR_H + 12 + cascade, TOPBAR_H, Math.max(TOPBAR_H, window.innerHeight - h - 96))
      rect = { x, y, w, h }
    }
    const win: WinState = {
      id,
      appId,
      title: meta.name,
      rect,
      minimized: false,
      maximized: false,
      appState,
    }
    set({ windows: [...get().windows, win] })
    return id
  },

  focus: (id) =>
    set((s) => {
      const w = s.windows.find((x) => x.id === id)
      if (!w) return s
      return { windows: [...s.windows.filter((x) => x.id !== id), w] }
    }),

  close: (id) => set((s) => ({ windows: s.windows.filter((w) => w.id !== id) })),

  minimize: (id) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
    })),

  restore: (id) =>
    set((s) => {
      const w = s.windows.find((x) => x.id === id)
      if (!w) return s
      const updated: WinState = { ...w, minimized: false }
      return { windows: [...s.windows.filter((x) => x.id !== id), updated] }
    }),

  toggleMaximize: (id) =>
    set((s) => ({
      windows: s.windows.map((w) => {
        if (w.id !== id) return w
        if (w.maximized) {
          return { ...w, maximized: false, rect: w.prevRect ?? w.rect, prevRect: undefined }
        }
        return { ...w, maximized: true, prevRect: w.rect, rect: maxRect() }
      }),
    })),

  setRect: (id, rect) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, rect, maximized: false } : w)),
    })),

  saveRect: (id, rect) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, rect } : w)),
      positions: { ...s.positions, [id]: rect },
    })),

  setDragging: (v) => set({ dragging: v }),

  setAppState: (id, appState) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, appState } : w)),
    })),

  setTitle: (id, title) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, title } : w)),
    })),

  minimizeAll: () =>
    set((s) => ({ windows: s.windows.map((w) => ({ ...w, minimized: true })) })),

  bindUser: (uid) => {
    if (uid === get()._uid) return
    persistNow() // 切用户前把上一位用户的状态写回（未绑定时是空操作）
    const next = uid ? loadDesktop(uid) : { windows: [], positions: {} }
    set({ _uid: uid, windows: next.windows, positions: next.positions })
  },
}))

// ── 写回：防抖 + 页面隐藏/卸载时强制落盘 ─────────────────────────

let saveTimer: number | undefined
const persistNow = () => {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer)
    saveTimer = undefined
  }
  const s = useWindows.getState()
  if (!s._uid) return
  try {
    localStorage.setItem(
      DESKTOP_KEY_PREFIX + s._uid,
      JSON.stringify({ positions: s.positions, windows: s.windows }),
    )
  } catch {
    /* localStorage 不可用 / 配额满：忽略 */
  }
}

useWindows.subscribe((s, prev) => {
  if (s.windows === prev.windows && s.positions === prev.positions) return
  saveTimer = window.setTimeout(persistNow, 300)
})
window.addEventListener('beforeunload', persistNow)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistNow()
})
