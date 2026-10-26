/**
 * 底部码头（M2）：启动台按钮 + 可启动应用（file 不在列）+ 运行指示点。
 * 单击=启动/聚焦，右键=该应用的窗口列表或"打开"。
 */
import { AppstoreOutlined } from '@ant-design/icons'
import { useWindows } from '@/kernel/window/store'
import { useAuth } from '@/store/useAuth'
import { APPS } from './apps/registry'
import { useContextMenu, type CtxItem } from './ContextMenu'

type Props = {
  onLaunch: (appId: string, appState?: Record<string, string>) => void
  onLaunchpad: () => void
}

export default function Dock({ onLaunch, onLaunchpad }: Props) {
  const windows = useWindows((s) => s.windows)
  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const showCtx = useContextMenu((s) => s.show)
  const apps = APPS.filter((a) => a.launchable && (!a.adminOnly || isAdmin))

  return (
    <div className="vd-dock">
      <div className="vd-dock-item" onClick={onLaunchpad} title="启动台">
        <span className="vd-dock-icon">
          <AppstoreOutlined style={{ color: '#5b8def' }} />
        </span>
      </div>
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
          <div
            key={a.id}
            className="vd-dock-item"
            title={a.name}
            onClick={() => onLaunch(a.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              showCtx(e.clientX, e.clientY - 12, items)
            }}
          >
            <span className="vd-dock-icon">{a.icon}</span>
            <span className={`vd-dock-dot${runs.length ? ' on' : ''}`} />
          </div>
        )
      })}
    </div>
  )
}
