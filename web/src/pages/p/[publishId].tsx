import { useState, type FormEvent, type ReactNode } from 'react'
import { Globe, Lock, TriangleAlert } from 'lucide-react'
import { useRequest } from 'ahooks'
import { getPublicPublishEntries, getPublicPublishMeta, verifyPublicPublishPassword } from '@/api/public'
import { PublicApiError } from '@/api/public'
import PublicBrowse from '@/components/public/PublicBrowse'
import { Btn, Tag } from '@/components/ui/kit'

/** 发布站点公开页：/p/{publishId}。 */
const PublishPublicPage = () => {
  const publishId = (window.location.pathname.split('/').filter(Boolean).pop() ?? '') as string
  // M2.26：站点 token（仅内存保存，关闭页面即失效）；login 策略 = 站点密码门
  const [siteToken, setSiteToken] = useState<string | null>(null)
  const [sitePassword, setSitePassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [gateError, setGateError] = useState<string | null>(null)

  const {
    data: meta,
    loading: metaLoading,
    error: metaError,
  } = useRequest(() => getPublicPublishMeta(publishId, siteToken ?? undefined), {
    refreshDeps: [siteToken],
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

  const doPassword = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!sitePassword) {
      setGateError('请输入站点密码')
      return
    }
    setSubmitting(true)
    setGateError(null)
    try {
      const data = await verifyPublicPublishPassword(publishId, sitePassword)
      setSiteToken(data.token)
    } catch (err) {
      setGateError(err instanceof PublicApiError ? err.message : '密码校验失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const renderPasswordGate = (hint?: string) => (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div
        className="vd-panel"
        style={{ width: 420, maxWidth: 'calc(100vw - 32px)', padding: 28 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lock size={16} style={{ color: 'var(--vd-accent)' }} />
            <span style={{ fontSize: 16, fontWeight: 600 }}>该站点需要访问密码</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--vd-text-secondary)' }}>请输入站点密码以查看内容（无需系统账号）</div>
          <div style={{ position: 'relative' }}>
            <Lock size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--vd-text-tertiary)' }} />
            <input
              className="vd-input"
              type="password"
              placeholder="请输入站点密码"
              value={sitePassword}
              onChange={(e) => setSitePassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doPassword()}
              style={{ width: '100%', paddingLeft: 32 }}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          {gateError ? <div style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{gateError}</div> : null}
          {hint && !gateError ? <div style={{ fontSize: 12, color: 'var(--vd-text-tertiary)' }}>{hint}</div> : null}
          <Btn variant="primary" loading={submitting} onClick={() => void doPassword()} style={{ width: '100%' }}>
            进入站点
          </Btn>
        </div>
      </div>
    </div>
  )

  if (metaError) {
    const e = metaError as { status?: number; code?: string; message?: string }
    if (e.status === 401) return renderPasswordGate(e.message)
    if (e.status === 410) return centerWrap(renderTerminal('站点已下线', e.message || '该发布站点已停用或目录已删除'))
    return centerWrap(renderTerminal('站点不存在', e.message))
  }

  if (!meta) return null

  // 需密码且尚未通过密码门：展示站点密码输入
  if (meta.policy === 'login' && !siteToken) return renderPasswordGate()

  const canDownload = meta.policy !== 'preview_only'

  return (
    <div style={{ minHeight: '100vh', padding: 16 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Globe size={16} style={{ color: 'var(--vd-accent)' }} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>{meta.name}</span>
          <Tag>公开站点</Tag>
          {meta.policy === 'preview_only' && <Tag>仅预览</Tag>}
          {meta.policy === 'login' && <Tag>需密码</Tag>}
          {siteToken && (
            <Btn variant="ghost" size="xs" onClick={() => { setSiteToken(null); setSitePassword('') }} style={{ marginLeft: 'auto' }}>
              退出
            </Btn>
          )}
        </div>
        <PublicBrowse
          rootName={meta.name}
          rootId={meta.directoryId}
          source={{ kind: 'publish', publishId, bearerToken: siteToken ?? undefined }}
          canDownload={canDownload}
          getEntries={(dirId) => getPublicPublishEntries(publishId, dirId, siteToken ?? undefined)}
        />
      </div>
    </div>
  )
}

export default PublishPublicPage
