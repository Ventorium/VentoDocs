import { useEffect, useState } from 'react'
import { Button, Spin } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import type { FileMeta } from '@/api/schema'
import { fetchFileContent } from '@/api'
import FileIcon from '@/components/FileIcon'
import { fileTypeInfo } from '@/lib/fileType'

type FilePreviewProps = {
  file: FileMeta
  onDownload: () => void
}

/** 文件预览区：图片/PDF 走 Blob URL，文本直显；Office 与其他类型展示提示卡片 + 下载。 */
const FilePreview = ({ file, onDownload }: FilePreviewProps) => {
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

  const ext = file.name.includes('.')
    ? (file.name.split('.').pop() ?? '').toLowerCase()
    : ''
  const hint =
    ext === 'pptx' || ext === 'ppt'
      ? 'PPTX 暂不支持在线编辑，请下载后查看'
      : preview === 'office'
        ? '在线编辑即将上线，当前可下载查看'
        : '该文件类型暂不支持在线预览'

  return (
    <div className="flex flex-col items-center gap-12px py-80px">
      <FileIcon name={file.name} size={48} />
      <div className="text-14px text-rgba(0,0,0,0.65)">{hint}</div>
      <Button type="primary" icon={<DownloadOutlined />} onClick={onDownload}>
        下载文件
      </Button>
    </div>
  )
}

export default FilePreview
