import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Space } from 'antd'
import { DownloadOutlined, RedoOutlined, SaveOutlined } from '@ant-design/icons'
import FileIcon from '@/components/FileIcon'
import { msg } from '@/components/GlobalMessage'

/** 在线编辑器可编辑的扩展名。 */
export const EDITOR_EDITABLE_EXT = new Set(['xlsx', 'csv', 'docx', 'pptx'])
/** 在线编辑器只读的扩展名（可打开查看，不可编辑）。 */
export const EDITOR_READONLY_EXT = new Set(['xls', 'xlsm', 'ods', 'doc', 'odt', 'rtf', 'ppt'])

type SaveError = Error & { conflict?: boolean; actual?: number }

type DocEditorProps = {
  /** 在线编辑器资源根（来自 /_env 的 editorBase，如 "/document"）。 */
  editorBase: string
  /** 展示文件名（传给编辑器，决定导出格式）。 */
  fileName: string
  /** 获取文件原始字节（鉴权由调用方负责，父窗口代取后 postMessage 给编辑器）。 */
  fetchBytes: () => Promise<ArrayBuffer>
  /** 只读模式（公开分享/发布页，或无编辑权限）。 */
  readonly?: boolean
  /** 当前基础版本号（保存时乐观锁）。 */
  baseVersion: number
  /** 保存：上传字节，失败抛错（409 时带 conflict/actual），成功返回新版本号。 */
  onSave?: (file: File, baseVersion: number) => Promise<number>
  /** 保存成功回调（父组件刷新详情、退出编辑）。 */
  onSaved?: () => void
  /** 版本冲突确认重新加载时调用（父组件刷新文件详情）。 */
  onReload?: () => void
  /** 退出编辑按钮（仅编辑态显示）。 */
  onExitEdit?: () => void
  /** 下载按钮（仅错误态显示）。 */
  onDownload?: () => void
  /** 编辑器主体高度（fill 未开启时生效）。 */
  height?: number | string
  /** 撑满父容器剩余高度（文件详情页用，最大化编辑区）。 */
  fill?: boolean
}

/**
 * 在线编辑器（ranuts/document，AGPL-3.0）iframe 嵌入组件。
 *
 * 嵌入协议（postMessage，命令只接受直接父窗口，同源自带鉴权字节）：
 * - 父 → 子：document:open-buffer / document:save / document:set-readonly
 * - 子 → 父：document:ready / document:opened / document:dirty-changed /
 *   document:saved {file, dirty} / document:error
 *
 * 保存流程：document:save → document:saved 返回 File → 父窗口 multipart 上传
 * 到带版本的保存接口；响应仍 dirty（导出期间有编辑）→ 用新版本号再存一次。
 */
const DocEditor = ({
  editorBase,
  fileName,
  fetchBytes,
  readonly = false,
  baseVersion,
  onSave,
  onSaved,
  onReload,
  onExitEdit,
  onDownload,
  height,
  fill = false,
}: DocEditorProps) => {
  const canEdit = !readonly && !!onSave

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // 供 message 监听器读取最新值（监听器只在 iframe 重挂载时重新订阅）
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const openingRef = useRef(true)
  const savingRef = useRef(false)
  const baseVersionRef = useRef(baseVersion)
  useEffect(() => {
    baseVersionRef.current = baseVersion
  }, [baseVersion])
  const propsRef = useRef({ fetchBytes, readonly, onSave, onSaved, onReload })
  propsRef.current = { fetchBytes, readonly, onSave, onSaved, onReload }

  /** 向编辑器发送带 id 的命令（同域，targetOrigin = 当前源）。 */
  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    win.postMessage({ id, type, payload }, window.location.origin)
  }, [])

  const retry = () => {
    openingRef.current = true
    setDirty(false)
    setSaving(false)
    savingRef.current = false
    setPhase('loading')
    setErrorMsg('')
    setReloadKey((k) => k + 1)
  }

  /** 父窗口代取字节后交给编辑器打开。 */
  const openDocument = useCallback(async () => {
    openingRef.current = true
    try {
      const buffer = await propsRef.current.fetchBytes()
      if (!iframeRef.current) return
      send('document:open-buffer', {
        fileName,
        buffer,
        readonly: propsRef.current.readonly,
      })
    } catch (e) {
      if (phaseRef.current !== 'loading') return
      setPhase('error')
      setErrorMsg(e instanceof Error ? e.message : '文件内容加载失败')
    }
  }, [fileName, send])

  /** 编辑器导出成功：上传到带版本的保存接口。 */
  const handleSaved = useCallback(
    async (payload: { file?: File; dirty?: boolean }) => {
      savingRef.current = false
      setSaving(false)
      const fileOut = payload?.file
      if (!fileOut || !propsRef.current.onSave) return
      const stillDirty = !!payload?.dirty
      try {
        const newVersion = await propsRef.current.onSave(fileOut, baseVersionRef.current)
        baseVersionRef.current = newVersion
        if (stillDirty) {
          // 导出期间有新编辑（不在已上传字节里）→ 用新版本号再存一次
          savingRef.current = true
          setSaving(true)
          send('document:save')
        } else {
          setDirty(false)
          propsRef.current.onSaved?.()
        }
      } catch (e) {
        const err = e as SaveError
        if (err?.conflict) {
          Modal.confirm({
            title: '版本冲突',
            content: `文件已被更新到 v${err.actual ?? '最新版本'}，你的编辑尚未保存。是否重新加载最新版本？`,
            okText: '重新加载',
            cancelText: '继续编辑',
            onOk: () => {
              propsRef.current.onReload?.()
              retry()
            },
          })
        } else {
          msg.error(err?.message || '保存失败')
        }
      }
    },
    [send],
  )

  // 消息监听：只信任同域、编辑器 iframe 发出的 document:* 消息
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data as { type?: string; payload?: unknown } | null
      if (!data || typeof data !== 'object') return
      const type = data.type
      if (typeof type !== 'string' || !type.startsWith('document:')) return
      const payload = data.payload as Record<string, unknown> | undefined

      switch (type) {
        case 'document:ready':
          if (!openingRef.current) return
          void openDocument()
          break
        case 'document:opened':
          openingRef.current = false
          setDirty(false)
          setPhase('ready')
          break
        case 'document:dirty-changed':
          setDirty(Boolean(payload?.dirty))
          break
        case 'document:saved':
          void handleSaved({
            file: payload?.file as File | undefined,
            dirty: payload?.dirty as boolean | undefined,
          })
          break
        case 'document:error': {
          const message =
            (typeof payload?.message === 'string' && payload.message) ||
            (openingRef.current ? '文件打开失败' : '保存失败')
          if (savingRef.current) {
            msg.error(message)
            savingRef.current = false
            setSaving(false)
          } else {
            openingRef.current = false
            setPhase('error')
            setErrorMsg(message)
          }
          break
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [openDocument, handleSaved])

  // 编辑器就绪后切换只读/可编辑（进入/退出编辑不重挂载 iframe）
  useEffect(() => {
    if (phase === 'ready') {
      send('document:set-readonly', { readonly })
    }
  }, [readonly, phase, send])

  // 加载超时兜底
  useEffect(() => {
    if (phase !== 'loading') return
    const t = setTimeout(() => {
      if (phaseRef.current === 'loading') {
        setPhase('error')
        setErrorMsg('在线编辑器加载超时，请重试')
      }
    }, 60_000)
    return () => clearTimeout(t)
  }, [phase, reloadKey])

  const doSave = () => {
    if (savingRef.current || !dirty) return
    savingRef.current = true
    setSaving(true)
    send('document:save')
  }

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-8px' : 'flex flex-col gap-8px'}>
      {canEdit && (
        <div className="flex items-center justify-between gap-12px">
          <span className="text-13px text-rgba(0,0,0,0.45)">
            正在编辑 v{baseVersion}，保存后生成新版本
          </span>
          <Space>
            {onExitEdit && (
              <Button onClick={onExitEdit} disabled={saving}>
                退出编辑
              </Button>
            )}
            <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={doSave}>
              保存
            </Button>
          </Space>
        </div>
      )}
      <div
        className={`relative w-full overflow-hidden rounded-8px border-1px border-#E5E7EB bg-white${fill ? ' min-h-0 flex-1' : ''}`}
        style={fill ? { minHeight: 420 } : { height, minHeight: 420 }}
      >
        <iframe
          key={reloadKey}
          ref={iframeRef}
          src={`${editorBase}editor.html?embed=1`}
          title={fileName}
          className="block border-0"
          style={{ width: '100%', height: '100%' }}
        />
        {phase === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-rgba(255,255,255,0.9)">
            <span className="sr-only">加载中</span>
            <EditorSpinner />
          </div>
        )}
        {phase === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-12px bg-white">
            <FileIcon name={fileName} size={48} />
            <div className="text-14px text-rgba(0,0,0,0.65)">{errorMsg}</div>
            <div className="flex gap-8px">
              <Button icon={<RedoOutlined />} onClick={retry}>
                重试
              </Button>
              {onDownload && (
                <Button type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
                  下载文件
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function EditorSpinner() {
  return (
    <div className="flex items-center gap-8px text-14px text-rgba(0,0,0,0.45)">
      <div className="size-16px animate-spin rounded-full border-2px border-#E5E7EB border-t-#2563EB" />
      正在加载在线编辑器…
    </div>
  )
}

export default DocEditor
