/**
 * 底部 Dock（M5，对齐 VentoOS）：弹簧悬停放大 + 渐变圆角图标 + 运行指示点。
 * 启动台按钮在最左；右键 = 该应用的窗口列表 / "打开"。
 */
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { Grid3X3 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useWindows } from '@/kernel/window/store'
import { useAuth } from '@/store/useAuth'
import { setDockRect } from '@/shell/dockRects'
import { useContextMenu, type CtxItem } from '@/shell/ContextMenu'
import { APPS } from '@/shell/apps/registry'
import { tokens } from '@/theme'

const HOVER_SCALE = 1.45
const NEIGHBOR_SCALE = 1.0

type Props = {
  onLaunch: (appId: string, appState?: Record<string, string>) => void
  onLaunchpad: () => void
}

function DockIcon({
  label,
  icon,
  isRunning,
  appId,
  onClick,
  onContextMenu,
  mouseX,
}: {
  label: string
  icon: React.ReactNode
  isRunning: boolean
  appId: string | null
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  mouseX: ReturnType<typeof useMotionValue<number>>
}) {
  const ref = useRef<HTMLButtonElement>(null)

  // 登记图标屏幕坐标（窗口最小化飞向 dock 用）
  useEffect(() => {
    if (!appId || !ref.current) return
    const update = () => {
      if (!ref.current) return
      const r = ref.current.getBoundingClientRect()
      setDockRect(appId, { x: r.x, y: r.y, width: r.width, height: r.height })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [appId])

  const distance = useTransform(mouseX, (val) => {
    if (!ref.current) return 999
    const rect = ref.current.getBoundingClientRect()
    const center = rect.left + rect.width / 2
    return Math.abs(val - center)
  })

  const scale = useSpring(
    useTransform(distance, [0, 40, 80], [HOVER_SCALE, NEIGHBOR_SCALE, 1]),
    { stiffness: 350, damping: 30, mass: 0.5 },
  )
  const y = useSpring(useTransform(distance, [0, 40, 80], [-14, -4, 0]), {
    stiffness: 350,
    damping: 30,
  })

  return (
    <div
      className="vd-dock-item"
      title={label}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e)
      }}
    >
      <motion.button
        ref={ref}
        type="button"
        className="vd-dock-icon"
        onClick={onClick}
        aria-label={label}
        style={{ scale, y, width: tokens.dock.iconSize, height: tokens.dock.iconSize }}
      >
        {icon}
      </motion.button>
      <span className={`vd-dock-dot${isRunning ? ' on' : ''}`} />
    </div>
  )
}

export default function Dock({ onLaunch, onLaunchpad }: Props) {
  const windows = useWindows((s) => s.windows)
  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const showCtx = useContextMenu((s) => s.show)
  const mouseX = useMotionValue(Number.POSITIVE_INFINITY)
  const apps = APPS.filter((a) => a.launchable && (!a.adminOnly || isAdmin))

  return (
    <div className="vd-dock" onMouseMove={(e) => mouseX.set(e.clientX)} onMouseLeave={() => mouseX.set(Number.POSITIVE_INFINITY)}>
      <DockIcon
        label="启动台"
        appId={null}
        isRunning={false}
        icon={
          <span className="vd-app-icon" style={{ width: tokens.dock.iconSize, height: tokens.dock.iconSize, background: 'linear-gradient(145deg, #4b5563 0%, #1f2937 100%)' }}>
            <Grid3X3 size={22} />
          </span>
        }
        onClick={onLaunchpad}
        mouseX={mouseX}
      />
      <div className="vd-dock-sep" />
      {apps.map((a) => {
        const runs = windows.filter((w) => w.appId === a.id)
        const items: CtxItem[] = []
        if (runs.length === 0) {
          items.push({ key: 'open', label: `打开 ${a.name}`, onClick: () => onLaunch(a.id) })
        } else {
          runs.forEach((w) =>
            items.push({ key: w.id, label: w.title, onClick: () => onLaunch(a.id, w.appState) }),
          )
          items.push({ key: 'sep', divider: true })
          items.push({
            key: 'min-all',
            label: '全部最小化',
            onClick: () => runs.forEach((w) => useWindows.getState().minimize(w.id)),
          })
          items.push({
            key: 'close-all',
            label: '全部关闭',
            danger: true,
            onClick: () => runs.forEach((w) => useWindows.getState().close(w.id)),
          })
        }
        return (
          <DockIcon
            key={a.id}
            label={a.name}
            appId={a.id}
            isRunning={runs.length > 0}
            icon={a.icon}
            onClick={() => onLaunch(a.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              showCtx(e.clientX, e.clientY - 12, items)
            }}
            mouseX={mouseX}
          />
        )
      })}
    </div>
  )
}
