import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Space } from 'antd'
import { DownloadOutlined, RedoOutlined, SaveOutlined } from '@ant-design/icons'
import { useRequest } from 'ahooks'
import { createUniver, LocaleType } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import sheetsZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core'
import docsZhCN from '@univerjs/preset-docs-core/locales/zh-CN'
import { client } from '@/api'
import type { FileMeta } from '@/api/schema'
import { msg } from '@/components/GlobalMessage'
import FileIcon from '@/components/FileIcon'

type UniverPreviewProps = {
  file: FileMeta
  /** sheet = xlsx/xls/csv；doc = docx */
  unit: 'sheet' | 'doc'
  onDownload: () => void
  /** 在线编辑模式（M2.2）：不设置只读权限，工具栏提供保存/退出。 */
  editable: boolean
  onExitEdit: () => void
  /** 保存成功回调。 */
  onSaved: () => void
}

/**
 * 只读 Office 在线预览（Univer OSS 1.2.0 preset）。
 *
 * 流程：GET /files/{id}/univer-preview 取 Rust 端转换好的 Univer 快照，
 * createUniver(单一 preset) + createWorkbook / createDocument 渲染，
 * 再通过权限门面切到只读（sheet: setMode('viewer')，doc: setReadOnly()）。
 *
 * 注意：
 * - 不传 workerURL → 公式引擎跑主线程（快照已带缓存值 v，仅兜底计算）；
 * - 每次挂载使用全新的容器元素，卸载时 queueMicrotask 内 dispose（POC-1 验证过的生命周期）。
 */
const UniverPreview = ({ file, unit, onDownload, editable, onExitEdit, onSaved }: UniverPreviewProps) => {
  const [initError, setInitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const { data, loading, error, refresh } = useRequest(
    async () => {
      const { error: err, data: d, response } = await client.get('/api/v1/files/{id}/univer-preview', {
        params: { id: file.id },
      })
      if (err || !d) {
        if (response?.status === 403) throw new Error('no-perm')
        let detail = '预览加载失败'
        try {
          if (response?.headers.get('content-type')?.includes('application/json')) {
            const body: { error?: { message?: string } } | undefined = await response?.clone().json()
            detail = body?.error?.message || detail
          }
        } catch {
          // 保留默认提示
        }
        throw new Error(detail)
      }
      return d
    },
    { refreshDeps: [file.id, file.current_version] },
  )

  const containerRef = useRef<HTMLDivElement | null>(null)
  const univerRef = useRef<{ univer: { dispose(): void } } | null>(null)
  /** 当前文档/工作簿 API：save() 产出与后端存储同构的快照（FWorkbook.save / FDocument.save）。 */
  const apiRef = useRef<{ save: () => unknown } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!data || !el) return
    const t0 = performance.now()
    try {
      const preset =
        unit === 'sheet'
          ? UniverSheetsCorePreset({ container: el })
          : UniverDocsCorePreset({ container: el })
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: unit === 'sheet' ? sheetsZhCN : docsZhCN },
        presets: [preset],
      })
      univerRef.current = { univer }
      if (unit === 'sheet') {
        const wb = univerAPI.createWorkbook(data.snapshot)
        apiRef.current = { save: () => wb.save() }
        if (!editable) {
          void wb.getWorkbookPermission().setMode('viewer').catch((e: unknown) => {
            console.warn('[UniverPreview] 设置只读失败', e)
          })
        }
      } else {
        const doc = univerAPI.createDocument(data.snapshot)
        apiRef.current = { save: () => doc.save() }
        if (!editable) {
          void doc.getPermission().setReadOnly().catch((e: unknown) => {
            console.warn('[UniverPreview] 设置只读失败', e)
          })
        }
      }
      console.info(`[UniverPreview] ${unit} 初始化完成 (${(performance.now() - t0).toFixed(0)}ms)`)
    } catch (e) {
      console.error('[UniverPreview] 初始化失败', e)
      setInitError('预览组件初始化失败，请刷新重试')
    }
    return () => {
      const u = univerRef.current
      univerRef.current = null
      if (u) {
        queueMicrotask(() => {
          try {
            u.univer.dispose()
          } catch {
            // 忽略销毁异常
          }
        })
      }
    }
  }, [data, unit, editable])

  /** 保存当前编辑为新版本文档（baseVersion 不匹配 → 409 提示冲突）。 */
  const handleSave = async () => {
    const api = apiRef.current
    if (!api || !data || saving) return
    setSaving(true)
    try {
      const snapshot = api.save() as Record<string, unknown>
      const { error: err, data: saved, response } = await client.post('/api/v1/files/{id}/univer-save', {
        params: { id: file.id },
        body: { baseVersion: data.fileVersion, snapshot },
      })
      if (err) {
        if (response?.status === 409) {
          let actual: number | undefined
          try {
            const body = (await response.clone().json()) as {
              error?: { details?: { actual?: number } }
            } | undefined
            actual = body?.error?.details?.actual
          } catch {
            // 保留默认提示
          }
          Modal.confirm({
            title: '版本冲突',
            content: `文件已被更新到 v${actual ?? '最新版本'}，你的编辑尚未保存。是否重新加载最新版本？`,
            okText: '重新加载',
            cancelText: '继续编辑',
            onOk: () => {
              apiRef.current = null
              refresh()
            },
          })
        }
        // 423 与其他错误由全局 errorHandler 提示
        return
      }
      msg.success(`已保存为 v${saved.current_version}`)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const state: 'loading' | 'noPerm' | 'error' | 'ready' =
    loading || !data
      ? 'loading'
      : error?.message === 'no-perm'
        ? 'noPerm'
        : error || initError
          ? 'error'
          : 'ready'

  if (state === 'loading') {
    return (
      <div className="flex justify-center py-80px">
        <span className="sr-only">加载中</span>
        <UniverLoadingSpinner />
      </div>
    )
  }

  if (state === 'noPerm') {
    return (
      <div className="flex flex-col items-center gap-12px py-80px">
        <FileIcon name={file.name} size={48} />
        <div className="text-14px text-rgba(0,0,0,0.65)">你当前没有该文件的预览权限</div>
      </div>
    )
  }

  if (state === 'error') {
    const message = error?.message && error.message !== 'no-perm' ? error.message : (initError ?? '预览加载失败')
    return (
      <div className="flex flex-col items-center gap-12px py-80px">
        <FileIcon name={file.name} size={48} />
        <div className="text-14px text-rgba(0,0,0,0.65)">{message}</div>
        <div className="flex gap-8px">
          <Button icon={<RedoOutlined />} onClick={refresh}>
            重试
          </Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
            下载文件
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8px">
      {editable && (
        <div className="flex items-center justify-between gap-12px">
          <span className="text-13px text-rgba(0,0,0,0.45)">
            正在编辑 v{data?.fileVersion ?? ''}，保存后生成新版本
          </span>
          <Space>
            <Button onClick={onExitEdit} disabled={saving}>
              退出编辑
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              保存
            </Button>
          </Space>
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full overflow-hidden rounded-8px"
        style={{ height: editable ? 'calc(100vh - 400px)' : 'calc(100vh - 340px)', minHeight: 420 }}
      />
    </div>
  )
}

/** 轻量加载指示（与 FilePreview 保持一致观感）。 */
function UniverLoadingSpinner() {
  return (
    <div className="flex items-center gap-8px text-14px text-rgba(0,0,0,0.45)">
      <div className="size-16px animate-spin rounded-full border-2px border-#E5E7EB border-t-#2563EB" />
      正在转换并加载预览…
    </div>
  )
}

export default UniverPreview
