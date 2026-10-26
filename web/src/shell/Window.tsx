/**
 * 窗口框架（M2）：标题栏 + 红绿灯 + 拖拽 + 8 向缩放 + 最大化跟随视口。
 * 内容 = 直接渲染的应用组件（无独立路由）；最小化保持挂载（visibility 动画）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { BorderOuterOutlined, CloseOutlined, MinusOutlined } from '@ant-design/icons'
import { TOPBAR_H, useWindows } from '@/kernel/window/store'
import { appMeta } from '@/shell/apps/manifest'

type Props = { id: string; z: number; children: ReactNode }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const HANDLES: [string, React.CSSProperties, string][] = [
  ['n', { top: 0, left: 10, right: 10, height: 5 }, 'ns-resize'],
  ['s', { bottom: 0, left: 10, right: 10, height: 5 }, 'ns-resize'],
  ['w', { left: 0, top: 10, bottom: 10, width: 5 }, 'ew-resize'],
  ['e', { right: 0, top: 10, bottom: 10, width: 5 }, 'ew-resize'],
  ['nw', { top: 0, left: 0, width: 10, height: 10 }, 'nwse-resize'],
  ['ne', { top: 0, right: 0, width: 10, height: 10 }, 'nesw-resize'],
  ['sw', { bottom: 0, left: 0, width: 10, height: 10 }, 'nesw-resize'],
  ['se', { bottom: 0, right: 0, width: 10, height: 10 }, 'nwse-resize'],
]

export default function WindowFrame({ id, z, children }: Props) {
  const win = useWindows((s) => s.windows.find((w) => w.id === id))
  const dragging = useWindows((s) => s.dragging)
  const [interacting, setInteracting] = useState(false)

  // 浏览器缩放时让最大化窗口跟随视口
  useEffect(() => {
    const onResize = () => {
      const st = useWindows.getState()
      const w = st.windows.find((x) => x.id === id)
      if (w?.maximized) {
        st.setRect(id, { x: 0, y: TOPBAR_H, w: window.innerWidth, h: window.innerHeight - TOPBAR_H })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [id])

  if (!win) return null
  const meta = appMeta(win.appId)
  const minW = meta?.minSize?.w ?? 420
  const minH = meta?.minSize?.h ?? 300

  const endInteraction = () => {
    const st = useWindows.getState()
    st.setDragging(false)
    setInteracting(false)
    const cur = st.windows.find((x) => x.id === id)
    if (cur && !cur.maximized) st.saveRect(id, cur.rect)
  }

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as Element).closest('.vd-tl')) return
    const st = useWindows.getState()
    st.focus(id)
    const mx0 = e.clientX
    const my0 = e.clientY
    let r0: { x: number; y: number; w: number; h: number } | null = null
    const onMove = (ev: MouseEvent) => {
      if (!r0) {
        const s = useWindows.getState()
        const w = s.windows.find((x) => x.id === id)
        if (!w) return
        if (w.maximized) {
          // 最大化窗口拖动超过阈值才还原，并让窗口跟随光标（避免与双击还原冲突）
          s.toggleMaximize(id)
          const r = s.windows.find((x) => x.id === id)!.rect
          const nx = clamp(ev.clientX - r.w / 2, -(r.w - 80), window.innerWidth - 80)
          const ny = clamp(my0 - 19, TOPBAR_H, window.innerHeight - 40)
          s.setRect(id, { ...r, x: nx, y: ny })
          r0 = { ...r, x: nx, y: ny }
        } else {
          r0 = { ...w.rect }
        }
        s.setDragging(true)
        setInteracting(true)
      }
      const dx = ev.clientX - mx0
      const dy = ev.clientY - my0
      const x = clamp(r0.x + dx, -(r0.w - 80), window.innerWidth - 80)
      const y = clamp(r0.y + dy, TOPBAR_H, window.innerHeight - 40)
      useWindows.getState().setRect(id, { ...r0, x, y })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (r0) endInteraction()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const startResize = (dir: string) => (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const st = useWindows.getState()
    const w0 = st.windows.find((x) => x.id === id)
    if (!w0 || w0.maximized) return
    const r0 = { ...w0.rect }
    const mx0 = e.clientX
    const my0 = e.clientY
    st.setDragging(true)
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - mx0
      const dy = ev.clientY - my0
      let { x, y, w, h } = r0
      if (dir.includes('e')) w = Math.max(minW, r0.w + dx)
      if (dir.includes('s')) h = Math.max(minH, r0.h + dy)
      if (dir.includes('w')) {
        w = Math.max(minW, r0.w - dx)
        x = r0.x + (r0.w - w)
      }
      if (dir.includes('n')) {
        h = Math.max(minH, r0.h - dy)
        y = Math.max(TOPBAR_H, r0.y + (r0.h - h))
      }
      useWindows.getState().setRect(id, { x, y, w, h })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      endInteraction()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const { x, y, w, h } = win.rect
  return (
    <div
      className={`vd-window${win.maximized ? ' vd-win-max' : ''}${win.minimized ? ' vd-win-min' : ''}${
        dragging || interacting ? ' vd-win-nodrag' : ''
      }`}
      style={{ left: x, top: y, width: w, height: h, zIndex: z }}
      onMouseDown={() => useWindows.getState().focus(id)}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        className="vd-titlebar"
        onMouseDown={startDrag}
        onDoubleClick={() => useWindows.getState().toggleMaximize(id)}
      >
        <div className="vd-tl" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="vd-tl-btn close"
            title="关闭"
            onClick={() => useWindows.getState().close(id)}
          >
            <CloseOutlined />
          </button>
          <button
            type="button"
            className="vd-tl-btn min"
            title="最小化"
            onClick={() => useWindows.getState().minimize(id)}
          >
            <MinusOutlined />
          </button>
          <button
            type="button"
            className="vd-tl-btn max"
            title="最大化"
            onClick={() => useWindows.getState().toggleMaximize(id)}
          >
            <BorderOuterOutlined />
          </button>
        </div>
        <span className="vd-title">{win.title}</span>
        <span className="vd-titlebar-spacer" />
      </div>
      <div className="vd-content">{children}</div>
      {!win.maximized &&
        HANDLES.map(([dir, pos, cursor]) => (
          <div
            key={dir}
            className="vd-rh"
            style={{ position: 'absolute', ...pos, cursor }}
            onMouseDown={startResize(dir)}
          />
        ))}
    </div>
  )
}
