import { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, useLocation, useNavigate, useRoutes } from 'react-router'
import { Spin } from 'antd'
import { XProvider } from '@ant-design/x'
import zhCN from 'antd/locale/zh_CN'
import { useAuth } from '@/store/useAuth'
import { useSettings } from '@/store/useSettings'
import GlobalHistory from '@/components/GlobalHistory'
import GlobalMessage from '@/components/GlobalMessage'
import { getAntdTheme } from '@/theme'
import routes from '~react-pages'

const AppRoutes = () => {
  return (
    <Suspense fallback={<Spin size="large" fullscreen />}>
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
  const { resolvedTheme } = useSettings()
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
      <GlobalHistory />
      <GlobalMessage />
      <XProvider locale={zhCN} theme={getAntdTheme(resolvedTheme)}>
        {ready ? <_App /> : <Spin size="large" fullscreen />}
      </XProvider>
    </BrowserRouter>
  )
}

export default App
