/**
 * 分类型文件查看器（自 VentoOS file-viewer 移植）：
 *   image    → ImageViewer：滚轮缩放 0.1–10、拖拽平移、双击复位、右下角比例徽标
 *   pdf      → PdfEmbed：浏览器内嵌 PDF 查看器（#toolbar=1&navpanes=0）
 *   video    → MediaPlayer：自定义播放控制（播放/暂停、进度、静音、音量）
 *   audio    → MediaPlayer：音频卡片（480px，大图标 + 控制条）
 *   markdown → MdView：marked 渲染 + DOMPurify 消毒
 *   text/code→ TextPre：<pre> 直显（code 用等宽字体），>4MB 仅预览前 4MB
 *   binary   → HexView：前 4KB 十六进制转储（偏移 + hex + ASCII）
 *
 * 纯展示组件，数据由 FilePreview 经 REST 拉取后注入。
 */

import DOMPurify from 'dompurify'
import { FileAudio, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useRef, useState } from 'react'

// ── 扩展名集合（VentoOS file-viewer 同款）──────────────────────
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const PDF_EXTS = new Set(['pdf'])
const MD_EXTS = new Set(['md', 'markdown'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'flv'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'wma', 'weba'])
const CODE_EXTS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'json',
  'yaml',
  'yml',
  'toml',
  'rs',
  'go',
  'py',
  'sh',
  'bash',
  'zsh',
  'css',
  'html',
  'xml',
  'sql',
  'env'
])
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'log',
  'csv',
  'tsv',
  'ini',
  'conf',
  'cfg',
  'toml',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'less',
  'scss',
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'jsonc',
  'rs',
  'py',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'php',
  'rb',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'graphql',
  'proto',
  'diff',
  'patch',
  'gitignore',
  'dockerfile',
  'makefile',
  'license',
  'readme'
])

export type ViewerKind = 'image' | 'pdf' | 'video' | 'audio' | 'markdown' | 'code' | 'text' | 'binary'

/** 文本预览上限 4MB（超出仅显示开头部分）。 */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024

const getExt = (name: string): string => {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}

/** 按扩展名分类（顺序：image → pdf → video → audio → markdown → code → text → binary）。 */
export function classifyFile(name: string): ViewerKind {
  const ext = getExt(name)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (MD_EXTS.has(ext)) return 'markdown'
  if (CODE_EXTS.has(ext)) return 'code'
  if (TEXT_EXTS.has(ext) || ext === '') return 'text'
  return 'binary'
}

/** markdown/text/code 均为文本族（可直显、可内联编辑）。 */
export const isTextFamily = (k: ViewerKind): boolean => k === 'markdown' || k === 'code' || k === 'text'

// ── 数据读取工具 ──────────────────────────────────────────────

/** 流式读取，超过 cap 即截断并标记（避免大文件全量进内存）。 */
export async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return { bytes: buf.slice(0, cap), truncated: buf.byteLength > cap }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      truncated = true
      const keep = cap - (total - value.length)
      chunks.push(value.subarray(0, Math.max(0, keep)))
      void reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  let len = 0
  for (const c of chunks) len += c.byteLength
  const out = new Uint8Array(len)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return { bytes: out, truncated }
}

/** NUL 字节检查（前 8KB）：命中则按二进制处理。 */
export function hasNulByte(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192)
  for (let i = 0; i < n; i++) if (b[i] === 0) return true
  return false
}

// ── 图片查看器（滚轮缩放 + 拖拽平移 + 双击复位）────────────────
export function ImageViewer({ url, name }: { url: string; name: string }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })

  // React onWheel 为 passive 无法 preventDefault，用原生非 passive 监听
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale(s => Math.min(10, Math.max(0.1, s * 1.0015 ** -e.deltaY)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    setDragging(true)
    const onMove = (ev: MouseEvent) => {
      setOffset({
        x: dragStart.current.ox + (ev.clientX - dragStart.current.x),
        y: dragStart.current.oy + (ev.clientY - dragStart.current.y)
      })
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const reset = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  return (
    <div
      ref={stageRef}
      className="vd-img-stage"
      role="img"
      aria-label={name}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      onMouseDown={onMouseDown}
      onDoubleClick={reset}
    >
      <img
        src={url}
        alt={name}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: 'center center',
          userSelect: 'none'
        }}
      />
      <div className="vd-scale-badge">{Math.round(scale * 100)}%</div>
    </div>
  )
}

// ── PDF 内嵌查看 ─────────────────────────────────────────────
export function PdfEmbed({ url, name }: { url: string; name: string }) {
  return <embed src={`${url}#toolbar=1&navpanes=0`} type="application/pdf" className="vd-pdf-embed" title={name} />
}

// ── 音视频播放器 ─────────────────────────────────────────────
const fmtTime = (s: number): string => {
  if (!isFinite(s) || s < 0) return '--:--'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function MediaPlayer({ url, kind, name }: { url: string; kind: 'video' | 'audio'; name: string }) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    const el = mediaRef.current
    if (el) {
      el.volume = volume
      el.muted = muted
    }
  }, [volume, muted])

  const toggle = () => {
    const el = mediaRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }

  const setRef = (node: HTMLVideoElement | HTMLAudioElement | null) => {
    mediaRef.current = node
  }

  const bar = (
    <div className="vd-media-bar">
      <button type="button" className="vd-icon-btn" onClick={toggle} title={playing ? '暂停' : '播放'}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <span className="vd-media-time">{fmtTime(current)}</span>
      <input
        className="vd-media-range"
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(current, duration || 1)}
        onChange={e => {
          const m = mediaRef.current
          if (m) m.currentTime = Number(e.target.value)
        }}
      />
      <span className="vd-media-time">{fmtTime(duration)}</span>
      <button
        type="button"
        className="vd-icon-btn"
        onClick={() => setMuted(v => !v)}
        title={muted ? '取消静音' : '静音'}
      >
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
      <input
        className="vd-media-range vol"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={e => {
          const v = Number(e.target.value)
          setVolume(v)
          setMuted(v === 0)
        }}
      />
    </div>
  )

  if (kind === 'video') {
    const stage = (
      // biome-ignore lint/a11y/noStaticElementInteractions: 点击舞台切换播放/暂停（VentoOS 同款交互）
      <div className="vd-video-stage" onClick={toggle}>
        <video
          ref={setRef}
          src={url}
          className="vd-video-el"
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={() => setCurrent(mediaRef.current?.currentTime ?? 0)}
          onLoadedMetadata={() => setDuration(mediaRef.current?.duration ?? 0)}
        />
        {!playing && (
          <div className="vd-video-play">
            <Play size={28} />
          </div>
        )}
      </div>
    )
    return (
      <div className="vd-media-wrap">
        {stage}
        {bar}
      </div>
    )
  }

  return (
    <div className="vd-media-wrap">
      <div className="vd-audio-card">
        <div className="vd-audio-head">
          <FileAudio size={34} style={{ color: 'var(--vd-accent-info)', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div className="vd-audio-name">{name}</div>
            <div className="vd-audio-sub">音频文件</div>
          </div>
        </div>
        <audio
          ref={setRef}
          src={url}
          preload="metadata"
          style={{ display: 'none' }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={() => setCurrent(mediaRef.current?.currentTime ?? 0)}
          onLoadedMetadata={() => setDuration(mediaRef.current?.duration ?? 0)}
        />
        {bar}
      </div>
    </div>
  )
}

// ── Markdown 渲染 ────────────────────────────────────────────
export function MdView({ text }: { text: string }) {
  const html = useMemo(() => {
    let raw = ''
    try {
      raw = marked.parse(text, { async: false }) as string
    } catch {
      raw = ''
    }
    return DOMPurify.sanitize(raw)
  }, [text])
  // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML 已经过 DOMPurify.sanitize 消毒
  return <div className="vd-md" dangerouslySetInnerHTML={{ __html: html }} />
}

// ── 文本 / 代码直显 ──────────────────────────────────────────
export function TextPre({ text, mono = false }: { text: string; mono?: boolean }) {
  return <pre className={mono ? 'vd-text-pre mono' : 'vd-text-pre'}>{text}</pre>
}

// ── 十六进制转储 ─────────────────────────────────────────────
const toHex = (bytes: Uint8Array, lineLen = 16): string => {
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += lineLen) {
    const row = bytes.subarray(i, i + lineLen)
    const hex = Array.from(row)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ')
      .padEnd(lineLen * 3 - 1)
    const ascii = Array.from(row)
      .map(b => (b >= 32 && b <= 127 ? String.fromCharCode(b) : '.'))
      .join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`)
  }
  return lines.join('\n')
}

export function HexView({ data, total }: { data: Uint8Array; total?: number }) {
  const preview = data.slice(0, 4096)
  return (
    <div className="vd-hex-wrap">
      {(total ?? data.length) > preview.length && (
        <div className="vd-truncate-banner">文件过大，仅显示前 4KB 十六进制</div>
      )}
      {preview.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--vd-text-tertiary)' }}>空文件</div>
      ) : (
        <pre className="vd-hex">{toHex(preview)}</pre>
      )}
    </div>
  )
}
