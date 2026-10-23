import type { ComponentType, CSSProperties } from 'react'
import {
  FileExcelTwoTone,
  FilePdfTwoTone,
  FilePptTwoTone,
  FileTextTwoTone,
  FileWordTwoTone,
  FileZipTwoTone,
  FileImageTwoTone,
  FileUnknownTwoTone,
} from '@ant-design/icons'

export type PreviewKind = 'text' | 'image' | 'pdf' | 'office' | 'binary'

export type FileTypeInfo = {
  icon: ComponentType<{ style?: CSSProperties; className?: string; twoToneColor?: string }>
  color: string
  preview: PreviewKind
  label: string
}

const OFFICE_EXT = new Set(['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt'])
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'csv', 'tsv',
  'log', 'ini', 'conf', 'toml', 'env', 'sh', 'py', 'js', 'ts', 'tsx', 'jsx', 'css', 'html',
])

/** 按扩展名解析文件展示信息（图标 / 颜色 / 预览方式）。 */
export function fileTypeInfo(name: string): FileTypeInfo {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  if (ext === 'xlsx' || ext === 'xls') {
    return { icon: FileExcelTwoTone, color: '#16a34a', preview: 'office', label: 'Excel 表格' }
  }
  if (ext === 'docx' || ext === 'doc') {
    return { icon: FileWordTwoTone, color: '#2563eb', preview: 'office', label: 'Word 文档' }
  }
  if (ext === 'pptx' || ext === 'ppt') {
    return { icon: FilePptTwoTone, color: '#ea580c', preview: 'office', label: 'PPT 演示' }
  }
  if (ext === 'pdf') {
    return { icon: FilePdfTwoTone, color: '#dc2626', preview: 'pdf', label: 'PDF 文档' }
  }
  if (OFFICE_EXT.has(ext)) {
    return { icon: FileTextTwoTone, color: '#6b7280', preview: 'office', label: 'Office 文档' }
  }
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'svg' || ext === 'bmp') {
    return { icon: FileImageTwoTone, color: '#0d9488', preview: 'image', label: '图片' }
  }
  if (TEXT_EXT.has(ext)) {
    return { icon: FileTextTwoTone, color: '#64748b', preview: 'text', label: '文本文件' }
  }
  if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz') {
    return { icon: FileZipTwoTone, color: '#a16207', preview: 'binary', label: '压缩包' }
  }
  return { icon: FileUnknownTwoTone, color: '#9ca3af', preview: 'binary', label: '文件' }
}

/** 判断文件是否支持浏览器内预览。 */
export function isPreviewable(mime: string, name: string): boolean {
  const kind = fileTypeInfo(name).preview
  if (kind === 'text' || kind === 'image' || kind === 'pdf') return true
  if (kind === 'office' && mime.startsWith('text/')) return true
  return false
}
