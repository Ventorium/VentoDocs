import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { Entry } from '@/api/schema'
import { classifyFile, hasNulByte, isTextFamily, readCapped } from '@/apps/file/components/FileViewer'
import { Spin } from '@/components/ui/kit'
import { getAccessToken } from '@/store/token'
import { formatBytes, formatDateTime } from '@/lib/format'

const TEXT_PREVIEW_CAP = 1024 * 1024
const MEDIA_PREVIEW_CAP = 1024 * 1024 * 1024 // pdf/video/audio 预览上限，避免大文件全量进内存

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

type TextPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'binary' }
  | { status: 'ready'; text: string; truncated: boolean }

/**
 * 右侧单选预览面板（对齐 VentoOS FileInfoPanel）：
 * 图片 → 自行抓取原始字节（objectURL）；pdf/video/audio → 抓取全文件（objectURL，1GB 上限）
 * 以原生组件呈现；文本族 → 抓取前 1MB 以 pre 呈现（JSON 自动格式化，截断时标注）；
 * 其余二进制 → 直接提示，不发起请求。
 */
const FileInfoPanel = ({ entry, onClose }: { entry: Entry | null; onClose: () => void }) => {
  const file = entry?.kind === 'file' ? entry.file : null
  const kind = file ? classifyFile(file.name) : null
  const isImage = kind === 'image'
  const isText = kind !== null && isTextFamily(kind)
  const isDir = entry?.kind === 'directory'
  const isPdf = kind === 'pdf'
  const isVideo = kind === 'video'
  const isAudio = kind === 'audio'
  const isMedia = isPdf || isVideo || isAudio

  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [imgLoading, setImgLoading] = useState(false)
  const [textPreview, setTextPreview] = useState<TextPreviewState>({ status: 'idle' })
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)

  // 图片预览：清旧 → 抓取原始字节 → objectURL；变更/卸载时 abort + revoke。
  useEffect(() => {
    if (!file || !isImage) {
      setImgSrc(null)
      setImgLoading(false)
      return
    }
    setImgSrc(null)
    setImgLoading(true)
    const ac = new AbortController()
    let url: string | null = null
    const token = getAccessToken()
    fetch(`/api/v1/files/${file.id}/content`, {
      signal: ac.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.blob()
      })
      .then((blob) => {
        if (ac.signal.aborted) return
        url = URL.createObjectURL(blob)
        setImgSrc(url)
        setImgLoading(false)
      })
      .catch((e) => {
        if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return
        setImgSrc(null)
        setImgLoading(false)
      })
    return () => {
      ac.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [file, isImage])

  // 媒体预览（pdf/video/audio）：整文件抓取为 objectURL；变更/卸载时 abort + revoke。
  useEffect(() => {
    if (!file || !isMedia) {
      setMediaUrl(null)
      setMediaLoading(false)
      setMediaError(null)
      return
    }
    setMediaUrl(null)
    setMediaError(null)
    if (file.size > MEDIA_PREVIEW_CAP) {
      setMediaError('文件过大，无法预览')
      return
    }
    setMediaLoading(true)
    const ac = new AbortController()
    let url: string | null = null
    const token = getAccessToken()
    fetch(`/api/v1/files/${file.id}/content`, {
      signal: ac.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.blob()
      })
      .then((blob) => {
        if (ac.signal.aborted) return
        url = URL.createObjectURL(blob)
        setMediaUrl(url)
        setMediaLoading(false)
      })
      .catch((e) => {
        if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return
        setMediaUrl(null)
        setMediaLoading(false)
        setMediaError('媒体加载失败')
      })
    return () => {
      ac.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [file, isMedia])

  // 文本族预览：前 1MB；NUL 字节判二进制；JSON 格式化。
  useEffect(() => {
    if (!file || !isText) {
      setTextPreview({ status: 'idle' })
      return
    }
    let alive = true
    setTextPreview({ status: 'loading' })
    const ac = new AbortController()
    const token = getAccessToken()
    fetch(`/api/v1/files/${file.id}/content`, {
      signal: ac.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return readCapped(res, TEXT_PREVIEW_CAP).then(({ bytes, truncated }) => {
          if (!alive) return
          if (hasNulByte(bytes)) {
            setTextPreview({ status: 'binary' })
            return
          }
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
          const ext = fileExt(file.name)
          setTextPreview({ status: 'ready', text: ext === 'json' ? tryFormatJson(text) : text, truncated })
        })
      })
      .catch((e) => {
        if (!alive || (e as Error)?.name === 'AbortError') return
        setTextPreview({ status: 'binary' })
      })
    return () => {
      alive = false
      ac.abort()
    }
  }, [file, isText])

  if (!entry) return null

  const ext = entry.kind === 'file' ? fileExt(entry.file.name) : ''

  return (
    <div className="vd-fm-preview">
      <div className="vd-fm-preview-head">
        <span className="vd-fm-preview-name truncate" title={isDir ? entry.directory.name : entry.file.name}>
          {isDir ? entry.directory.name : entry.file.name}
        </span>
        <button type="button" className="vd-fm-preview-close" onClick={onClose} aria-label="关闭预览">
          <X size={12} />
        </button>
      </div>
      <div className="vd-fm-preview-meta">
        <div>
          <span className="vd-fm-meta-label">类型</span>
          <span>{isDir ? '目录' : ext ? ext.toUpperCase() : '文件'}</span>
        </div>
        {entry.kind === 'file' && (
          <div>
            <span className="vd-fm-meta-label">大小</span>
            <span>{formatBytes(entry.file.size)}</span>
          </div>
        )}
        <div>
          <span className="vd-fm-meta-label">{isDir ? '创建时间' : '修改时间'}</span>
          <span>
            {formatDateTime(isDir ? entry.directory.created_at : entry.file.updated_at)}
          </span>
        </div>
        {textPreview.status === 'ready' && textPreview.truncated && (
          <div className="vd-fm-truncated">仅预览前 1MB</div>
        )}
      </div>
      <div className="vd-fm-preview-body">
        {isImage ? (
          imgLoading ? (
            <div className="vd-fm-preview-center">
              <Spin text="" />
            </div>
          ) : imgSrc ? (
            <img src={imgSrc} alt={file?.name ?? ''} className="vd-fm-preview-img" />
          ) : (
            <div className="vd-fm-preview-center vd-faint">图片加载失败</div>
          )
        ) : isText ? (
          textPreview.status === 'loading' ? (
            <div className="vd-fm-preview-center">
              <Spin text="" />
            </div>
          ) : textPreview.status === 'binary' ? (
            <div className="vd-fm-preview-bin">二进制文件，无法预览</div>
          ) : textPreview.status === 'ready' ? (
            <pre className={`vd-fm-preview-text${kind === 'code' ? ' vd-fm-preview-mono' : ''}`}>
              {textPreview.text}
            </pre>
          ) : null
        ) : isDir ? null : isMedia ? (
          mediaLoading ? (
            <div className="vd-fm-preview-center">
              <Spin text="" />
            </div>
          ) : mediaError ? (
            <div className="vd-fm-preview-bin">{mediaError}</div>
          ) : mediaUrl ? (
            isPdf ? (
              <iframe src={`${mediaUrl}#toolbar=1&navpanes=0`} title={file.name} className="vd-fm-preview-pdf" />
            ) : isVideo ? (
              <video src={mediaUrl} controls className="vd-fm-preview-video" />
            ) : (
              <audio src={mediaUrl} controls className="vd-fm-preview-audio" />
            )
          ) : (
            <div className="vd-fm-preview-center vd-faint">加载中…</div>
          )
        ) : (
          <div className="vd-fm-preview-bin">二进制文件，无法预览</div>
        )}
      </div>
    </div>
  )
}

export default FileInfoPanel
