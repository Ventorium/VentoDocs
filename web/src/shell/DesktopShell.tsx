/**
 * 桌面外壳（M2）：壁纸 + 桌面图标 + 窗口集合 + 顶栏/启动台/码头/右键菜单。
 * 路由即窗口：URL 变化 → 打开/聚焦窗口（open）；窗口关闭 → URL 跟随最前窗口。
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useSettings } from '@/store/useSettings'
import { useAuth } from '@/store/useAuth'
import { wallpaperStyle } from '@/lib/wallpapers'
import { useWindows, windowKey } from '@/kernel/window/store'
import { APPS, getApp } from './apps/registry'
import WindowFrame from './Window'
import TopBar from './TopBar'
import Dock from './Dock'
import Launchpad from './Launchpad'
import { ContextMenuHost, useContextMenu, type CtxItem } from './ContextMenu'

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

export default function DesktopShell() {
  const { wallpaper, resolvedTheme } = useSettings()
  const { user } = useAuth()
  const navigate = useNavigate()
  const pathname = useLocation().pathname
  const windows = useWindows((s) => s.windows)
  const [launchpad, setLaunchpad] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const showCtx = useContextMenu((s) => s.show)

  const isAdmin = user?.role === 'admin'
  const desktopApps = useMemo(
    () => APPS.filter((a) => a.launchable && (!a.adminOnly || isAdmin)),
    [isAdmin],
  )

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

  const launch = (appId: string, appState: Record<string, string> = {}) => {
    useWindows.getState().open(appId, appState)
    const url = urlFor(appId, appState)
    if (url !== pathname) navigate(url)
  }

  const bg = wallpaperStyle(wallpaper, resolvedTheme === 'dark') ?? undefined

  const desktopMenu: CtxItem[] = [
    { key: 'show-desktop', label: '显示桌面', onClick: () => useWindows.getState().minimizeAll() },
    { key: 'sep', divider: true },
    { key: 'open-explorer', label: '打开文件管理器', onClick: () => launch('explorer') },
    { key: 'open-settings', label: '打开系统设置', onClick: () => launch('settings') },
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
      {/* 桌面图标 */}
      <div className="vd-desktop-icons">
        {desktopApps.map((a) => (
          <div
            key={a.id}
            className={`vd-icon${selected === a.id ? ' sel' : ''}`}
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

      {/* 窗口集合 */}
      {windows.map((w, i) => {
        const app = getApp(w.appId)
        return (
          <WindowFrame key={w.id} id={w.id} z={10 + i}>
            {app ? app.render(w) : null}
          </WindowFrame>
        )
      })}

      <TopBar onLaunch={launch} />
      <Launchpad
        open={launchpad}
        onClose={() => setLaunchpad(false)}
        onLaunch={(id) => {
          setLaunchpad(false)
          launch(id)
        }}
      />
      <Dock onLaunch={launch} onLaunchpad={() => setLaunchpad(true)} />
      <ContextMenuHost />
    </div>
  )
}
