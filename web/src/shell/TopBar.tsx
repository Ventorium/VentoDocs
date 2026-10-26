/**
 * 顶部栏（M2）：品牌 + 当前活动应用 | 时钟 + 窗口切换 + 设置 + 用户菜单。
 */
import { useEffect, useState } from 'react'
import { Dropdown, type MenuProps } from 'antd'
import { AppstoreOutlined, LogoutOutlined, SettingOutlined } from '@ant-design/icons'
import { useWindows } from '@/kernel/window/store'
import { useAuth } from '@/store/useAuth'
import { APPS } from './apps/registry'

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="vd-tb-clock">
      {now.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}{' '}
      {now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
    </span>
  )
}

export default function TopBar({
  onLaunch,
}: {
  onLaunch: (appId: string, appState?: Record<string, string>) => void
}) {
  const windows = useWindows((s) => s.windows)
  const { user, logout } = useAuth()

  const top = [...windows].reverse().find((w) => !w.minimized)
  const activeName = top ? APPS.find((a) => a.id === top.appId)?.name ?? top.appId : '桌面'

  const winMenu: MenuProps['items'] = [
    ...windows.map((w) => ({
      key: w.id,
      label: w.title,
      onClick: () => onLaunch(w.appId, w.appState),
    })),
    ...(windows.length
      ? [
          { type: 'divider' as const, key: 'sep' },
          {
            key: 'min-all',
            label: '全部最小化',
            onClick: () => useWindows.getState().minimizeAll(),
          },
        ]
      : []),
  ]

  const userMenu: MenuProps['items'] = [
    { key: 'name', label: `${user?.display_name || user?.username || ''}（${user?.username || ''}）`, disabled: true },
    { type: 'divider' as const, key: 'sep' },
    { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, onClick: () => logout() },
  ]

  return (
    <div className="vd-topbar">
      <div className="vd-tb-left">
        <span className="vd-tb-logo">V</span>
        <span className="vd-tb-brand">VentoDocs</span>
        <span className="vd-tb-sep" />
        <span className="vd-tb-app">{activeName}</span>
      </div>
      <div className="vd-tb-right">
        <Clock />
        <Dropdown menu={{ items: winMenu }} trigger={['click']} placement="bottomRight">
          <button type="button" className="vd-tb-btn" title="窗口切换">
            <AppstoreOutlined />
            {windows.length > 0 && <span className="vd-tb-count">{windows.length}</span>}
          </button>
        </Dropdown>
        <button type="button" className="vd-tb-btn" title="系统设置" onClick={() => onLaunch('settings')}>
          <SettingOutlined />
        </button>
        {user && (
          <Dropdown menu={{ items: userMenu }} trigger={['click']} placement="bottomRight">
            <button type="button" className="vd-tb-btn vd-tb-user" title="用户">
              <span className="vd-tb-avatar">
                {(user.display_name || user.username || '?').slice(0, 1).toUpperCase()}
              </span>
            </button>
          </Dropdown>
        )}
      </div>
    </div>
  )
}
