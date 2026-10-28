import { useState, type FormEvent, type ReactNode } from 'react'
import { Globe, Lock, TriangleAlert, User } from 'lucide-react'
import { useRequest } from 'ahooks'
import { client } from '@/api'
import { getPublicPublishEntries, getPublicPublishMeta } from '@/api/public'
import PublicBrowse from '@/components/public/PublicBrowse'
import { Btn, Tag } from '@/components/ui/kit'

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

  const centerWrap = (children: ReactNode) => (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      {children}
    </div>
  )

  if (metaLoading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="vd-spin" />
      </div>
    )
  }

  const renderTerminal = (title: string, sub?: string) => (
    <div
      className="vd-panel"
      style={{
        width: 480,
        maxWidth: 'calc(100vw - 32px)',
        padding: 32,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        textAlign: 'center',
      }}
    >
      <TriangleAlert size={44} style={{ color: 'var(--vd-accent-warning)' }} />
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      {sub && sub !== title ? <div style={{ fontSize: 13, color: 'var(--vd-text-secondary)' }}>{sub}</div> : null}
    </div>
  )

  const doLogin = async (e?: FormEvent) => {
    e?.preventDefault()
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
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div
        className="vd-panel"
        style={{ width: 420, maxWidth: 'calc(100vw - 32px)', padding: 28 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lock size={16} style={{ color: 'var(--vd-accent)' }} />
            <span style={{ fontSize: 16, fontWeight: 600 }}>该站点需要登录</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--vd-text-secondary)' }}>使用 VentoDocs 账号登录后查看内容</div>
          <div style={{ position: 'relative' }}>
            <User size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--vd-text-tertiary)' }} />
            <input
              className="vd-input"
              placeholder="请输入账号"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doLogin()}
              style={{ width: '100%', paddingLeft: 32 }}
              autoFocus
            />
          </div>
          <div style={{ position: 'relative' }}>
            <Lock size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--vd-text-tertiary)' }} />
            <input
              className="vd-input"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doLogin()}
              style={{ width: '100%', paddingLeft: 32 }}
              autoComplete="current-password"
            />
          </div>
          {loginError ? <div style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{loginError}</div> : null}
          <Btn variant="primary" loading={logging} onClick={() => void doLogin()} style={{ width: '100%' }}>
            登录
          </Btn>
        </div>
      </div>
    </div>
  )

  if (metaError) {
    const e = metaError as { status?: number; code?: string; message?: string }
    if (e.status === 401) return renderLogin()
    if (e.status === 410) return centerWrap(renderTerminal('站点已下线', e.message || '该发布站点已停用或目录已删除'))
    return centerWrap(renderTerminal('站点不存在', e.message))
  }

  if (!meta) return null

  // 需要登录且尚未登录：展示登录表单
  if (meta.policy === 'login' && !bearerToken) return renderLogin()

  const canDownload = meta.policy !== 'preview_only'

  return (
    <div style={{ minHeight: '100vh', padding: 16 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Globe size={16} style={{ color: 'var(--vd-accent)' }} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>{meta.name}</span>
          <Tag>公开站点</Tag>
          {meta.policy === 'preview_only' && <Tag>仅预览</Tag>}
          {bearerToken && (
            <Btn variant="ghost" size="xs" onClick={() => setBearerToken(null)} style={{ marginLeft: 'auto' }}>
              退出登录
            </Btn>
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
