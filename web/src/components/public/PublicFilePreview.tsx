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
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'
import UniverCanvas from '@/components/UniverCanvas'

/** 与后端 vk_convert::is_supported 保持一致。 */
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls', 'csv', 'tsv'])
const DOC_EXT = new Set(['docx'])

export type PublicSource =
  | { kind: 'share'; token: string; password?: string }
  | { kind: 'publish'; publishId: string; bearerToken?: string }

type PublicFilePreviewProps = {
  file: FileMeta
  source: PublicSource
  canDownload: boolean
}

/**
 * 公开页文件预览：按扩展名分发 ——
 * Univer 快照（sheet/doc）、图片、纯文本、PDF，其余仅下载。
 */
const PublicFilePreview = ({ file, source, canDownload }: PublicFilePreviewProps) => {
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const info = fileTypeInfo(file.name)
  const univerUnit: 'sheet' | 'doc' | null = DOC_EXT.has(ext) ? 'doc' : SHEET_EXT.has(ext) ? 'sheet' : null

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null)
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
    let cancelled = false
    let revoked: string | null = null
    setLoading(true)
    setError(null)
    setSnapshot(null)
    setBlobUrl(null)
    setText(null)

    ;(async () => {
      try {
        const res = await fetcher('preview')
        const ct = res.headers.get('content-type') ?? ''
        if (univerUnit) {
          if (!ct.includes('application/json')) throw new Error('预览格式异常')
          const body = (await res.json()) as { snapshot?: Record<string, unknown> }
          if (!body.snapshot) throw new Error('预览数据为空')
          if (!cancelled) setSnapshot(body.snapshot)
        } else if (info.preview === 'image' || info.preview === 'pdf') {
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
  }, [file.id])

  const doDownload = async () => {
    try {
      const res = await fetcher('download')
      saveAs(await res.blob(), file.name)
    } catch {
      msg.error('下载失败')
    }
  }

  const body = useMemo(() => {
    if (loading) return <Spin className="my-40px block" />
    if (error) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error} />
    if (univerUnit && snapshot) {
      return <UniverCanvas snapshot={snapshot} unit={univerUnit} />
    }
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
  }, [loading, error, snapshot, blobUrl, text, univerUnit, info.preview, info.label, file.name, canDownload])

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
      {!loading && !error && !univerUnit && info.preview === 'binary' && !canDownload && (
        <div className="flex items-center gap-8px text-12px text-#9CA3AF">
          <InboxOutlined />
          该分享/站点仅限预览，此文件不支持在线预览且禁止下载
        </div>
      )}
    </div>
  )
}

export default PublicFilePreview
