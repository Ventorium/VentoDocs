import { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, useLocation, useNavigate, useRoutes } from 'react-router'
import { useAuth } from '@/store/useAuth'
import { useSettings } from '@/store/useSettings'
import { setExpiredHandler } from '@/store/token'
import { ToastHost } from '@/components/ui/toast'
import { Spin } from '@/components/ui/kit'
import routes from '~react-pages'

const AppRoutes = () => {
  return (
    <Suspense
      fallback={
        <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin />
        </div>
      }
    >
      {useRoutes(routes)}
    </Suspense>
  )
}

const _App = () => {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const {
    ready,
    computed: { logged }
  } = useAuth()

  // 401 过期：清用户，由下方守卫统一回登录页（SPA 内跳转）
  useEffect(() => {
    setExpiredHandler(() => {
      useAuth.setState({ user: null })
    })
    return () => setExpiredHandler(null)
  }, [])

  useEffect(() => {
    if (ready) {
      // 公开页（分享 /s/、发布站点 /p/）无需登录
      const isPublicPage = pathname.startsWith('/s/') || pathname.startsWith('/p/')
      if (!logged && pathname !== '/auth/login' && !isPublicPage) {
        navigate('/auth/login', { replace: true })
      }
    }
  }, [ready, logged, pathname, navigate])

  // 登录态就绪后加载桌面设置（主题/壁纸偏好）；未登录不发请求，避免 401
  useEffect(() => {
    if (ready && logged) {
      useSettings.getState().loadFromBackend().catch(() => {})
    }
  }, [ready, logged])

  return <AppRoutes />
}

function App() {
  const { init: initAuth } = useAuth()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    Promise.all([initAuth()])
      .catch(() => {})
      .then(() => {
        setReady(true)
      })
  }, [])

  return (
    <BrowserRouter>
      <ToastHost />
      {ready ? <_App /> : (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin />
        </div>
      )}
    </BrowserRouter>
  )
}

export default App
