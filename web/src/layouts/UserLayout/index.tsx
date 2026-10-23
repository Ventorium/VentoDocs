import type { WithChildren } from '@/types'
import NavBar from './components/NavBar'

const UserLayout = ({ children }: WithChildren) => {
  return (
    <div className="w-screen h-screen flex flex-row bg-#F5F7FA">
      <nav className="w-90px flex-shrink-0 h-full">
        <NavBar />
      </nav>
      <div className="m-10px w-full">{children}</div>
    </div>
  )
}

export default UserLayout
