/**
 * 窗口内核（M2）：桌面窗口集合管理。
 * - windows 数组顺序 = z 序（最后一个在最前）
 * - 单窗口应用重开 = 聚焦 + 替换 appState（URL 是唯一状态来源）
 * - multiWindow 应用按 appState.fileId 一窗一档
 * - positions 仅持久化窗口几何（localStorage），不持久化打开的窗口
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

type Store = {
  windows: WinState[]
  /** 拖拽/缩放中：抑制 CSS 过渡 */
  dragging: boolean
  /** 窗口几何记忆（按窗口键），刷新后沿用上次位置 */
  positions: Record<string, WinRect>
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
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const maxRect = (): WinRect => ({
  x: 0,
  y: TOPBAR_H,
  w: window.innerWidth,
  h: window.innerHeight - TOPBAR_H,
})

export const useWindows = create<Store>()(
  persist(
    (set, get) => ({
      windows: [],
      dragging: false,
      positions: {},

      open: (appId, appState = {}) => {
        const meta = appMeta(appId)
        if (!meta) return ''
        const id = windowKey(appId, appState)
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
        const saved = meta.multiWindow ? positions[id] : positions[appId]
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
    }),
    {
      name: 'vk-win-positions-v1',
      partialize: (s) => ({ positions: s.positions }),
    },
  ),
)
