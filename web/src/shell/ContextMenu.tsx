/**
 * 通用右键菜单：store 持有当前菜单，ContextMenuHost 渲染（玻璃面板，贴边自适应）。
 * 桌面/码头/图标均通过 useContextMenu().show(x, y, items) 弹出。
 * M2.22：showAbove(cx, topY, items) 支持"锚定在图标上方"的 flyout 模式
 * （dock 窗口选择菜单）：水平居中于锚点、底部带指向锚点的小箭头，
 * 越屏时菜单收回、箭头仍指向锚点 —— 对齐 Windows/mac 任务栏交互。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { create } from 'zustand'

export type CtxItem =
  | { key: string; label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }
  | { key: string; divider: true }

type CtxPlacement =
  | { kind: 'cursor'; x: number; y: number }
  // kind: 'above' —— x = 锚点水平中心，y = 锚点顶边（flyout 显示在锚点上方）
  | { kind: 'above'; x: number; y: number }

type CtxStore = {
  open: { placement: CtxPlacement; items: CtxItem[] } | null
  show: (x: number, y: number, items: CtxItem[]) => void
  showAbove: (x: number, y: number, items: CtxItem[]) => void
  hide: () => void
}

export const useContextMenu = create<CtxStore>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { placement: { kind: 'cursor', x, y }, items } }),
  showAbove: (x, y, items) => set({ open: { placement: { kind: 'above', x, y }, items } }),
  hide: () => set({ open: null }),
}))

const EST_ITEM_H = 32
const EST_PAD = 12
const EDGE_MARGIN = 8

export const ContextMenuHost = () => {
  const open = useContextMenu((s) => s.open)
  const hide = useContextMenu((s) => s.hide)
  const ref = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  const [caret, setCaret] = useState(0)

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

  // M2.22：flyout 先按锚点居中，渲染后若越屏则平移收回，箭头始终指向锚点。
  // 位移由"未平移基准位 + 当前宽度"推出（不读已平移后的 rect），保证幂等不抖动。
  useLayoutEffect(() => {
    if (!open || open.placement.kind !== 'above' || !ref.current) return
    const w = ref.current.offsetWidth
    const base = open.placement.x - w / 2
    let s = 0
    if (base < EDGE_MARGIN) s = EDGE_MARGIN - base
    else if (base + w > window.innerWidth - EDGE_MARGIN) s = window.innerWidth - EDGE_MARGIN - (base + w)
    setShift(s)
    setCaret(open.placement.x - (base + s))
  }, [open])

  if (!open) return null
  const estH = open.items.length * EST_ITEM_H + EST_PAD
  let style: CSSProperties
  let cls = 'vd-ctx'
  if (open.placement.kind === 'above') {
    style = {
      left: open.placement.x,
      top: Math.max(4, open.placement.y - estH - 14),
      transform: `translateX(calc(-50% + ${shift}px))`,
    }
    cls = 'vd-ctx vd-ctx-above'
  } else {
    style = {
      left: Math.max(4, Math.min(open.placement.x, window.innerWidth - 200)),
      top: Math.max(4, Math.min(open.placement.y, window.innerHeight - estH - 4)),
    }
  }
  return (
    <div ref={ref} className={cls} style={style}>
      {open.placement.kind === 'above' && <div className="vd-ctx-caret" style={{ left: `${caret}px` }} />}
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
