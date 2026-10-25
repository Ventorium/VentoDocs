import { useEffect, useMemo, useState } from 'react'
import { Button, Empty, Spin } from 'antd'
import { DownloadOutlined, InboxOutlined } from '@ant-design/icons'
import { saveAs } from 'file-saver'
import type { FileMeta } from '@/api/schema'
import {
  getPublicPublishFileDownload,
  getPublicPublishFilePreview,
  getPublicShareFileDownload,
  getPublicShareFilePreview,
} from '@/api/public'
import { msg } from '@/components/GlobalMessage'
import DocEditor, { EDITOR_EDITABLE_EXT, EDITOR_READONLY_EXT } from '@/components/DocEditor'
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'
import { getConfig } from '@/store/config'

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
  const editorBase = getConfig().editorBase

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
      if (!editorBase) {
        return (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`「${info.label}」暂不支持在线预览${canDownload ? '，请下载后查看' : ''}`}
            style={{ padding: '80px 0' }}
          />
        )
      }
      return (
        <DocEditor
          editorBase={editorBase}
          fileName={file.name}
          fetchBytes={fetchEditorBytes}
          readonly
          baseVersion={file.current_version}
          height="calc(100vh - 320px)"
        />
      )
    }
    if (loading) return <Spin className="my-40px block" />
    if (error) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error} />
    if (info.preview === 'image' && blobUrl) {
      return (
        <div className="flex justify-center py-16px">
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
      return <pre className="text-13px leading-20px whitespace-pre-wrap break-all p-12px m-0">{text}</pre>
    }
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`「${info.label}」暂不支持在线预览${canDownload ? '，请下载后查看' : ''}`}
      />
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditorFile, editorBase, info.label, info.preview, loading, error, blobUrl, text, file, canDownload])

  return (
    <div className="flex flex-col gap-12px">
      <div className="flex items-center gap-12px flex-wrap">
        <span className="text-15px font-600">{file.name}</span>
        <span className="text-12px text-#9CA3AF">
          {[
            info.label,
            file.size > 0 ? formatBytes(file.size) : null,
            file.updated_at ? `更新于 ${formatTime(file.updated_at)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <div className="ml-auto flex items-center gap-8px">
          {file.current_version > 0 && (
            <span className="text-12px text-#9CA3AF">
              {file.current_version > 1 ? `第 ${file.current_version} 版` : '第 1 版'}
            </span>
          )}
          {canDownload && (
            <Button icon={<DownloadOutlined />} onClick={doDownload}>
              下载
            </Button>
          )}
        </div>
      </div>
      <div className="rounded-8px border-1px border-#E5E7EB bg-white overflow-hidden min-h-360px">
        {body}
      </div>
      {!loading && !error && !isEditorFile && info.preview === 'binary' && !canDownload && (
        <div className="flex items-center gap-8px text-12px text-#9CA3AF">
          <InboxOutlined />
          该分享/站点仅限预览，此文件不支持在线预览且禁止下载
        </div>
      )}
    </div>
  )
}

export default PublicFilePreview
