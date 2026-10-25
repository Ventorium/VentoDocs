import { useMemo, useState } from 'react'
import { Dropdown, Layout, Menu, Tooltip, theme as antdTheme } from 'antd'
import type { MenuProps } from 'antd'
import {
  AuditOutlined,
  DeleteOutlined,
  FileTextOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/store/useAuth'
import { cn } from '@/lib/utils'

type MenuItem = Required<MenuProps>['items'][number]

const SideMenu = () => {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const {
    token: { colorBorderSecondary, colorTextSecondary },
  } = antdTheme.useToken()

  const isAdmin = user?.role === 'admin'

  const items: MenuItem[] = useMemo(() => {
    const base: MenuItem[] = [
      { key: '/app/files', icon: <FileTextOutlined />, label: '文件管理' },
      { key: '/app/trash', icon: <DeleteOutlined />, label: '回收站' },
      { key: '/app/settings', icon: <SettingOutlined />, label: '外观设置' },
    ]
    if (isAdmin) {
      base.push(
        { type: 'divider' },
        { key: '/app/users', icon: <UserOutlined />, label: '用户管理' },
        { key: '/app/teams', icon: <TeamOutlined />, label: '团队管理' },
        { key: '/app/audits', icon: <AuditOutlined />, label: '审计日志' },
      )
    }
    return base
  }, [isAdmin])

  // 当前选中：最长前缀匹配，兜底文件管理（如 /app/file/:id 详情页）
  const selectedKey = useMemo(() => {
    const keys = items.map((i) => (i && 'key' in i ? (i.key as string) : '')).filter(Boolean)
    const hit = keys.find((k) => location.pathname === k || location.pathname.startsWith(k + '/'))
    return hit ?? '/app/files'
  }, [items, location.pathname])

  const userMenuItems: MenuItem[] = [
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: logout,
    },
  ]

  return (
    <Layout.Sider
      theme="light"
      width={232}
      collapsedWidth={64}
      collapsed={collapsed}
      className="!border-r !border-solid"
      style={{ borderRight: `1px solid ${colorBorderSecondary}`, height: '100%' }}
    >
      {/* antd Sider 子容器默认非 flex，用自有容器撑满高度：品牌区在上、菜单居中、用户区沉底 */}
      <div className="flex h-full flex-col">
        {/* 品牌区（右侧为折叠开关） */}
        <div
          className={cn(
            'flex items-center shrink-0 transition-all h-56px',
            collapsed ? 'justify-center gap-8px' : 'px-12px',
          )}
        >
          <div className="w-28px h-28px rounded-6px bg-#2563EB flex items-center justify-center text-white font-bold text-15px shrink-0">
            V
          </div>
          {!collapsed && (
            <>
              <span className="ml-10px font-semibold text-15px text-rgba(0,0,0,0.88) whitespace-nowrap">
                VentoDocs
              </span>
              <span className="flex-1" />
            </>
          )}
          <button
            type="button"
            className="w-28px h-28px rounded-6px flex items-center justify-center shrink-0 cursor-pointer hover:bg-#F5F5F5"
            style={{ color: colorTextSecondary }}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <MenuUnfoldOutlined className="text-14px" /> : <MenuFoldOutlined className="text-14px" />}
          </button>
        </div>

        {/* 导航菜单 */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-8px">
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={items}
            onClick={({ key }) => {
              // 侧栏菜单 key 即路由路径
              navigate(key)
            }}
            style={{ borderInlineEnd: 'none' }}
          />
        </div>

        {/* 底部用户区 */}
        <div className="shrink-0 border-t border-solid px-8px py-10px" style={{ borderColor: colorBorderSecondary }}>
          {collapsed ? (
            <div className="flex justify-center">
              <Dropdown menu={{ items: userMenuItems }} trigger={['click']}>
                <Tooltip title={user?.display_name || user?.username} placement="right">
                  <div
                    className="w-32px h-32px rounded-full bg-#2563EB text-white flex items-center justify-center cursor-pointer text-13px"
                    style={{ color: '#fff' }}
                  >
                    {(user?.display_name || user?.username || '?').slice(0, 1).toUpperCase()}
                  </div>
                </Tooltip>
              </Dropdown>
            </div>
          ) : (
            <Dropdown menu={{ items: userMenuItems }} trigger={['click']} placement="topRight">
              <div className="flex items-center cursor-pointer rounded-6px hover:bg-#F5F5F5 px-8px py-6px">
                <div className="w-32px h-32px rounded-full bg-#2563EB flex items-center justify-center text-white text-13px shrink-0">
                  {(user?.display_name || user?.username || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="ml-10px min-w-0 flex-1">
                  <div className="text-13px font-medium text-rgba(0,0,0,0.88) truncate">
                    {user?.display_name || user?.username}
                  </div>
                  <div className="text-12px" style={{ color: colorTextSecondary }}>
                    {isAdmin ? '管理员' : '普通用户'} · {user?.username}
                  </div>
                </div>
              </div>
            </Dropdown>
          )}
        </div>
      </div>
    </Layout.Sider>
  )
}

export default SideMenu
