/**
 * 通用右键菜单：store 持有当前菜单，ContextMenuHost 渲染（玻璃面板，贴边自适应）。
 * 桌面/码头/图标均通过 useContextMenu().show(x, y, items) 弹出。
 */
import { useEffect, type ReactNode } from 'react'
import { create } from 'zustand'

export type CtxItem =
  | { key: string; label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }
  | { key: string; divider: true }

type CtxStore = {
  open: { x: number; y: number; items: CtxItem[] } | null
  show: (x: number, y: number, items: CtxItem[]) => void
  hide: () => void
}

export const useContextMenu = create<CtxStore>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  hide: () => set({ open: null }),
}))

export const ContextMenuHost = () => {
  const open = useContextMenu((s) => s.open)
  const hide = useContextMenu((s) => s.hide)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest('.vd-ctx')) return
      hide()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = () => hide()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, hide])

  if (!open) return null
  const estH = open.items.length * 32 + 12
  const top = Math.max(4, Math.min(open.y, window.innerHeight - estH - 4))
  const left = Math.max(4, Math.min(open.x, window.innerWidth - 200))
  return (
    <div className="vd-ctx" style={{ left, top }}>
      {open.items.map((it) =>
        'divider' in it ? (
          <div key={it.key} className="vd-ctx-div" />
        ) : (
          <div
            key={it.key}
            className={`vd-ctx-item${it.danger ? ' danger' : ''}`}
            onClick={() => {
              hide()
              it.onClick()
            }}
          >
            {it.icon}
            {it.label}
          </div>
        ),
      )}
    </div>
  )
}
