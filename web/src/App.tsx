import { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, useLocation, useNavigate, useRoutes } from 'react-router'
import { Spin } from 'antd'
import { XProvider } from '@ant-design/x'
import zhCN from 'antd/locale/zh_CN'
import { useAuth } from '@/store/useAuth'
import GlobalHistory from '@/components/GlobalHistory'
import GlobalMessage from '@/components/GlobalMessage'
import { AppTheme } from '@/theme'
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
      if (!logged && pathname !== '/auth/login') {
        navigate('/auth/login', { replace: true })
      }
    }
  }, [ready, logged, pathname, navigate])

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
      <GlobalHistory />
      <GlobalMessage />
      <XProvider locale={zhCN} theme={{ token: { colorPrimary: AppTheme.primaryColor } }}>
        {ready ? <_App /> : <Spin size="large" fullscreen />}
      </XProvider>
    </BrowserRouter>
  )
}

export default App
