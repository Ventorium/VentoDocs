import { useState, type ReactNode } from 'react'
import { Share2, Lock, TriangleAlert } from 'lucide-react'
import { useRequest } from 'ahooks'
import {
  getPublicShareEntries,
  getPublicShareMeta,
  verifyPublicSharePassword,
} from '@/api/public'
import type { FileMeta, PublicShareMeta } from '@/api/schema'
import PublicBrowse from '@/components/public/PublicBrowse'
import PublicFilePreview from '@/components/public/PublicFilePreview'
import { Btn, Tag } from '@/components/ui/kit'
import { formatTime } from '@/lib/format'

/** 分享公开页：/s/{token}，无需登录。 */
const SharePublicPage = () => {
  const token = (window.location.pathname.split('/').filter(Boolean).pop() ?? '') as string
  // 已校验通过的密码（null = 未设置密码或尚未通过）
  const [password, setPassword] = useState<string | null>(null)
  // 密码输入框当前值
  const [passwordInput, setPasswordInput] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [pwdError, setPwdError] = useState<string | null>(null)

  const { data: meta, loading: metaLoading, error: metaError } = useRequest(
    () => getPublicShareMeta(token),
    { ready: !!token },
  )

  const centerWrap = (children: ReactNode) => (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      {children}
    </div>
  )

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

  if (metaLoading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="vd-spin" />
      </div>
    )
  }

  if (metaError) {
    const e = metaError as { status?: number; message?: string }
    if (e.status === 410) {
      return centerWrap(renderTerminal('分享链接已失效', e.message || '分享内容已被删除或链接已过期'))
    }
    return centerWrap(renderTerminal('分享链接不存在或已失效', e.message))
  }

  if (meta && meta.status === 'expired') {
    return centerWrap(renderTerminal('分享链接已过期', '请联系分享者重新创建分享'))
  }

  // 密码门：分享设置了访问密码且尚未通过校验
  if (meta && meta.hasPassword && password === null) {
    const doVerify = async () => {
      const pwd = passwordInput
      if (!pwd) {
        setPwdError('请输入访问密码')
        return
      }
      setVerifying(true)
      setPwdError(null)
      try {
        const ok = await verifyPublicSharePassword(token, pwd)
        if (ok) setPassword(pwd)
        else setPwdError('密码错误')
      } catch (e) {
        const err = e as { status?: number; message?: string }
        if (err.status === 410) {
          window.location.reload()
          return
        }
        setPwdError(err.message || '密码错误')
      } finally {
        setVerifying(false)
      }
    }
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div
          className="vd-panel"
          style={{
            width: 420,
            maxWidth: 'calc(100vw - 32px)',
            padding: 28,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <Lock size={32} style={{ color: 'var(--vd-accent)' }} />
          <div style={{ fontSize: 16, fontWeight: 600 }}>该分享需要访问密码</div>
          <div style={{ fontSize: 13, color: 'var(--vd-text-secondary)' }}>分享对象：{meta.name}</div>
          <input
            className="vd-input"
            type="password"
            placeholder="请输入访问密码"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doVerify()}
            autoFocus
            style={{ width: '100%', marginTop: 8 }}
          />
          {pwdError ? <div style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{pwdError}</div> : null}
          <Btn variant="primary" size="md" loading={verifying} onClick={() => void doVerify()} style={{ width: '100%', marginTop: 4 }}>
            进入
          </Btn>
        </div>
      </div>
    )
  }

  if (!meta) return null

  const src = { kind: 'share' as const, token, password: password ?? undefined }
  const canDownload = !meta.previewOnly

  return (
    <div style={{ minHeight: '100vh', padding: 16 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--vd-text-secondary)' }}>
          <Share2 size={15} />
          <span>分享</span>
          {meta.previewOnly ? <Tag>仅预览</Tag> : null}
          <span style={{ marginLeft: 'auto' }}>
            {meta.expiresAt ? `有效期至 ${formatTime(meta.expiresAt)}` : '永久有效'}
            {meta.maxDownloads != null &&
              ` · 剩余下载 ${Math.max(0, meta.maxDownloads - meta.downloadCount)}/${meta.maxDownloads}`}
          </span>
        </div>
        {meta.resourceType === 'directory' ? (
          <PublicBrowse
            rootName={meta.name}
            rootId={meta.resourceId}
            source={src}
            canDownload={canDownload}
            getEntries={(dirId) => getPublicShareEntries(token, dirId, password ?? undefined)}
          />
        ) : (
          <PublicFilePreview file={metaAsFileMeta(meta)} source={src} canDownload={canDownload} />
        )}
      </div>
    </div>
  )
}

// 分享元信息不含完整 FileMeta，用已知字段构造最小对象（未知字段显示为空）
function metaAsFileMeta(meta: PublicShareMeta): FileMeta {
  return {
    id: meta.resourceId,
    directory_id: '',
    name: meta.name,
    size: meta.size ?? 0,
    mime: '',
    current_version: meta.currentVersion ?? 0,
    created_by: '',
    created_at: '',
    updated_at: meta.updatedAt ?? '',
  }
}

export default SharePublicPage
