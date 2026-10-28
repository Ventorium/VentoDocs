/**
 * 桌面壳（M5）：壁纸桌面 + 桌面图标 + 窗口层 + 顶栏 + Dock + 启动台。
 * SPA 单路由：窗口状态只存前端 store，不再与 URL 同步（对齐 VentoOS）。
 */
import { AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { ImageIcon, Trash2, Folder, Settings, RefreshCw, Monitor } from 'lucide-react'
import { useWindows } from '@/kernel/window/store'
import { useSettings } from '@/store/useSettings'
import { useAuth } from '@/store/useAuth'
import { wallpaperStyle, WALLPAPERS } from '@/lib/wallpapers'
import type { WallpaperDef } from '@/lib/wallpapers'
import { APPS } from './apps/registry'
import TopBar from './TopBar'
import Dock from './Dock'
import Launchpad from './Launchpad'
import WindowFrame from './Window'
import { ContextMenuHost, useContextMenu } from './ContextMenu'
import SearchPalette from './SearchPalette'
import { Modal, Btn } from '@/components/ui/kit'

type DesktopIcon = { id: string; name: string; appId: string; icon: 'explorer' | 'trash' | 'settings' }
type Ghost = { x: number; y: number; w: number; h: number; title: string }
type WallpaperState = WallpaperDef['id'] | 'none'

const DEFAULT_ICON_ORDER: DesktopIcon[] = [
  { id: 'explorer', name: '文件管理器', appId: 'explorer', icon: 'explorer' },
  { id: 'trash', name: '回收站', appId: 'trash', icon: 'trash' },
  { id: 'settings', name: '系统设置', appId: 'settings', icon: 'settings' },
]

const ICON_ORDER_KEY = 'vd-desktop-icon-order'

const ICONS: Record<DesktopIcon['icon'], typeof Folder> = {
  explorer: Folder,
  trash: Trash2,
  settings: Settings,
}

function loadIconOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ICON_ORDER_KEY) || 'null')
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
  } catch {
    /* ignore */
  }
  return DEFAULT_ICON_ORDER.map((d) => d.id)
}

export default function DesktopShell() {
  const windows = useWindows((s) => s.windows)
  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const wallpaper = useSettings((s) => s.wallpaper)
  const theme = useSettings((s) => s.resolvedTheme)
  const setWallpaper = useSettings((s) => s.setWallpaper)

  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const [wpOpen, setWpOpen] = useState(false)
  const [wpChoice, setWpChoice] = useState<WallpaperState>('dark-mountain')
  const [searchOpen, setSearchOpen] = useState(false)
  const [launchpadOpen, setLaunchpadOpen] = useState(false)
  const [selIcon, setSelIcon] = useState<string | null>(null)
  const [iconOrder, setIconOrder] = useState<string[]>(loadIconOrder)
  const [dragOverIcon, setDragOverIcon] = useState<string | null>(null)

  const { show: showCtx } = useContextMenu()
  const bg = wallpaperStyle(wallpaper, theme === 'dark') ?? undefined

  // 打开应用：只动窗口，不再动 URL（SPA 单路由）
  const launch = (appId: string, appState?: Record<string, string>) => {
    const app = APPS.find((a) => a.id === appId)
    if (app?.adminOnly && !isAdmin) return
    useWindows.getState().open(appId, appState)
  }

  // Ctrl+K 搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 窗口关闭幽灵动画
  const prevWindowsRef = useRef(windows)
  useEffect(() => {
    const prev = prevWindowsRef.current
    prevWindowsRef.current = windows
    const nowIds = new Set(windows.map((w) => w.id))
    const closed: Ghost[] = prev
      .filter((p) => !nowIds.has(p.id) && !p.minimized)
      .map((p) => ({ x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h, title: p.title }))
    if (closed.length === 0) return
    setGhosts((g) => [...g, ...closed])
    const t = setTimeout(() => setGhosts((g) => g.slice(closed.length)), 260)
    return () => clearTimeout(t)
  }, [windows])

  const topId = [...windows].reverse().find((w) => !w.minimized)?.id

  const desktopMenu = () => [
    { key: 'show-desktop', label: '显示桌面', icon: <Monitor size={14} />, onClick: () => useWindows.getState().minimizeAll() },
    { key: 'trash', label: '回收站', icon: <Trash2 size={14} />, onClick: () => launch('trash') },
    { key: 'explorer', label: '文件管理器', icon: <Folder size={14} />, onClick: () => launch('explorer') },
    { key: 'settings', label: '系统设置', icon: <Settings size={14} />, onClick: () => launch('settings') },
    { key: 'wp', label: '切换壁纸', icon: <ImageIcon size={14} />, onClick: () => setWpOpen(true) },
    { key: 'refresh', label: '刷新', icon: <RefreshCw size={14} />, onClick: () => window.location.reload() },
  ]

  const pickWallpaper = (id: WallpaperState) => {
    const def = WALLPAPERS.find((w) => w.id === id)
    setWallpaper(def ? def.value : '')
    setWpOpen(false)
  }

  const orderedIcons: DesktopIcon[] = iconOrder
    .map((id) => DEFAULT_ICON_ORDER.find((d) => d.id === id))
    .filter((d): d is DesktopIcon => !!d)

  const onDropIcon = (targetId: string) => {
    setDragOverIcon(null)
    const src = selIcon
    if (!src || src === targetId) return
    const next = iconOrder.filter((x) => x !== src && x !== targetId)
    const idx = next.indexOf(targetId)
    next.splice(idx, 0, src)
    localStorage.setItem(ICON_ORDER_KEY, JSON.stringify(next))
    setIconOrder(next)
  }

  return (
    <div
      className="vd-desktop"
      style={bg}
      onContextMenu={(e) => {
        e.preventDefault()
        showCtx(e.clientX, e.clientY, desktopMenu())
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setSelIcon(null)
      }}
    >
      {/* 桌面图标（左列，顶部状态栏下方开始，可拖拽排序） */}
      <div className="vd-desktop-icons">
        {orderedIcons.map((d) => {
          const Icon = ICONS[d.icon]
          return (
            <div
              key={d.id}
              className={`vd-desktop-icon${selIcon === d.id ? ' sel' : ''}${dragOverIcon === d.id ? ' drag-over' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', d.id)
              }}
              onDragOver={(e) => {
                if (selIcon && selIcon !== d.id) {
                  e.preventDefault()
                  setDragOverIcon(d.id)
                }
              }}
              onDragLeave={() => setDragOverIcon(null)}
              onDrop={(e) => {
                e.preventDefault()
                onDropIcon(d.id)
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                setSelIcon(d.id)
              }}
              onDoubleClick={() => launch(d.appId)}
            >
              <span className={`vd-app-icon vd-app-icon-${d.id}`} style={{ width: 52, height: 52 }}>
                <Icon size={26} />
              </span>
              <span className="vd-desktop-icon-label">{d.name}</span>
            </div>
          )
        })}
      </div>

      {/* 窗口层（AnimatePresence 驱动开/关动画） */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 100, pointerEvents: 'none' }}>
        <AnimatePresence>
          {windows.map((w, i) => {
            const app = APPS.find((a) => a.id === w.appId)
            return (
              <WindowFrame key={w.id} id={w.id} z={10 + i} focused={w.id === topId} wallpaperUrl={wallpaper || undefined}>
                {app ? app.render(w) : null}
              </WindowFrame>
            )
          })}
        </AnimatePresence>
      </div>

      {/* 关闭幽灵动画 */}
      {ghosts.map((g, i) => (
        <div key={`ghost-${g.title}-${i}`} className="vd-win-ghost" style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
          <div className="vd-win-ghost-bar">{g.title}</div>
        </div>
      ))}

      <TopBar onLaunch={launch} onSearch={() => setSearchOpen(true)} />
      <Dock onLaunch={launch} onLaunchpad={() => setLaunchpadOpen(true)} />
      <Launchpad open={launchpadOpen} onClose={() => setLaunchpadOpen(false)} onLaunch={launch} />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onOpenFile={(id) => launch('file', { fileId: id })} />
      <ContextMenuHost />

      <Modal
        open={wpOpen}
        title="切换壁纸"
        onClose={() => setWpOpen(false)}
        width={420}
        footer={
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
            <Btn onClick={() => setWpOpen(false)}>取消</Btn>
            <Btn variant="primary" onClick={() => pickWallpaper(wpChoice)}>
              应用
            </Btn>
          </div>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {WALLPAPERS.map((w) => (
            <div
              key={w.id}
              className={`vd-wp-thumb${wpChoice === w.id ? ' on' : ''}`}
              style={wallpaperStyle(w.value, theme === 'dark') ?? { background: 'var(--vd-bg-window)' }}
              onClick={() => setWpChoice(w.id)}
            >
              <span className="vd-wp-name">{w.name}</span>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
