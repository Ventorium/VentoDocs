import type { WithChildren } from '@/types'

/**
 * 登录页布局（VentoOS 风格）：全屏壁纸 + 压暗 scrim，内容居中。
 * 壁纸用内置极光；登录前的 useSettings 尚未从后端加载，不做动态壁纸。
 */
const LOGIN_BG = '/wallpapers/dark-aurora.jpg'

const AuthLayout = ({ children }: WithChildren) => {
  return (
    <div
      className="min-h-screen w-full flex items-center justify-center relative overflow-hidden"
      style={{
        background: `url('${LOGIN_BG}') center / cover no-repeat`,
        backgroundColor: '#0a0e1a'
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'linear-gradient(rgba(10, 12, 18, 0.42), rgba(10, 12, 18, 0.58))' }}
      />
      <div className="relative z-10 flex items-center justify-center w-full">{children}</div>
    </div>
  )
}

export default AuthLayout
