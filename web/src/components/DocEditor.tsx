import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import FileIcon from '@/components/FileIcon'
import { Btn, Modal, Spin } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import {
  c_oAscFileType2,
  convertBinToDocument,
  convertDocument,
  initX2T,
  initX2TScript,
} from '@/components/office/x2t'

/** 可在线编辑的扩展名。csv 已移出：x2t 转换基线不支持 csv（main1 返回 88），csv 按文本族处理。 */
export const EDITOR_EDITABLE_EXT = new Set(['xlsx', 'docx', 'pptx'])
/** 在线只读打开的扩展名（可打开查看，不可编辑）。 */
export const EDITOR_READONLY_EXT = new Set(['xls', 'xlsm', 'ods', 'doc', 'odt', 'rtf', 'ppt'])

type SaveError = Error & { conflict?: boolean; actual?: number }

/** 编辑器 iframe 发出的消息（office-editor.html）。 */
type EditorMsg = {
  type?: string
  token?: number
  error?: string
  payload?: unknown
  data?: {
    data?: unknown
    file?: string
    option?: { outputformat?: number; alreadyConverted?: boolean }
  }
}

type DocEditorProps = {
  /** 展示文件名（传给编辑器，决定导出格式）。 */
  fileName: string
  /** 拉取原始文件字节（鉴权由调用方处理）。 */
  fetchBytes: () => Promise<ArrayBuffer>
  /** 只读模式（公共分享/发布页，或无编辑权限）。 */
  readonly?: boolean
  /** 当前基础版本号（保存时乐观锁）。 */
  baseVersion: number
  /** 保存：上传编辑器导出字节，失败抛错（409 需带 conflict/actual），成功返回新版本号。 */
  onSave?: (file: File, baseVersion: number) => Promise<number>
  /** 保存成功回调（父级刷新文件详情）。 */
  onSaved?: () => void
  /** 保存状态变化回调（M2.7：供文件详情页标题栏显示「正在保存…」）。 */
  onSavingChange?: (saving: boolean) => void
  /** 版本冲突确认重新加载时调用（父级刷新文件详情）。 */
  onReload?: () => void
  /** 退出编辑按钮（编辑态显示）。 */
  onExitEdit?: () => void
  /** 下载按钮（出错时显示）。 */
  onDownload?: () => void
  /** 编辑器容器高度（未启用 fill 时生效）。 */
  height?: number | string
  /** 撑满父容器剩余高度（文件详情页使用）。 */
  fill?: boolean
}

/**
 * 在线 Office 编辑器（ventos 同款架构）：
 * 文件字节 → x2t(WASM) 转 OnlyOffice bin → 通过 postMessage 交给 /office-editor.html
 * 内嵌的 DocsAPI 编辑器打开；保存时编辑器经 saveDocument 消息回传 bin，
 * 再经 x2t 转回目标格式上传。
 */
const DocEditor = ({
  fileName,
  fetchBytes,
  readonly = false,
  baseVersion,
  onSave,
  onSaved,
  onSavingChange,
  onReload,
  onDownload,
  height,
  fill = false,
}: DocEditorProps) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  // 保存状态仅通过 onSavingChange 上报给父级（标题栏展示），组件自身不再渲染状态行
  const [, setSaving] = useState(false)
  const [conflict, setConflict] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // M2.7：转换完成后才挂载 iframe，避免「页面遮罩 + 编辑器骨架」两层加载重叠
  const [mountIframe, setMountIframe] = useState(false)

  const tokenRef = useRef(0)
  const mediaRef = useRef<Record<string, string>>({})
  const savingRef = useRef(false)
  const iframeReadyRef = useRef(false)
  const pendingOpenRef = useRef<(() => void) | null>(null)
  const baseVersionRef = useRef(baseVersion)
  const propsRef = useRef({ fetchBytes, fileName, readonly, onSave, onSaved, onSavingChange })
  propsRef.current = { fetchBytes, fileName, readonly, onSave, onSaved, onSavingChange }

  useEffect(() => {
    baseVersionRef.current = baseVersion
  }, [baseVersion])

  /** 重新加载编辑器（版本冲突确认后）。 */
  const retry = () => {
    savingRef.current = false
    iframeReadyRef.current = false
    pendingOpenRef.current = null
    setSaving(false)
    setPhase('loading')
    setErrorMsg('')
    setMountIframe(false)
    setReloadKey((k) => k + 1)
  }

  // 只读/编辑模式切换（进入编辑、退出编辑、保存后自动退出）需重建编辑器：
  // 权限随 openDocument 载荷在编辑器初始化时一次性应用，仅重渲染无法生效
  const firstReadonlyRef = useRef(readonly)
  useEffect(() => {
    if (firstReadonlyRef.current === readonly) return
    firstReadonlyRef.current = readonly
    retry()
  }, [readonly])

  // 保存处理（saveDocument 消息 → x2t 转回格式 → onSave 上传）
  // 若 option.alreadyConverted 为真（SDK 本地保存路径 x2t.downloadFile 已把 bin
  // 转成目标格式后经 onlyoffice-file-stream 回传），字节已是目标格式，直接上传。
  const handleSaveRef = useRef<(m: EditorMsg) => Promise<void>>(async () => {})
  handleSaveRef.current = async (m: EditorMsg) => {
    const d = m.data
    const p = propsRef.current
    if (!d?.data || savingRef.current || p.readonly || !p.onSave) return
    const binData = d.data as Uint8Array
    const ext =
      c_oAscFileType2[d.option?.outputformat as number]?.toLowerCase() ??
      p.fileName.split('.').pop()?.toLowerCase() ??
      'docx'
    savingRef.current = true
    setSaving(true)
    propsRef.current.onSavingChange?.(true)
    try {
      const data = d.option?.alreadyConverted
        ? binData
        : await convertBinToDocument(binData, p.fileName, ext.toUpperCase())
      const fileOut = new File([new Uint8Array(data)], p.fileName)
      const newVersion = await p.onSave(fileOut, baseVersionRef.current)
      baseVersionRef.current = newVersion
      p.onSaved?.()
    } catch (err) {
      const e = err as SaveError
      if (e?.conflict) {
        setConflict(e.actual ?? null)
      } else {
        msg.error(e?.message || '保存失败')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
      propsRef.current.onSavingChange?.(false)
    }
  }

  // 监听编辑器 iframe 消息（校验来源同源 + 当前 iframe 窗口）
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.source !== iframeRef.current?.contentWindow) return
      const m = event.data as EditorMsg | null
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return
      const current = tokenRef.current

      if (m.type === 'iframeReady') {
        iframeReadyRef.current = true
        const pending = pendingOpenRef.current
        if (pending) {
          pendingOpenRef.current = null
          pending()
        }
      } else if (m.type === 'editorReady' && m.token === current) {
        // 与 ventos 一致：编辑器应用就绪（onAppReady）即视为 ready，
        // 不等 documentReady（部分文档类型如 xlsx 不会触发）
        setPhase('ready')
      } else if (m.type === 'documentReady' && m.token === current) {
        setPhase('ready')
      } else if (m.type === 'editorError' && m.token === current) {
        if (savingRef.current) {
          msg.error(m.error || '保存失败')
        } else {
          setErrorMsg(m.error || '未知编辑器错误')
          setPhase('error')
        }
      } else if (m.type === 'saveDocument' && m.token === current) {
        void handleSaveRef.current(m)
      } else if (m.type === 'writeFile' && m.token === current) {
        // 编辑器内嵌入/更新的图片：转 Blob URL 并回传 media 映射
        try {
          const { data: imageData, file: fName } = m.data ?? {}
          if (!imageData || !fName) return
          const imgExt = fName.split('.').pop()?.toLowerCase() ?? 'png'
          const mimeMap: Record<string, string> = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            bmp: 'image/bmp',
            webp: 'image/webp',
            svg: 'image/svg+xml',
          }
          const blob = new Blob([imageData as unknown as BlobPart], { type: mimeMap[imgExt] ?? 'image/png' })
          const url = URL.createObjectURL(blob)
          mediaRef.current[`media/${fName}`] = url
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'updateMedia', media: mediaRef.current },
            window.location.origin,
          )
        } catch (err) {
          console.error('handleWriteFile error:', err)
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // 打开文档：取字节 → x2t 转 bin → 发 iframe
  useEffect(() => {
    const token = ++tokenRef.current
    pendingOpenRef.current = null
    iframeReadyRef.current = false
    setPhase('loading')
    setErrorMsg('')
    setSaving(false)
    savingRef.current = false
    // 重新打开：先卸载 iframe，转换完成后重建（避免旧编辑器残影 + 双层加载）
    setMountIframe(false)
    let cancelled = false

    const sendOpen = (payload: {
      bin: Uint8Array
      media: Record<string, string>
      fileExt: string
      fileName: string
      readOnly: boolean
    }) => {
      const win = iframeRef.current?.contentWindow
      if (!win) return
      win.postMessage({ type: 'openDocument', token, payload }, window.location.origin)
    }

    void (async () => {
      try {
        await initX2TScript()
        await initX2T()
        const buffer = await propsRef.current.fetchBytes()
        if (cancelled) return
        const file = new File([buffer], propsRef.current.fileName)
        const { bin, media } = await convertDocument(file)
        if (cancelled) return
        // 释放上一轮 media
        for (const u of Object.values(mediaRef.current)) {
          if (u.startsWith('blob:')) URL.revokeObjectURL(u)
        }
        mediaRef.current = { ...media }
        // 转换完成：此时才挂载 iframe（此前仅显示页面级加载遮罩）
        setMountIframe(true)
        const p = propsRef.current
        const fileExt = p.fileName.split('.').pop()?.toLowerCase() ?? ''
        const payload = { bin, media: mediaRef.current, fileExt, fileName: p.fileName, readOnly: p.readonly }
        if (iframeReadyRef.current) {
          sendOpen(payload)
        } else {
          pendingOpenRef.current = () => sendOpen(payload)
        }
      } catch (err) {
        if (cancelled) return
        console.error('DocEditor open error:', err)
        setErrorMsg(err instanceof Error ? err.message : '文件加载失败')
        setPhase('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [fileName, reloadKey])

  // 加载超时（60s）
  useEffect(() => {
    if (phase !== 'loading') return
    const t = setTimeout(() => {
      setPhase('error')
      setErrorMsg('在线编辑器加载超时，请重试')
    }, 60_000)
    return () => clearTimeout(t)
  }, [phase, reloadKey])

  // 卸载：通知编辑器销毁 + 释放 media
  useEffect(() => {
    return () => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'destroy' }, window.location.origin)
      for (const u of Object.values(mediaRef.current)) {
        if (u.startsWith('blob:')) URL.revokeObjectURL(u)
      }
    }
  }, [])

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-8px' : 'flex flex-col gap-8px'}>
      <div
        className="relative w-full overflow-hidden rounded-8px border-1px"
        style={{
          borderColor: 'var(--vd-border-default)',
          background: 'var(--vd-bg-window)',
          minHeight: 420,
          height: fill ? undefined : height,
          flex: fill ? '1 1 0' : undefined,
        }}
      >
        {mountIframe && (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src="/office-editor.html"
            title={fileName}
            className="block border-0"
            style={{ width: '100%', height: '100%' }}
            onLoad={() => {
              // iframe 文档加载完成（其内部消息监听必然已注册）。
              // 兜底握手：即使 iframeReady 的 postMessage 先于父级监听器注册而丢失，
              // 这里也能确保 openDocument 被送达，避免 60s 超时。
              iframeReadyRef.current = true
              const pending = pendingOpenRef.current
              if (pending) {
                pendingOpenRef.current = null
                pending()
              }
            }}
          />
        )}
        {phase === 'loading' && !mountIframe && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: 'var(--vd-bg-window)' }}
          >
            <Spin text="正在加载文档…" />
          </div>
        )}
        {phase === 'error' && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-12px"
            style={{ background: 'var(--vd-bg-window)' }}
          >
            <FileIcon name={fileName} size={48} />
            <div style={{ fontSize: 14, color: 'var(--vd-text-secondary)' }}>{errorMsg}</div>
            <div className="flex gap-8px">
              <Btn onClick={retry}>
                <RefreshCw size={13} />
                重试
              </Btn>
              {onDownload && (
                <Btn variant="primary" onClick={onDownload}>
                  下载文件
                </Btn>
              )}
            </div>
          </div>
        )}
      </div>

      <Modal
        open={conflict !== null}
        title="版本冲突"
        onClose={() => setConflict(null)}
        footer={
          <>
            <Btn onClick={() => setConflict(null)}>继续编辑</Btn>
            <Btn
              variant="primary"
              onClick={() => {
                setConflict(null)
                onReload?.()
                retry()
              }}
            >
              重新加载
            </Btn>
          </>
        }
      >
        <div style={{ fontSize: 13, color: 'var(--vd-text-secondary)' }}>
          文件已被更新到 v{conflict ?? '最新版本'}，你的编辑尚未保存。是否重新加载最新版本？
        </div>
      </Modal>
    </div>
  )
}

export default DocEditor
