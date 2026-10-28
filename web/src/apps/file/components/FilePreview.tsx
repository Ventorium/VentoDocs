import { useEffect, useState, type MutableRefObject } from 'react'
import { fetchFileContent } from '@/api'
import type { FileMeta } from '@/api/schema'
import DocEditor, { EDITOR_EDITABLE_EXT, EDITOR_READONLY_EXT } from '@/components/DocEditor'
import FileIcon from '@/components/FileIcon'
import { Spin } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { getConfig } from '@/store/config'
import { getAccessToken } from '@/store/token'
import {
  classifyFile,
  HexView,
  hasNulByte,
  ImageViewer,
  isTextFamily,
  MAX_TEXT_BYTES,
  MdView,
  MediaPlayer,
  PdfEmbed,
  readCapped,
  TextPre
} from './FileViewer'

type FilePreviewProps = {
  file: FileMeta
  /** 是否处于在线编辑模式（有修改权限且持有锁时开启）。 */
  editable: boolean
  onExitEdit: () => void
  /** 保存成功回调（父级刷新文件详情）。 */
  onSaved: () => void
  /** 版本冲突后重新加载（父级刷新文件详情）。 */
  onReload: () => void
  /** M2.7：文本编辑态时父级持有的「保存」引用（标题栏保存按钮使用）。 */
  textSaveRef?: MutableRefObject<(() => void) | null>
  /** M2.7：保存状态变化回调（office 编辑器 + 文本编辑共用，驱动标题栏「正在保存…」）。 */
  onSavingChange?: (saving: boolean) => void
}

const OFFICE_EXT = new Set([...EDITOR_EDITABLE_EXT, ...EDITOR_READONLY_EXT])

/**
 * 文件预览区（VentoOS 同款分类型查看）：
 *   office    → 在线编辑器 DocEditor（docx/xlsx/pptx 可编辑，其余只读；csv 走文本族）
 *   image     → 缩放/平移 ImageViewer
 *   pdf       → 内嵌 PDF 查看器
 *   video/audio → 自定义 MediaPlayer
 *   markdown  → marked 渲染
 *   text/code → pre 直显（>4MB 仅前 4MB），编辑态内联编辑
 *   binary    → 前 4KB 十六进制转储
 */
const FilePreview = ({ file, editable, onExitEdit, onSaved, onReload, textSaveRef, onSavingChange }: FilePreviewProps) => {
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const isOffice = OFFICE_EXT.has(ext)
  const kind = classifyFile(file.name)
  const isText = isTextFamily(kind)
  const isMedia = kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio'

  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [hex, setHex] = useState<Uint8Array | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(!isOffice)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 数据加载：媒体 → blob URL；文本 → 文本（4MB 上限，NUL 检查）；其他 → 4KB hex
  useEffect(() => {
    if (isOffice) return
    let cancelled = false
    let url: string | null = null
    setLoading(true)
    setFailed(false)
    setText(null)
    setHex(null)
    setDraft(null)
    setTruncated(false)
    const load = async () => {
      try {
        const res = await fetchFileContent(file.id)
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
      } catch {
        if (!cancelled) setFailed(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file.id, file.current_version, isOffice, isMedia, isText])

  // 进入编辑态：文本加载完成后预填草稿
  useEffect(() => {
    if (editable && isText && text !== null && draft === null) setDraft(text)
  }, [editable, isText, text, draft])

  // ── 文本族内联编辑（编辑态，保存逻辑提升到组件级，供标题栏保存按钮复用）────
  const doTextSave = async () => {
    if (draft === null || saving) return
    setSaving(true)
    onSavingChange?.(true)
    try {
      const form = new FormData()
      form.append('file', new File([draft], file.name, { type: 'text/plain;charset=utf-8' }))
      form.append('base_version', String(file.current_version))
      const token = getAccessToken()
      const res = await fetch(`/api/v1/files/${file.id}/save`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form
      })
      if (res.status === 409) {
        msg.error('版本冲突：文件已被其他位置修改，已重新加载最新版本')
        onReload()
        onExitEdit()
        return
      }
      if (!res.ok) {
        let detail = '保存失败'
        try {
          const body = (await res.clone().json()) as { error?: { message?: string } }
          detail = body?.error?.message ?? detail
        } catch {
          // 保留默认提示
        }
        msg.error(detail)
        return
      }
      const body = (await res.json()) as { current_version?: number }
      msg.success(`已保存为新版本 v${body.current_version ?? ''}`)
      onSaved()
    } catch (e) {
      msg.error('保存失败：' + String(e))
    } finally {
      setSaving(false)
      onSavingChange?.(false)
    }
  }

  // 每轮渲染刷新标题栏「保存」引用（仅文本编辑态有效）
  useEffect(() => {
    if (!textSaveRef) return
    textSaveRef.current = isText && editable ? doTextSave : null
    return () => { textSaveRef.current = null }
  })

  // ── Office：在线编辑器（与 M2 实现一致）──────────────────────
  if (isOffice) {
    const editorEditable = editable && EDITOR_EDITABLE_EXT.has(ext)
    const editorBase = getConfig().editorBase
    /** 保存：multipart 上传编辑器导出字节到带版本接口；409 → conflict 异常由 DocEditor 弹冲突框。 */
    const doSave = async (fileOut: File, baseVersion: number): Promise<number> => {
      const form = new FormData()
      form.append('file', fileOut, file.name)
      form.append('base_version', String(baseVersion))
      const token = getAccessToken()
      const res = await fetch(`/api/v1/files/${file.id}/save`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form
      })
      if (res.status === 409) {
        let actual: number | undefined
        try {
          const body = (await res.clone().json()) as { error?: { details?: { actual?: number } } }
          actual = body?.error?.details?.actual
        } catch {
          // 保留默认提示
        }
        const err = new Error('版本冲突') as Error & { conflict?: boolean; actual?: number }
        err.conflict = true
        err.actual = actual
        throw err
      }
      if (!res.ok) {
        let detail = '保存失败'
        try {
          const body = (await res.clone().json()) as { error?: { message?: string } }
          detail = body?.error?.message ?? detail
        } catch {
          // 保留默认提示
        }
        throw new Error(detail)
      }
      const body = (await res.json()) as { current_version?: number }
      return body.current_version ?? baseVersion + 1
    }

    if (!editorBase) {
      return (
        <div className="flex flex-col items-center gap-12px py-80px">
          <FileIcon name={file.name} size={48} />
          <div style={{ fontSize: 14, color: 'var(--vd-text-secondary)' }}>在线编辑器未部署，请检查配置</div>
        </div>
      )
    }

    return (
      <DocEditor
        key={file.id}
        fileName={file.name}
        fetchBytes={async () => (await fetchFileContent(file.id)).arrayBuffer()}
        readonly={!editorEditable}
        baseVersion={file.current_version}
        onSave={editorEditable ? doSave : undefined}
        onSaved={onSaved}
        onSavingChange={onSavingChange}
        onReload={onReload}
        fill
      />
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-80px">
        <Spin />
      </div>
    )
  }

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-12px py-80px">
        <FileIcon name={file.name} size={48} />
        <div style={{ fontSize: 14, color: 'var(--vd-text-secondary)' }}>预览加载失败，文件可能不存在或无权限</div>
      </div>
    )
  }

  // ── 文本族内联编辑（编辑态；状态行与操作按钮已上移至窗口标题栏）────
  if (isText && editable && draft !== null) {
    return (
      <textarea
        className="vd-text-edit"
        value={draft}
        spellCheck={false}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            void doTextSave()
          }
        }}
      />
    )
  }

  // ── 只读渲染 ────────────────────────────────────────────────
  if (kind === 'image' && blobUrl) return <ImageViewer url={blobUrl} name={file.name} />
  if (kind === 'pdf' && blobUrl) return <PdfEmbed url={blobUrl} name={file.name} />
  if ((kind === 'video' || kind === 'audio') && blobUrl)
    return <MediaPlayer url={blobUrl} kind={kind} name={file.name} />
  if (kind === 'markdown' && text !== null) return <MdView text={text} />
  if (isText && text !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-8px">
        {truncated && <div className="vd-truncate-banner">文件过大，仅预览前 4MB</div>}
        <TextPre text={text} mono={kind === 'code'} />
      </div>
    )
  }
  if (hex !== null) return <HexView data={hex} total={file.size} />
  return (
    <div className="flex flex-col items-center gap-12px py-80px">
      <FileIcon name={file.name} size={48} />
      <div style={{ fontSize: 14, color: 'var(--vd-text-secondary)' }}>该文件类型暂不支持在线预览</div>
    </div>
  )
}

export default FilePreview
