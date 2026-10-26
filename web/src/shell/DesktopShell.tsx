/**
 * 桌面外壳（M2 + M4）：壁纸 + 桌面图标 + 窗口集合 + 顶栏/启动台/码头/右键菜单。
 * 路由即窗口：URL 变化 → 打开/聚焦窗口（open）；窗口关闭 → URL 跟随最前窗口。
 * M4 新增：
 * - 全局搜索：Ctrl/Cmd+K 或顶栏搜索按钮唤起 SearchPalette（Spotlight）
 * - 桌面右键「切换壁纸…」：缩略图选择器，即时应用（与系统设置联动）
 * - 窗口关闭幽灵动画：关闭瞬间渲染半透明标题栏淡出，不触碰 store/URL
 * - 桌面图标拖拽排序：HTML5 DnD，顺序持久化到 localStorage
 * - 最前窗口焦点强调（vd-win-focused 阴影）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useSettings } from '@/store/useSettings'
import { useAuth } from '@/store/useAuth'
import { WALLPAPERS, wallpaperStyle } from '@/lib/wallpapers'
import { useWindows, windowKey, type WinRect } from '@/kernel/window/store'
import { APPS, getApp } from './apps/registry'
import WindowFrame from './Window'
import TopBar from './TopBar'
import Dock from './Dock'
import Launchpad from './Launchpad'
import SearchPalette from './SearchPalette'
import { ContextMenuHost, useContextMenu, type CtxItem } from './ContextMenu'

/** 桌面图标顺序持久化键 */
const ICON_ORDER_KEY = 'vd-desktop-icon-order'

/** 应用 + 状态 → URL */
export function urlFor(appId: string, appState: Record<string, string> = {}): string {
  if (appId === 'explorer') return appState.dirId ? `/app/files/${appState.dirId}` : '/app/files'
  if (appId === 'file') return `/app/file/${appState.fileId}`
  return `/app/${appId}`
}

/** URL → 应用 + 状态（无法识别返回 null） */
export function parseAppRoute(pathname: string): { appId: string; appState: Record<string, string> } | null {
  const clean = pathname.replace(/\/+$/, '') || '/app'
  if (clean === '/app') return { appId: 'explorer', appState: {} }
  if (clean === '/app/files') return { appId: 'explorer', appState: {} }
  let m = clean.match(/^\/app\/files\/([^/]+)$/)
  if (m) return { appId: 'explorer', appState: { dirId: m[1] } }
  m = clean.match(/^\/app\/file\/([^/]+)$/)
  if (m) return { appId: 'file', appState: { fileId: m[1] } }
  m = clean.match(/^\/app\/(trash|settings|teams|users|audits)$/)
  if (m) return { appId: m[1], appState: {} }
  return null
}

type Ghost = { id: string; title: string; rect: WinRect; z: number }

export default function DesktopShell() {
  const { wallpaper, resolvedTheme, setWallpaper } = useSettings()
  const { user } = useAuth()
  const navigate = useNavigate()
  const pathname = useLocation().pathname
  const windows = useWindows((s) => s.windows)
  const [launchpad, setLaunchpad] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [wpOpen, setWpOpen] = useState(false)
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const prevWins = useRef(windows)
  const showCtx = useContextMenu((s) => s.show)

  const isAdmin = user?.role === 'admin'
  const baseApps = useMemo(
    () => APPS.filter((a) => a.launchable && (!a.adminOnly || isAdmin)),
    [isAdmin],
  )

  // ---------- 桌面图标顺序（拖拽后持久化；未知 id 忽略，新应用补在末尾） ----------
  const [order, setOrder] = useState<string[] | null>(() => {
    try {
      const raw = localStorage.getItem(ICON_ORDER_KEY)
      return raw ? (JSON.parse(raw) as string[]) : null
    } catch {
      return null
    }
  })
  const desktopApps = useMemo(() => {
    if (!order) return baseApps
    const byId = new Map(baseApps.map((a) => [a.id, a]))
    const sorted = [] as typeof baseApps
    for (const id of order) {
      const a = byId.get(id)
      if (a) {
        sorted.push(a)
        byId.delete(id)
      }
    }
    for (const a of byId.values()) sorted.push(a)
    return sorted
  }, [baseApps, order])

  // ---------- 图标拖拽（HTML5 DnD） ----------
  const dragSrc = useRef<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const onIconDragStart = (e: React.DragEvent, id: string) => {
    dragSrc.current = id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }
  const onIconDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (id !== dragSrc.current) setOverId(id)
  }
  const onIconDragEnd = () => {
    dragSrc.current = null
    setDragId(null)
    setOverId(null)
  }
  const onIconDrop = (e: React.DragEvent, id: string) => {
    e.preventDefault()
    const src = dragSrc.current
    onIconDragEnd()
    if (!src || src === id) return
    const ids = desktopApps.map((a) => a.id)
    const from = ids.indexOf(src)
    const to = ids.indexOf(id)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    setOrder(ids)
    try {
      localStorage.setItem(ICON_ORDER_KEY, JSON.stringify(ids))
    } catch {
      /* 存储不可用时仅本次会话生效 */
    }
  }

  // ---------- 全局搜索热键 Ctrl/Cmd+K ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---------- 窗口关闭 → 幽灵动画（仅视觉；store 已即时更新，check4 依赖） ----------
  useEffect(() => {
    const prev = prevWins.current
    prevWins.current = windows
    const closed = prev.filter((p) => !windows.some((w) => w.id === p.id) && !p.minimized)
    closed.forEach((p) => {
      // 去重：同一 id 的 ghost 只保留一个
      setGhosts((g) => (g.some((x) => x.id === p.id) ? g : [...g, { id: p.id, title: p.title, rect: p.rect, z: 10 }]))
      // 不依赖 effect cleanup 的独立定时器：期间其他窗口变化不会取消移除
      setTimeout(() => setGhosts((g) => g.filter((x) => x.id !== p.id)), 260)
    })
  }, [windows])

  // URL → 窗口（含权限守卫）
  useEffect(() => {
    const parsed = parseAppRoute(pathname)
    if (!parsed) {
      navigate('/app/files', { replace: true })
      return
    }
    if (!isAdmin && (parsed.appId === 'users' || parsed.appId === 'audits')) {
      navigate('/app/files', { replace: true })
      return
    }
    useWindows.getState().open(parsed.appId, parsed.appState)
  }, [pathname, navigate, isAdmin])

  // 窗口 → URL（当前 URL 对应窗口被关闭时，跟随到最前窗口；全关则保持 URL）。
  // 注意：必须用 getState() 读最新窗口表 —— 前向同步 effect 的 open() 先于本
  // effect 执行但 React 闭包里的 windows 还是旧值，直接读闭包会误判并回跳 URL。
  useEffect(() => {
    const wins = useWindows.getState().windows
    const parsed = parseAppRoute(pathname)
    if (!parsed) return
    const key = windowKey(parsed.appId, parsed.appState)
    if (wins.some((w) => w.id === key)) return
    if (wins.length === 0) return
    const top = [...wins].reverse().find((w) => !w.minimized) ?? wins[wins.length - 1]
    navigate(urlFor(top.appId, top.appState), { replace: true })
  }, [windows, pathname, navigate])

  // 启动台打开时 Esc 关闭
  useEffect(() => {
    if (!launchpad) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLaunchpad(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [launchpad])

  const launch = (appId: string, appState: Record<string, string> = {}) => {
    useWindows.getState().open(appId, appState)
    const url = urlFor(appId, appState)
    if (url !== pathname) navigate(url)
  }

  const bg = wallpaperStyle(wallpaper, resolvedTheme === 'dark') ?? undefined

  // 最前（非最小化）窗口 id，用于焦点强调
  const topId = [...windows].reverse().find((w) => !w.minimized)?.id

  const desktopMenu: CtxItem[] = [
    { key: 'show-desktop', label: '显示桌面', onClick: () => useWindows.getState().minimizeAll() },
    { key: 'open-trash', label: '打开回收站', onClick: () => launch('trash') },
    { key: 'open-explorer', label: '打开文件管理器', onClick: () => launch('explorer') },
    { key: 'open-settings', label: '打开系统设置', onClick: () => launch('settings') },
    { key: 'sep', divider: true },
    { key: 'switch-wp', label: '切换壁纸…', onClick: () => setWpOpen(true) },
    { key: 'refresh', label: '刷新', onClick: () => {} },
  ]

  return (
    <div
      className="vd-desktop"
      style={bg}
      onContextMenu={(e) => {
        e.preventDefault()
        showCtx(e.clientX, e.clientY, desktopMenu)
      }}
      onClick={() => setSelected(null)}
    >
      {/* 桌面图标（拖拽排序） */}
      <div className="vd-desktop-icons">
        {desktopApps.map((a) => (
          <div
            key={a.id}
            draggable
            onDragStart={(e) => onIconDragStart(e, a.id)}
            onDragOver={(e) => onIconDragOver(e, a.id)}
            onDrop={(e) => onIconDrop(e, a.id)}
            onDragEnd={onIconDragEnd}
            className={`vd-icon${selected === a.id ? ' sel' : ''}${dragId === a.id ? ' dragging' : ''}${overId === a.id ? ' dropover' : ''}`}
            title={a.desc}
            onClick={(e) => {
              e.stopPropagation()
              setSelected(a.id)
            }}
            onDoubleClick={() => launch(a.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const st = useWindows.getState()
              const runs = st.windows.filter((w) => w.appId === a.id)
              const items: CtxItem[] = [
                { key: 'open', label: `打开 ${a.name}`, onClick: () => launch(a.id) },
              ]
              if (runs.length) {
                items.push({ key: 'sep', divider: true })
                items.push({
                  key: 'close-all',
                  label: '关闭所有窗口',
                  onClick: () => runs.forEach((w) => st.close(w.id)),
                })
              }
              showCtx(e.clientX, e.clientY, items)
            }}
          >
            <span className="vd-icon-img">{a.icon}</span>
            <span className="vd-icon-label">{a.name}</span>
          </div>
        ))}
      </div>

      {/* 窗口集合（数组顺序 = z 序） */}
      {windows.map((w, i) => {
        const app = getApp(w.appId)
        return (
          <WindowFrame key={w.id} id={w.id} z={10 + i} focused={w.id === topId}>
            {app ? app.render(w) : null}
          </WindowFrame>
        )
      })}

      {/* 关闭动画幽灵框 */}
      {ghosts.map((g) => (
        <div
          key={g.id}
          className="vd-window vd-win-ghost"
          style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h, zIndex: g.z }}
        >
          <div className="vd-titlebar">
            <span className="vd-title">{g.title}</span>
          </div>
        </div>
      ))}

      <TopBar onLaunch={launch} onSearch={() => setSearchOpen(true)} />
      <Launchpad
        open={launchpad}
        onClose={() => setLaunchpad(false)}
        onLaunch={(id) => {
          setLaunchpad(false)
          launch(id)
        }}
      />
      <Dock onLaunch={launch} onLaunchpad={() => setLaunchpad(true)} />
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenFile={(fileId) => {
          setSearchOpen(false)
          launch('file', { fileId })
        }}
      />
      <ContextMenuHost />

      {/* 壁纸快捷选择器（桌面右键 → 切换壁纸…） */}
      {wpOpen && (
        <div className="vd-wp-veil" onMouseDown={() => setWpOpen(false)}>
          <div className="vd-wp-picker" onMouseDown={(e) => e.stopPropagation()}>
            <div className="vd-wp-title">切换壁纸</div>
            <div className="vd-wp-grid">
              {WALLPAPERS.map((wp) => (
                <div
                  key={wp.id}
                  className={`vd-wp-thumb${wallpaper === wp.value ? ' on' : ''}`}
                  onClick={() => {
                    setWallpaper(wp.value)
                    setWpOpen(false)
                  }}
                >
                  {wp.value ? (
                    <img src={wp.value} alt={wp.name} draggable={false} />
                  ) : (
                    <span className="vd-wp-none">无</span>
                  )}
                  <span className="vd-wp-name">{wp.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
