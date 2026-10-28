import { useEffect, useMemo, useState } from 'react'
import { Download, Info } from 'lucide-react'
import { saveAs } from 'file-saver'
import type { FileMeta } from '@/api/schema'
import {
  getPublicPublishFileDownload,
  getPublicPublishFilePreview,
  getPublicShareFileDownload,
  getPublicShareFilePreview,
} from '@/api/public'
import { msg } from '@/components/ui/toast'
import DocEditor, { EDITOR_EDITABLE_EXT, EDITOR_READONLY_EXT } from '@/components/DocEditor'
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'
import { Btn, Empty, Spin } from '@/components/ui/kit'

export type PublicSource =
  | { kind: 'share'; token: string; password?: string }
  | { kind: 'publish'; publishId: string; bearerToken?: string }

type PublicFilePreviewProps = {
  file: FileMeta
  source: PublicSource
  canDownload: boolean
}

/**
 * 公开页文件预览（只读）：Office 走在线编辑器只读模式，
 * 图片/PDF 走 Blob URL，纯文本直显，其余仅下载。
 */
const PublicFilePreview = ({ file, source, canDownload }: PublicFilePreviewProps) => {
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const info = fileTypeInfo(file.name)
  const isEditorFile = EDITOR_EDITABLE_EXT.has(ext) || EDITOR_READONLY_EXT.has(ext)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)

  const fetcher = (kind: 'preview' | 'download') =>
    source.kind === 'share'
      ? kind === 'preview'
        ? getPublicShareFilePreview(source.token, file.id, source.password)
        : getPublicShareFileDownload(source.token, file.id, source.password)
      : kind === 'preview'
        ? getPublicPublishFilePreview(source.publishId, file.id, source.bearerToken)
        : getPublicPublishFileDownload(source.publishId, file.id, source.bearerToken)

  useEffect(() => {
    if (isEditorFile) return
    let cancelled = false
    let revoked: string | null = null
    setLoading(true)
    setError(null)
    setBlobUrl(null)
    setText(null)

    ;(async () => {
      try {
        const res = await fetcher('preview')
        if (info.preview === 'image' || info.preview === 'pdf') {
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          revoked = url
          setBlobUrl(url)
        } else if (info.preview === 'text') {
          const t = await res.text()
          if (!cancelled) setText(t)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '预览加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, isEditorFile])

  const doDownload = async () => {
    try {
      const res = await fetcher('download')
      saveAs(await res.blob(), file.name)
    } catch {
      msg.error('下载失败')
    }
  }

  const fetchEditorBytes = async () => {
    const res = await fetcher('preview')
    return await res.arrayBuffer()
  }

  const body = useMemo(() => {
    if (isEditorFile) {
      return (
        <DocEditor
          fileName={file.name}
          fetchBytes={fetchEditorBytes}
          readonly
          baseVersion={file.current_version}
          height="calc(100vh - 320px)"
        />
      )
    }
    if (loading) return <div style={{ padding: '40px 0' }}><Spin /></div>
    if (error) return <Empty text={error} />
    if (info.preview === 'image' && blobUrl) {
      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
          <img src={blobUrl} alt={file.name} style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 280px)' }} />
        </div>
      )
    }
    if (info.preview === 'pdf' && blobUrl) {
      return (
        <iframe
          src={blobUrl}
          title={file.name}
          style={{ width: '100%', height: 'calc(100vh - 280px)', border: 'none', borderRadius: 8 }}
        />
      )
    }
    if (info.preview === 'text' && text !== null) {
      return <pre style={{ fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: 12, margin: 0 }}>{text}</pre>
    }
    return (
      <Empty
        text={`「${info.label}」暂不支持在线预览${canDownload ? '，请下载后查看' : ''}`}
      />
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditorFile, info.label, info.preview, loading, error, blobUrl, text, file, canDownload])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--vd-text-primary)' }}>{file.name}</span>
        <span style={{ fontSize: 12, color: 'var(--vd-text-tertiary)' }}>
          {[
            info.label,
            file.size > 0 ? formatBytes(file.size) : null,
            file.updated_at ? `更新于 ${formatTime(file.updated_at)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {file.current_version > 0 && (
            <span style={{ fontSize: 12, color: 'var(--vd-text-tertiary)' }}>
              {file.current_version > 1 ? `第 ${file.current_version} 版` : '第 1 版'}
            </span>
          )}
          {canDownload && (
            <Btn size="sm" onClick={() => void doDownload()}>
              <Download size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              下载
            </Btn>
          )}
        </div>
      </div>
      <div className="vd-panel" style={{ overflow: 'hidden', minHeight: 360 }}>
        {body}
      </div>
      {!loading && !error && !isEditorFile && info.preview === 'binary' && !canDownload && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--vd-text-tertiary)' }}>
          <Info size={14} />
          该分享/站点仅限预览，此文件不支持在线预览且禁止下载
        </div>
      )}
    </div>
  )
}

export default PublicFilePreview
