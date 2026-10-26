import DesktopShell from '@/shell/DesktopShell'

/**
 * 应用区根布局（M2 起）：渲染桌面外壳，不再使用 <Outlet/>。
 * 各功能页作为"应用"在窗口内直接渲染（见 shell/apps/registry），
 * 路由仍作为 URL 状态来源，由 DesktopShell 双向同步。
 */
const AppPageLayout = () => {
  return <DesktopShell />
}

export default AppPageLayout
