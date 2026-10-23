import type { WithChildren } from '@/types'
import SideMenu from './components/SideMenu'

const UserLayout = ({ children }: WithChildren) => {
  return (
    <div className="w-screen h-screen flex flex-row bg-#F7F8FA overflow-hidden">
      <aside className="flex-shrink-0 h-full bg-white">
        <SideMenu />
      </aside>
      <main className="flex-1 h-full overflow-auto p-16px">
        <div className="bg-white rounded-8px p-20px h-full flex flex-col">{children}</div>
      </main>
    </div>
  )
}

export default UserLayout
