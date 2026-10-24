import { useState } from 'react'
import { Button, Card, Input, Result, Spin, Tag } from 'antd'
import { ExclamationCircleOutlined, GlobalOutlined, LockOutlined } from '@ant-design/icons'
import { useRequest } from 'ahooks'
import { client } from '@/api'
import { getPublicPublishEntries, getPublicPublishMeta } from '@/api/public'
import PublicBrowse from '@/components/public/PublicBrowse'

/** 发布站点公开页：/p/{publishId}。 */
const PublishPublicPage = () => {
  const publishId = (window.location.pathname.split('/').filter(Boolean).pop() ?? '') as string
  // 登录态（仅内存保存，关闭页面即失效）
  const [bearerToken, setBearerToken] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [logging, setLogging] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  const {
    data: meta,
    loading: metaLoading,
    error: metaError,
  } = useRequest(() => getPublicPublishMeta(publishId, bearerToken ?? undefined), {
    refreshDeps: [bearerToken],
  })

  if (metaLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-#F7F8FA">
        <Spin size="large" />
      </div>
    )
  }

  const renderTerminal = (title: string, sub?: string) => (
    <div className="flex h-screen items-center justify-center bg-#F7F8FA p-16px">
      <Card className="w-full max-w-480px">
        <Result
          icon={<ExclamationCircleOutlined className="text-#FAAD14" style={{ fontSize: 48 }} />}
          title={title}
          subTitle={sub && sub !== title ? sub : undefined}
        />
      </Card>
    </div>
  )

  const doLogin = async () => {
    if (!username.trim() || !password) {
      setLoginError('请输入账号和密码')
      return
    }
    setLogging(true)
    setLoginError(null)
    try {
      const { error, data } = await client.post('/api/v1/auth/login', {
        body: { username: username.trim(), password },
      })
      if (error || !data) {
        setLoginError('登录失败，请检查账号和密码')
        return
      }
      setBearerToken(data.token)
    } catch {
      setLoginError('登录失败，请检查账号和密码')
    } finally {
      setLogging(false)
    }
  }

  const renderLogin = () => (
    <div className="flex h-screen items-center justify-center bg-#F7F8FA p-16px">
      <Card className="w-full max-w-420px">
        <div className="flex flex-col gap-12px">
          <div className="flex items-center gap-8px">
            <LockOutlined className="text-#2563EB" />
            <span className="text-16px font-600">该站点需要登录</span>
          </div>
          <div className="text-13px text-#9CA3AF">使用 VentoDocs 账号登录后查看内容</div>
          <Input
            placeholder="请输入账号"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onPressEnter={() => void doLogin()}
          />
          <Input.Password
            placeholder="请输入密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onPressEnter={() => void doLogin()}
          />
          {loginError && <div className="text-12px text-#DC2626">{loginError}</div>}
          <Button type="primary" loading={logging} onClick={() => void doLogin()}>
            登录
          </Button>
        </div>
      </Card>
    </div>
  )

  if (metaError) {
    const e = metaError as { status?: number; code?: string; message?: string }
    if (e.status === 401) return renderLogin()
    if (e.status === 410) return renderTerminal('站点已下线', e.message || '该发布站点已停用或目录已删除')
    return renderTerminal('站点不存在', e.message)
  }

  if (!meta) return null

  // 需要登录且尚未登录：展示登录表单
  if (meta.policy === 'login' && !bearerToken) return renderLogin()

  const canDownload = meta.policy !== 'preview_only'

  return (
    <div className="min-h-screen bg-#F7F8FA p-16px">
      <div className="mx-auto flex max-w-1200px flex-col gap-16px">
        <div className="flex items-center gap-8px flex-wrap">
          <GlobalOutlined className="text-#2563EB" />
          <span className="text-16px font-600">{meta.name}</span>
          <Tag>公开站点</Tag>
          {meta.policy === 'preview_only' && <Tag>仅预览</Tag>}
          {bearerToken && (
            <Button type="link" size="small" onClick={() => setBearerToken(null)}>
              退出登录
            </Button>
          )}
        </div>
        <PublicBrowse
          rootName={meta.name}
          rootId={meta.directoryId}
          source={{ kind: 'publish', publishId, bearerToken: bearerToken ?? undefined }}
          canDownload={canDownload}
          getEntries={(dirId) => getPublicPublishEntries(publishId, dirId, bearerToken ?? undefined)}
        />
      </div>
    </div>
  )
}

export default PublishPublicPage
