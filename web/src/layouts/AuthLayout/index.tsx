import type { WithChildren } from '@/types'

// import loginBg from './assets/login-bg.png'

const AuthLayout = ({ children }: WithChildren) => {
  return (
    <div
      className="min-h-screen w-full flex items-center justify-end pr-20 relative"
      style={{
        // backgroundImage: `url(${loginBg})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
      }}
    >
      {children}
    </div>
  )
}

export default AuthLayout
