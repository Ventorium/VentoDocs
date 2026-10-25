import { useEffect, useState } from 'react'
import { Button, Spin } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import type { FileMeta } from '@/api/schema'
import { fetchFileContent } from '@/api'
import FileIcon from '@/components/FileIcon'
import DocEditor, { EDITOR_EDITABLE_EXT, EDITOR_READONLY_EXT } from '@/components/DocEditor'
import { fileTypeInfo } from '@/lib/fileType'
import { getAccessToken } from '@/store/token'
import { getConfig } from '@/store/config'

type FilePreviewProps = {
  file: FileMeta
  onDownload: () => void
  /** 是否处于在线编辑模式（有修改权限且持有锁时开启，仅可编辑扩展名生效）。 */
  editable: boolean
  onExitEdit: () => void
  /** 保存成功回调（父级刷新文件详情）。 */
  onSaved: () => void
  /** 版本冲突后重新加载（父级刷新文件详情）。 */
  onReload: () => void
}

/**
 * 文件预览区：Office 走在线编辑器（xlsx/csv/docx/pptx 可编辑，
 * xls/xlsm/ods/doc/odt/rtf/ppt 只读），图片/PDF 走 Blob URL，文本直显，
 * 其余展示提示卡片 + 下载。
 */
const FilePreview = ({ file, onDownload, editable, onExitEdit, onSaved, onReload }: FilePreviewProps) => {
  const ext = file.name.includes('.')
    ? (file.name.split('.').pop() ?? '').toLowerCase()
    : ''
  const isEditorFile = EDITOR_EDITABLE_EXT.has(ext) || EDITOR_READONLY_EXT.has(ext)
  const editorBase = getConfig().editorBase
  const editorEditable = editable && EDITOR_EDITABLE_EXT.has(ext)

  /** 保存：multipart 上传编辑器导出字节到带版本接口；409 → conflict 异常由 DocEditor 弹冲突框。 */
  const doSave = async (fileOut: File, baseVersion: number): Promise<number> => {
    const form = new FormData()
    form.append('file', fileOut, file.name)
    form.append('base_version', String(baseVersion))
    const token = getAccessToken()
    const res = await fetch(`/api/v1/files/${file.id}/save`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
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

  if (isEditorFile) {
    if (!editorBase) {
      return (
        <div className="flex flex-col items-center gap-12px py-80px">
          <FileIcon name={file.name} size={48} />
          <div className="text-14px text-rgba(0,0,0,0.65)">在线编辑器未部署，请下载后查看</div>
          <Button type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
            下载文件
          </Button>
        </div>
      )
    }
    return (
      <DocEditor
        key={file.id}
        editorBase={editorBase}
        fileName={file.name}
        fetchBytes={async () => (await fetchFileContent(file.id)).arrayBuffer()}
        readonly={!editorEditable}
        baseVersion={file.current_version}
        onSave={editorEditable ? doSave : undefined}
        onSaved={onSaved}
        onReload={onReload}
        onExitEdit={onExitEdit}
        onDownload={onDownload}
        fill
      />
    )
  }

  const preview = fileTypeInfo(file.name).preview
  const [text, setText] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(
    preview === 'text' || preview === 'image' || preview === 'pdf',
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (preview !== 'text' && preview !== 'image' && preview !== 'pdf') return
    let cancelled = false
    let url: string | null = null
    const load = async () => {
      try {
        const res = await fetchFileContent(file.id)
        if (cancelled) return
        if (preview === 'text') {
          setText(await res.text())
        } else {
          url = URL.createObjectURL(await res.blob())
          setBlobUrl(url)
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
  }, [file.id, preview])

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
        <div className="text-14px text-rgba(0,0,0,0.45)">预览加载失败</div>
        <Button icon={<DownloadOutlined />} onClick={onDownload}>
          下载文件
        </Button>
      </div>
    )
  }

  if (preview === 'text') {
    return (
      <pre
        className="m-0 overflow-auto rounded-8px bg-#F7F8FA p-16px text-13px leading-20px whitespace-pre-wrap"
        style={{ maxHeight: 'calc(100vh - 340px)' }}
      >
        {text ?? ''}
      </pre>
    )
  }

  if (preview === 'image' && blobUrl) {
    return (
      <div className="flex justify-center py-8px">
        <img
          src={blobUrl}
          alt={file.name}
          className="max-w-full rounded-4px"
          style={{ maxHeight: 'calc(100vh - 340px)' }}
        />
      </div>
    )
  }

  if (preview === 'pdf' && blobUrl) {
    return (
      <iframe
        src={blobUrl}
        title={file.name}
        className="w-full rounded-8px border-0"
        style={{ height: 'calc(100vh - 340px)' }}
      />
    )
  }

  return (
    <div className="flex flex-col items-center gap-12px py-80px">
      <FileIcon name={file.name} size={48} />
      <div className="text-14px text-rgba(0,0,0,0.65)">该文件类型暂不支持在线预览，请下载后查看</div>
      <Button type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
        下载文件
      </Button>
    </div>
  )
}

export default FilePreview
