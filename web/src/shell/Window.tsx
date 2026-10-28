/**
 * 窗口框架（M5，对齐 VentoOS）：玻璃材质 + 红绿灯 + framer 开合/最小化动画。
 * - 图片壁纸：窗口透明 + 壁纸切片（blur24 saturate180%）+ 明暗 tint
 * - 渐变/无壁纸：主题玻璃底 + backdrop-blur
 * - 最小化飞向 dock 图标，还原时直接复位
 */
import { motion, useAnimationControls } from 'framer-motion'
import { createContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { TOPBAR_H, useWindows } from '@/kernel/window/store'
import { wallpaperStyle } from '@/lib/wallpapers'
import { appMeta } from '@/shell/apps/manifest'
import { getDockRect } from '@/shell/dockRects'
import { tokens } from '@/theme'

type Props = { id: string; z: number; focused?: boolean; wallpaperUrl?: string; children: ReactNode }

/**
 * 标题栏右侧动作槽（M2.7）：子页面（如文件详情页）通过 useContext(TitleActionContext)
 * 拿到 setter，把"进入编辑/保存/退出编辑"等上下文化操作放进标题栏右侧。
 * 渲染在 .vd-titlebar-action（不参与拖拽、不触发双击最大化）。
 */
export const TitleActionContext = createContext<((node: ReactNode) => void) | null>(null)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const HANDLES: string[] = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']

export default function WindowFrame({ id, z, focused, wallpaperUrl, children }: Props) {
  const win = useWindows((s) => s.windows.find((w) => w.id === id))
  const dragging = useWindows((s) => s.dragging)
  const [interacting, setInteracting] = useState(false)
  const [draggingTitle, setDraggingTitle] = useState(false)
  const [minPhase, setMinPhase] = useState<'none' | 'flying' | 'paused'>('none')
  const [titleAction, setTitleAction] = useState<ReactNode>(null)
  const controls = useAnimationControls()
  const rootRef = useRef<HTMLDivElement>(null)

  // 打开动画（mount 时从 0.94 放大淡入）
  useEffect(() => {
    controls.start({
      opacity: 1,
      scale: 1,
      y: 0,
      transition: { duration: tokens.animation.windowOpen.duration, ease: tokens.animation.windowOpen.ease },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 最小化：飞向 dock 图标；还原：直接复位
  const minimized = win?.minimized ?? false
  useEffect(() => {
    if (!win) return
    if (minimized) {
      setMinPhase('flying')
      const rect = rootRef.current?.getBoundingClientRect()
      const dock = getDockRect(win.appId)
      if (rect && dock) {
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const t = {
          duration: tokens.animation.windowMinimize.duration,
          ease: tokens.animation.windowMinimize.ease,
        }
        controls.start(
          {
            opacity: 0,
            scale: 0.1,
            x: dock.x + dock.width / 2 - cx,
            y: dock.y + dock.height / 2 - cy,
            transition: t,
          },
          { onComplete: () => setMinPhase('paused') },
        )
      } else {
        controls.start(
          {
            opacity: 0,
            scale: 0.88,
            y: 40,
            transition: { duration: tokens.animation.windowMinimize.duration, ease: tokens.animation.windowMinimize.ease },
          },
          { onComplete: () => setMinPhase('paused') },
        )
      }
    } else {
      controls.set({ opacity: 1, scale: 1, x: 0, y: 0 })
      setMinPhase('none')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimized])

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
  const minW = meta?.minSize?.w ?? tokens.window.minWidth
  const minH = meta?.minSize?.h ?? tokens.window.minHeight

  const endInteraction = () => {
    const st = useWindows.getState()
    st.setDragging(false)
    setInteracting(false)
    const cur = st.windows.find((x) => x.id === id)
    if (cur && !cur.maximized) st.saveRect(id, cur.rect)
  }

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const t = e.target as Element
    if (t.closest('.vd-tl') || t.closest('.vd-titlebar-action')) return
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
        setDraggingTitle(true)
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
      setDraggingTitle(false)
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
    setInteracting(true)
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
  const cls = [
    'vd-window',
    win.maximized ? 'maximized' : 'glass-theme',
    minPhase === 'paused' ? 'vd-win-min' : '',
    dragging || interacting ? 'vd-win-nodrag' : '',
    focused ? 'vd-win-focused' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <TitleActionContext.Provider value={setTitleAction}>
    <motion.div
      ref={rootRef}
      className={cls}
      initial={{ opacity: 0, scale: 0.94, y: 16 }}
      animate={controls}
      exit={{ opacity: 0, scale: 0.92, y: 12, transition: { duration: tokens.animation.windowClose.duration, ease: tokens.animation.windowClose.ease } }}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        zIndex: z,
        position: 'absolute',
        display: minPhase === 'paused' ? 'none' : undefined,
      }}
      onMouseDown={() => useWindows.getState().focus(id)}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {wallpaperUrl ? (
        <>
          {/* 切片内放一个视口尺寸图层，用与桌面相同的 cover/center/no-repeat 几何，
              再按窗口位置 (x,y) 平移补偿，保证玻璃与桌面壁纸严格对齐（M2.10） */}
          <div className="vd-win-glass-slice">
            <div
              className="vd-win-glass-slice-img"
              style={{
                left: `${24 - x}px`,
                top: `${24 - y}px`,
                ...wallpaperStyle(wallpaperUrl, false),
              }}
            />
          </div>
          <div className="vd-win-glass-tint" />
        </>
      ) : null}
      <div className="vd-win-body">
        <div
          className={`vd-titlebar${win.maximized ? '' : ' draggable'}${draggingTitle ? ' dragging' : ''}`}
          onMouseDown={startDrag}
          onDoubleClick={() => !win.minimized && useWindows.getState().toggleMaximize(id)}
        >
          <div className="vd-tl" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="vd-tl-btn close"
              title="关闭"
              onClick={() => useWindows.getState().close(id)}
            >
              {/* VentoOS 像素级图标：6×6 画布、1.5 描边、圆头，保证在 14px 圆内光学居中 */}
              <span className="vd-tl-glyph">
                <svg width="6" height="6" viewBox="0 0 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <line x1="1" y1="1" x2="5" y2="5" />
                  <line x1="5" y1="1" x2="1" y2="5" />
                </svg>
              </span>
            </button>
            <button
              type="button"
              className="vd-tl-btn minimize"
              title="最小化"
              onClick={() => useWindows.getState().minimize(id)}
            >
              <span className="vd-tl-glyph">
                <svg width="6" height="6" viewBox="0 0 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <line x1="1" y1="3" x2="5" y2="3" />
                </svg>
              </span>
            </button>
            <button
              type="button"
              className="vd-tl-btn maximize"
              title="最大化"
              onClick={() => useWindows.getState().toggleMaximize(id)}
            >
              <span className="vd-tl-glyph">
                <svg width="6" height="6" viewBox="0 0 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="1,3.5 1,5 2.5,5" />
                  <polyline points="4.5,1 5,1 5,2.5" />
                  <line x1="1" y1="5" x2="5" y2="1" />
                </svg>
              </span>
            </button>
          </div>
          <span className="vd-title">{win.title}</span>
          {titleAction !== null && (
            <span
              className="vd-titlebar-action"
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
            >
              {titleAction}
            </span>
          )}
          <span className="vd-titlebar-spacer" />
        </div>
        <div className="vd-content">
          {minPhase === 'paused' ? <div className="vd-win-paused">进程已暂停</div> : children}
        </div>
        {!win.maximized &&
          HANDLES.map((dir) => (
            <div key={dir} className={`vd-rh ${dir}`} onMouseDown={startResize(dir)} />
          ))}
      </div>
    </motion.div>
    </TitleActionContext.Provider>
  )
}
