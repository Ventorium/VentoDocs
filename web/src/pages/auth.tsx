import { Outlet } from 'react-router'
import AuthLayout from '@/layouts/AuthLayout'

const AuthPageLayout = () => {
  return (
    <AuthLayout>
      <Outlet />
    </AuthLayout>
  )
}

export default AuthPageLayout
