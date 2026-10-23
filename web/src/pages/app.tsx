import { Outlet } from 'react-router'
import UserLayout from '@/layouts/UserLayout'

const AppPageLayout = () => {
  return (
    <UserLayout>
      <Outlet />
    </UserLayout>
  )
}

export default AppPageLayout
