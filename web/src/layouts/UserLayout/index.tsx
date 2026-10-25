import type { WithChildren } from '@/types'
import { wallpaperStyle } from '@/lib/wallpapers'
import { useSettings } from '@/store/useSettings'
import SideMenu from './components/SideMenu'

/**
 * 用户主布局（VentoOS 桌面风）：
 * 根层 = 用户壁纸（无壁纸时纯色 #F7F8FA）；内容区为半透明毛玻璃卡片（.vd-page），
 * 壁纸从卡片四周透出，营造桌面 + 窗口感。
 */
const UserLayout = ({ children }: WithChildren) => {
  const { wallpaper, resolvedTheme } = useSettings()
  const bg = wallpaperStyle(wallpaper, resolvedTheme === 'dark')

  return (
    <div
      className="w-screen h-screen flex flex-row overflow-hidden"
      style={bg ?? { background: '#F7F8FA' }}
    >
      <aside className="flex-shrink-0 h-full bg-white">
        <SideMenu />
      </aside>
      <main className="flex-1 h-full overflow-auto p-16px">
        <div className="vd-page h-full flex flex-col">{children}</div>
      </main>
    </div>
  )
}

export default UserLayout
