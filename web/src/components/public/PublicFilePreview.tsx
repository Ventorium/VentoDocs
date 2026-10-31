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
import {
  classifyFile,
  hasNulByte,
  HexView,
  ImageViewer,
  isTextFamily,
  MAX_TEXT_BYTES,
  MdView,
  MediaPlayer,
  PdfEmbed,
  readCapped,
  TextPre,
} from '@/apps/file/components/FileViewer'
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

/** Office 扩展名 = 可编辑 + 只读（与文件管理器一致，csv 不在其中 → 走文本族）。 */
const OFFICE_EXT = new Set([...EDITOR_EDITABLE_EXT, ...EDITOR_READONLY_EXT])

/**
 * 公开页文件预览（只读）：复用文件管理器的分类型查看能力
 * （M2.25）：
 *   office    → 在线编辑器 DocEditor 只读模式
 *   image     → ImageViewer（缩放/平移）
 *   pdf       → PdfEmbed
 *   video/audio → MediaPlayer
 *   markdown  → MdView
 *   text/code → TextPre（>4MB 仅前 4MB；csv/tsv 等在此直显）
 *   binary    → 前 4KB 十六进制转储
 */
const PublicFilePreview = ({ file, source, canDownload }: PublicFilePreviewProps) => {
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const info = fileTypeInfo(file.name)
  const isOffice = OFFICE_EXT.has(ext)
  const kind = classifyFile(file.name)
  const isText = isTextFamily(kind)
  const isMedia = kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio'

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [hex, setHex] = useState<Uint8Array | null>(null)

  const fetcher = (kind: 'preview' | 'download') =>
    source.kind === 'share'
      ? kind === 'preview'
        ? getPublicShareFilePreview(source.token, file.id, source.password)
        : getPublicShareFileDownload(source.token, file.id, source.password)
      : kind === 'preview'
        ? getPublicPublishFilePreview(source.publishId, file.id, source.bearerToken)
        : getPublicPublishFileDownload(source.publishId, file.id, source.bearerToken)

  useEffect(() => {
    if (isOffice) return
    let cancelled = false
    let url: string | null = null
    setLoading(true)
    setError(null)
    setBlobUrl(null)
    setText(null)
    setHex(null)
    setTruncated(false)

    ;(async () => {
      try {
        const res = await fetcher('preview')
        if (cancelled) return
        if (isMedia) {
          const blob = await res.blob()
          if (cancelled) return
          url = URL.createObjectURL(blob)
          setBlobUrl(url)
        } else if (isText) {
          const { bytes, truncated: trunc } = await readCapped(res, MAX_TEXT_BYTES)
          if (cancelled) return
          if (hasNulByte(bytes)) {
            setHex(bytes)
          } else {
            setTruncated(trunc)
            setText(new TextDecoder('utf-8').decode(bytes))
          }
        } else {
          const { bytes } = await readCapped(res, 4096)
          if (cancelled) return
          setHex(bytes)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '预览加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, isOffice])

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
    if (isOffice) {
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
    if (kind === 'image' && blobUrl) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 320px)' }}>
          <ImageViewer url={blobUrl} name={file.name} />
        </div>
      )
    }
    if (kind === 'pdf' && blobUrl) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 320px)' }}>
          <PdfEmbed url={blobUrl} name={file.name} />
        </div>
      )
    }
    if ((kind === 'video' || kind === 'audio') && blobUrl) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 320px)' }}>
          <MediaPlayer url={blobUrl} kind={kind} name={file.name} />
        </div>
      )
    }
    if (kind === 'markdown' && text !== null) {
      return <MdView text={text} />
    }
    if (isText && text !== null) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {truncated && <div className="vd-truncate-banner">文件过大，仅预览前 4MB</div>}
          <TextPre text={text} mono={kind === 'code'} />
        </div>
      )
    }
    if (hex !== null) return <HexView data={hex} total={file.size} />
    return (
      <Empty
        text={`「${info.label}」暂不支持在线预览${canDownload ? '，请下载后查看' : ''}`}
      />
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOffice, kind, isText, loading, error, blobUrl, text, truncated, hex, file, canDownload])

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
      {!loading && !error && !isOffice && kind === 'binary' && !canDownload && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--vd-text-tertiary)' }}>
          <Info size={14} />
          该分享/站点仅限预览，此文件不支持在线预览且禁止下载
        </div>
      )}
    </div>
  )
}

export default PublicFilePreview
