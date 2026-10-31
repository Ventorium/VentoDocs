import { useEffect, useState } from 'react'
import { Lock, X } from 'lucide-react'
import { client } from '@/api'
import { Spin } from '@/components/ui/kit'
import type { Entry, FileGrantsOut, GrantItem, PublishGetOut, SharedDirOut } from '@/api/schema'
import { formatBytes, formatDateTime } from '@/lib/format'
import { PERM, permSummary } from '@/lib/perm'
import { getAccessToken } from '@/store/token'
import { useAuth } from '@/store/useAuth'

/** 文本预览上限：1MB（超出截断并提示）。 */
const TEXT_PREVIEW_LIMIT = 1048576
/** 媒体（pdf/video/audio）预览上限：1GB。 */
const MEDIA_MAX_SIZE = 1073741824

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const PDF_EXTS = new Set(['pdf'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'flv'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'wma', 'weba'])
const MARKDOWN_EXTS = new Set(['md', 'markdown'])
const CODE_EXTS = new Set(['js', 'ts', 'jsx', 'tsx', 'json', 'yaml', 'yml', 'toml', 'rs', 'go', 'py', 'sh', 'bash', 'zsh', 'css', 'html', 'xml', 'sql', 'env'])
const TEXT_EXTS = new Set(
  'txt.md.markdown.log.csv.tsv.ini.conf.cfg.toml.yaml.yml.xml.html.htm.css.less.scss.js.jsx.ts.tsx.json.jsonc.rs.py.go.java.c.cpp.h.hpp.cs.php.rb.sh.bash.zsh.fish.ps1.bat.cmd.sql.graphql.proto.diff.patch.gitignore.dockerfile.makefile.license.readme'.split('.'),
)

/** 取扩展名（小写）；无扩展名返回空串。 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : ''
}

/** 按扩展名归类预览类型：image/pdf/video/audio/markdown/code/text/binary。 */
function kindOf(name: string): string {
  const t = extOf(name)
  if (IMAGE_EXTS.has(t)) return 'image'
  if (PDF_EXTS.has(t)) return 'pdf'
  if (VIDEO_EXTS.has(t)) return 'video'
  if (AUDIO_EXTS.has(t)) return 'audio'
  if (MARKDOWN_EXTS.has(t)) return 'markdown'
  if (CODE_EXTS.has(t)) return 'code'
  if (TEXT_EXTS.has(t) || t === '') return 'text'
  return 'binary'
}

function isTextKind(kind: string | null): boolean {
  return kind === 'markdown' || kind === 'code' || kind === 'text'
}

/** 前 8KB 出现 NUL 判定为二进制。 */
function isBinaryBytes(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/** 流式读取至多 limit 字节；超出截断（truncated=true）。 */
async function readLimited(res: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return { bytes: buf.slice(0, limit), truncated: buf.byteLength > limit }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      truncated = true
      const take = limit - (total - value.length)
      chunks.push(value.subarray(0, Math.max(0, take)))
      reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  const out = new Uint8Array(truncated ? limit : total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return { bytes: out, truncated }
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

/** 统计有效分享链接数：未吊销且未过期。 */
function activeLinkCount(shares: { revoked: boolean; expires_at: string | null }[]): number {
  const now = Date.now()
  return shares.filter((s) => !s.revoked && (!s.expires_at || new Date(s.expires_at).getTime() > now)).length
}

type TextState = { status: 'idle' | 'loading' | 'ready' | 'binary'; text?: string; truncated?: boolean }

/** 权限列表行（M2.23：文件 = 本文件授权 + 继承目录授权合并）。 */
type GrantRow = {
  id: string
  principal_type: 'user' | 'team'
  principal_id: string
  principal_name: string
  perms: number
  /** M2.23：file=本文件独立授权（覆盖继承），dir=继承自所在目录 */
  source: 'file' | 'dir'
}

/** M2.21：父级传入的共享作用域信息（sharedMeta=该条目在分享给我/团队共享中的元信息）。 */
type PanelContext = {
  sharedMeta?: SharedDirOut
  scope?: string
}

/**
 * 右侧属性预览面板（M2.18b 引入，M2.21 共享列适配，M2.23 文件级权限）。
 *
 * - 目录：元信息 + 分享状态 + 目录授权列表（M2.21 起目录无内容预览）。
 * - 文件：元信息 + 分享状态 + 授权列表（M2.23：本文件独立授权 + 所在目录继承授权，
 *   同一主体存在本文件授权时以文件授权为准覆盖继承，行尾标「本文件/继承」）
 *   + 内容预览（图片 / 文本(1MB 截断) / pdf / 视频 / 音频）。
 *
 * M2.23 分享状态格式：
 * - 有授权（目录）：`已分享（N）`，有链接时 `已分享（N · 链接 K）`
 * - 有授权（文件）：`已分享（授权 N）`，有链接时 `已分享（授权 N · 链接 K）`
 * - 无授权但在共享作用域：`已分享 · 来自 {owner}（{team}） · {权限摘要}` / `已分享`
 * - 无授权但有链接：`已分享（链接 K）`
 * - 加载中：`加载中…`；否则 `未分享`
 */
export default function FileInfoPanel({
  entry,
  onClose,
  context,
}: {
  entry: Entry | null
  onClose: () => void
  context?: PanelContext | null
}) {
  const isDir = entry?.kind === 'directory'
  const file = entry?.kind === 'file' ? entry.file : null
  /** M2.37：文件锁状态（entry 级），用于属性面板「锁定」行与标题锁图标。 */
  const fileLock = entry?.kind === 'file' ? entry.lock : null
  const ext = file ? extOf(file.name) : ''
  const kind = file ? kindOf(file.name) : null
  const isImage = kind === 'image'
  const isText = isTextKind(kind)
  const isPdf = kind === 'pdf'
  const isVideo = kind === 'video'
  const isMedia = isPdf || isVideo || kind === 'audio'
  const dirId = isDir && entry ? entry.directory.id : file?.directory_id ?? null
  // M2.38：授权列表 / 分享链接 / 发布状态仅创建者（或管理员）可见；
  // 后端对非创建者返回 403，前端跳过请求，避免控制台 403 噪音。
  const { user: me } = useAuth()
  const entryCreatedBy = isDir ? entry?.directory?.created_by : file?.created_by
  const isCreator = !!me && !!entryCreatedBy && entryCreatedBy === me.id
  const myPerms = entry ? entry.my_perms : 0
  const canSeePublish = isCreator || me?.role === 'admin' || (myPerms & PERM.PUBLISH) === PERM.PUBLISH

  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [imgLoading, setImgLoading] = useState(false)
  const [textState, setTextState] = useState<TextState>({ status: 'idle' })
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [grantRows, setGrantRows] = useState<GrantRow[] | null>(null)
  const [grantsFailed, setGrantsFailed] = useState(false)
  const [fileGrantIds, setFileGrantIds] = useState<Set<string>>(new Set())
  const [linkCount, setLinkCount] = useState<number | null>(null)
  // M2.26：目录的网站发布状态（仅目录查询）
  const [pubInfo, setPubInfo] = useState<PublishGetOut | null>(null)
  const [pubFailed, setPubFailed] = useState(false)

  // 授权列表：目录 → /directories/{id}/grants；文件 → /files/{id}/grants（本文件 + 继承）。
  useEffect(() => {
    setGrantRows(null)
    setGrantsFailed(false)
    setFileGrantIds(new Set())
    if (!entry || !dirId) return
    if (!isCreator) {
      // M2.38：授权列表仅创建者可查（后端 403），非创建者置空、隐藏该区块。
      setGrantRows([])
      return
    }
    let alive = true
    if (isDir && entry) {
      void client.get('/api/v1/directories/{id}/grants', { params: { id: dirId } }).then(({ error, data }) => {
        if (!alive) return
        if (error || !data) {
          setGrantsFailed(true)
          return
        }
        setGrantRows(
          (data.grants ?? []).map((g: GrantItem): GrantRow => ({
            id: g.id,
            principal_type: g.principal_type,
            principal_id: g.principal_id,
            principal_name: g.principal_name,
            perms: g.perms,
            source: 'dir',
          })),
        )
      })
    } else if (file) {
      void client
        .get('/api/v1/files/{id}/grants', { params: { id: file.id } })
        .then(({ error, data }: { error: unknown; data: FileGrantsOut | undefined }) => {
          if (!alive) return
          if (error || !data) {
            setGrantsFailed(true)
            return
          }
          const fg = data.file_grants ?? []
          const inherited = data.inherited?.grants ?? []
          const fileKeys = new Set(fg.map((g) => `${g.principal_type}:${g.principal_id}`))
          setFileGrantIds(new Set(fg.map((g) => g.id)))
          const rows: GrantRow[] = [
            ...fg.map((g): GrantRow => ({
              id: g.id,
              principal_type: g.principal_type,
              principal_id: g.principal_id,
              principal_name: g.principal_name,
              perms: g.perms,
              source: 'file',
            })),
            ...inherited
              .filter((g) => !fileKeys.has(`${g.principal_type}:${g.principal_id}`))
              .map((g): GrantRow => ({
                id: g.id,
                principal_type: g.principal_type,
                principal_id: g.principal_id,
                principal_name: g.principal_name,
                perms: g.perms,
                source: 'dir',
              })),
          ]
          setGrantRows(rows)
        })
    }
    return () => {
      alive = false
    }
  }, [entry, dirId, isDir, file, isCreator])

  // M2.26：目录的网站发布状态
  useEffect(() => {
    setPubInfo(null)
    setPubFailed(false)
    if (!isDir || !dirId) return
    // M2.38：发布状态查询需 PUBLISH 位（创建者/管理员/持 PUBLISH 授权），无则跳过避免 403。
    if (!canSeePublish) {
      setPubFailed(true)
      return
    }
    let alive = true
    void client.get('/api/v1/directories/{id}/publish', { params: { id: dirId } }).then(({ error, data }) => {
      if (!alive) return
      if (error || !data) {
        setPubFailed(true)
        return
      }
      setPubInfo(data)
    })
    return () => {
      alive = false
    }
  }, [entry, dirId, isDir, canSeePublish])

  // M2.23：分享链接计数（未吊销且未过期）；403/失败 → null（不显示链接部分）。
  useEffect(() => {
    setLinkCount(null)
    if (!entry) return
    // M2.38：分享链接列表仅创建者可查（后端 403），非创建者保持 null（不显示链接数）。
    if (!isCreator) return
    let alive = true
    const rid = isDir && entry ? entry.directory.id : file?.id
    if (!rid) return
    void client
      .get('/api/v1/shares', { query: { resource_type: isDir && entry ? 'directory' : 'file', resource_id: rid } })
      .then(({ error, data }: { error: unknown; data: { shares?: { revoked: boolean; expires_at: string | null }[] } | undefined }) => {
        if (!alive || error || !data) return
        setLinkCount(activeLinkCount(data.shares ?? []))
      })
    return () => {
      alive = false
    }
  }, [entry, isDir, file, isCreator])

  // 图片预览：content → objectURL。
  useEffect(() => {
    if (!file || !isImage) {
      setImgSrc(null)
      setImgLoading(false)
      return
    }
    setImgSrc(null)
    setImgLoading(true)
    const ctrl = new AbortController()
    let url: string | null = null
    const token = getAccessToken()
    fetch(`/api/v1/files/${file.id}/content`, {
      signal: ctrl.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.blob()
      })
      .then((blob) => {
        if (ctrl.signal.aborted) return
        url = URL.createObjectURL(blob)
        setImgSrc(url)
        setImgLoading(false)
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted && !(err instanceof DOMException && err.name === 'AbortError')) {
          setImgSrc(null)
          setImgLoading(false)
        }
      })
    return () => {
      ctrl.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [file, isImage])

  // 文本预览：1MB 截断、二进制检测、JSON 美化；加载失败回退为二进制提示。
  useEffect(() => {
    if (!file || !isText) {
      setTextState({ status: 'idle' })
      return
    }
    let alive = true
    setTextState({ status: 'loading' })
    const ctrl = new AbortController()
    const token = getAccessToken()
    fetch(`/api/v1/files/${file.id}/content`, {
      signal: ctrl.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const { bytes, truncated } = await readLimited(res, TEXT_PREVIEW_LIMIT)
        if (!alive) return
        if (isBinaryBytes(bytes)) {
          setTextState({ status: 'binary' })
          return
        }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        setTextState({ status: 'ready', text: ext === 'json' ? prettyJson(text) : text, truncated })
      })
      .catch((err: unknown) => {
        if (alive && !(err instanceof DOMException && err.name === 'AbortError')) setTextState({ status: 'binary' })
      })
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [file, isText, ext])

  // 媒体（pdf/video/audio）预览：1GB 上限。
  useEffect(() => {
    if (!file || !isMedia) {
      setMediaUrl(null)
      setMediaLoading(false)
      setMediaError(null)
      return
    }
    setMediaUrl(null)
    setMediaError(null)
    if (file.size > MEDIA_MAX_SIZE) {
      setMediaError('文件过大，无法预览')
      return
    }
    setMediaLoading(true)
    const ctrl = new AbortController()
    let url: string | null = null
    const token = getAccessToken()
    fetch(`/api/v1/files/${file.id}/content`, {
      signal: ctrl.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.blob()
      })
      .then((blob) => {
        if (ctrl.signal.aborted) return
        url = URL.createObjectURL(blob)
        setMediaUrl(url)
        setMediaLoading(false)
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted && !(err instanceof DOMException && err.name === 'AbortError')) {
          setMediaLoading(false)
          setMediaError('媒体加载失败')
        }
      })
    return () => {
      ctrl.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [file, isMedia])

  if (!entry) return null

  const dir = isDir ? entry.directory : null
  const name = isDir ? (dir ? dir.name : '') : (file ? file.name : '')

  // M2.23：分享状态（授权优先；文件 = 本文件授权 ∪ 继承目录授权）。
  const sharedMeta = context?.sharedMeta
  const inSharedScope = !!sharedMeta || (context != null && context.scope !== 'personal')
  let shareStatus: string
  let sharedOn = false
  if (grantRows !== null && grantRows.length > 0) {
    const links = linkCount ?? 0
    if (isDir) {
      shareStatus = links > 0 ? `已分享（${grantRows.length} · 链接 ${links}）` : `已分享（${grantRows.length}）`
    } else {
      shareStatus = links > 0 ? `已分享（授权 ${grantRows.length} · 链接 ${links}）` : `已分享（授权 ${grantRows.length}）`
    }
    sharedOn = true
  } else if (inSharedScope) {
    shareStatus = sharedMeta
      ? `已分享 · 来自 ${sharedMeta.owner_name || '其他用户'}${sharedMeta.team_name ? `（${sharedMeta.team_name}）` : ''} · ${permSummary(sharedMeta.perms)}`
      : '已分享'
    sharedOn = true
  } else if (linkCount !== null && linkCount > 0) {
    shareStatus = `已分享（链接 ${linkCount}）`
    sharedOn = true
  } else {
    // 非创建者无法查看分享/授权信息（后端 403），不显示"未分享"误导
    shareStatus = isCreator ? (grantRows === null ? '加载中…' : '未分享') : '—'
  }

  // M2.26：发布状态文案（仅目录）
  let pubStatus = ''
  let pubOn = false
  let pubUrl: string | null = null
  if (isDir) {
    if (pubFailed) {
      pubStatus = '—'
    } else if (pubInfo === null) {
      pubStatus = '加载中…'
    } else if (!pubInfo.publish) {
      pubStatus = '未发布'
    } else if (!pubInfo.publish.enabled) {
      pubStatus = '已下线'
    } else {
      const pl = pubInfo.publish.policy
      const sm = pubInfo.publish.site_mode
      pubStatus =
        '已发布 · ' + (pl === 'anon' ? '公开' : pl === 'login' ? '需密码' : '仅预览') +
        (sm ? ' · ' + (sm === 'static' ? '纯静态' : sm === 'spa' ? 'SPA' : sm === 'file_index' ? '文件列表' : sm) : '')
      pubOn = true
      pubUrl = pubInfo.url
    }
  }

  return (
    <div className="vd-fm-preview">
      <div className="vd-fm-preview-head">
        <span className="vd-fm-preview-name truncate" title={name}>
          {name}
        </span>
        {fileLock && (
          <Lock
            size={13}
            style={{ flexShrink: 0, color: 'var(--vd-accent-warning, #d97706)' }}
            aria-label="已锁定"
          />
        )}
        <button type="button" className="vd-fm-preview-close" onClick={onClose} aria-label="关闭预览">
          <X size={12} />
        </button>
      </div>
      <div className="vd-fm-preview-meta">
        <div>
          <span className="vd-fm-meta-label">类型</span>
          <span>{isDir ? '目录' : ext ? ext.toUpperCase() : '文件'}</span>
        </div>
        {!isDir && file && (
          <div>
            <span className="vd-fm-meta-label">大小</span>
            <span>{formatBytes(file.size)}</span>
          </div>
        )}
        <div>
          <span className="vd-fm-meta-label">{isDir ? '创建时间' : '修改时间'}</span>
          <span>{formatDateTime(isDir ? (dir ? dir.created_at : null) : file ? file.updated_at : null)}</span>
        </div>
        {file && (
          <div>
            <span className="vd-fm-meta-label">锁定</span>
            {fileLock ? (
              <span style={{ color: 'var(--vd-accent-warning, #d97706)', fontWeight: 600 }}>
                已锁定 · {fileLock.locked_by_name}（{formatDateTime(fileLock.locked_at)}）
              </span>
            ) : (
              <span>未锁定</span>
            )}
          </div>
        )}
        <div>
          <span className="vd-fm-meta-label">分享</span>
          <span className={sharedOn ? 'vd-fm-share-on' : undefined}>{shareStatus}</span>
        </div>
        {isDir ? (
          <div>
            <span className="vd-fm-meta-label">发布</span>
            <span className={pubOn ? 'vd-fm-share-on' : undefined}>{pubStatus}</span>
          </div>
        ) : null}
        {isDir && pubUrl ? (
          <div>
            <span className="vd-fm-meta-label">站点地址</span>
            <span className="vd-fm-pub-url" title={pubUrl}>{pubUrl}</span>
          </div>
        ) : null}
        {isText && textState.status === 'ready' && textState.truncated ? (
          <div className="vd-fm-truncated">仅预览前 1MB</div>
        ) : null}
      </div>
      {!grantsFailed && grantRows && grantRows.length > 0 && (
        <div className="vd-fm-preview-grants">
          {grantRows.map((g) => (
            <div key={g.id} className="vd-fm-preview-grant-item">
              <span className="truncate">
                {g.principal_name}
                {g.principal_type === 'team' ? '（团队）' : ''}
              </span>
              <span className="vd-faint">
                {permSummary(g.perms)}
                {!isDir ? (g.source === 'file' ? ' · 本文件' : ' · 继承') : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="vd-fm-preview-body">
        {isImage ? (
          imgLoading ? (
            <div className="vd-fm-preview-center">
              <Spin text="" />
            </div>
          ) : imgSrc ? (
            <img src={imgSrc} alt={name} className="vd-fm-preview-img" />
          ) : (
            <div className="vd-fm-preview-center vd-faint">图片加载失败</div>
          )
        ) : isText ? (
          textState.status === 'loading' ? (
            <div className="vd-fm-preview-center">
              <Spin text="" />
            </div>
          ) : textState.status === 'binary' ? (
            <div className="vd-fm-preview-bin">二进制文件，无法预览</div>
          ) : textState.status === 'ready' ? (
            <pre className={`vd-fm-preview-text${kind === 'code' ? ' vd-fm-preview-mono' : ''}`}>{textState.text}</pre>
          ) : null
        ) : isDir ? (
          null
        ) : isMedia ? (
          mediaLoading ? (
            <div className="vd-fm-preview-center">
              <Spin text="" />
            </div>
          ) : mediaError ? (
            <div className="vd-fm-preview-bin">{mediaError}</div>
          ) : mediaUrl ? (
            isPdf ? (
              <iframe src={`${mediaUrl}#toolbar=1&navpanes=0`} title={name} className="vd-fm-preview-pdf" />
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
