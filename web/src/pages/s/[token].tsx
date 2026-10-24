import { useState } from 'react'
import { Button, Card, Input, Result, Spin, Tag } from 'antd'
import {
  ExclamationCircleOutlined,
  LockOutlined,
  ShareAltOutlined,
} from '@ant-design/icons'
import { useRequest } from 'ahooks'
import {
  getPublicShareEntries,
  getPublicShareMeta,
  verifyPublicSharePassword,
} from '@/api/public'
import type { FileMeta, PublicShareMeta } from '@/api/schema'
import PublicBrowse from '@/components/public/PublicBrowse'
import PublicFilePreview from '@/components/public/PublicFilePreview'
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

  if (metaError) {
    const e = metaError as { status?: number; message?: string }
    if (e.status === 410) {
      return renderTerminal('分享链接已失效', e.message || '分享内容已被删除或链接已过期')
    }
    return renderTerminal('分享链接不存在或已失效', e.message)
  }

  if (meta && meta.status === 'expired') {
    return renderTerminal('分享链接已过期', '请联系分享者重新创建分享')
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
      <div className="flex h-screen items-center justify-center bg-#F7F8FA p-16px">
        <Card className="w-full max-w-420px">
          <div className="flex flex-col items-center gap-12px">
            <LockOutlined className="text-32px text-#2563EB" />
            <div className="text-16px font-600">该分享需要访问密码</div>
            <div className="text-13px text-#9CA3AF">分享对象：{meta.name}</div>
            <Input.Password
              placeholder="请输入访问密码"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              onPressEnter={() => void doVerify()}
              autoFocus
              status={pwdError ? 'error' : undefined}
            />
            {pwdError && <div className="text-12px text-#DC2626">{pwdError}</div>}
            <Button type="primary" loading={verifying} onClick={() => void doVerify()}>
              进入
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  if (!meta) return null

  const src = { kind: 'share' as const, token, password: password ?? undefined }
  const canDownload = !meta.previewOnly

  return (
    <div className="min-h-screen bg-#F7F8FA p-16px">
      <div className="mx-auto flex max-w-1200px flex-col gap-16px">
        <div className="flex items-center gap-8px text-13px text-#9CA3AF">
          <ShareAltOutlined />
          <span>分享</span>
          {meta.previewOnly && <Tag>仅预览</Tag>}
          <span className="ml-auto">
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
