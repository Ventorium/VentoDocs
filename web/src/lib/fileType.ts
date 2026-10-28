/**
 * 文件类型判断（M5：lucide 图标，无 antd 依赖）。
 */
import { File, FileText, FileSpreadsheet, FileImage, FileArchive, FileCode, FileVideo, FileAudio, FileType, Folder, FileCheck, FileX } from 'lucide-react'
import type { ComponentType } from 'react'

export type PreviewKind = 'text' | 'image' | 'pdf' | 'office' | 'binary'

export interface FileType {
  icon: ComponentType<{ size?: number | string; style?: React.CSSProperties; className?: string }>
  color: string
  preview: PreviewKind
  label: string
}

const EXT_MAP: Record<string, { color: string; preview: PreviewKind; label: string; icon: ComponentType<any> }> = {
  // 文本 / 代码
  txt: { color: '#64D2FF', preview: 'text', label: '文本', icon: FileText },
  md: { color: '#64D2FF', preview: 'text', label: 'Markdown', icon: FileText },
  log: { color: '#64D2FF', preview: 'text', label: '日志', icon: FileText },
  csv: { color: '#30D158', preview: 'office', label: 'CSV 表格', icon: FileSpreadsheet },
  json: { color: '#FF9F0A', preview: 'text', label: 'JSON', icon: FileCode },
  xml: { color: '#FF9F0A', preview: 'text', label: 'XML', icon: FileCode },
  yaml: { color: '#FF9F0A', preview: 'text', label: 'YAML', icon: FileCode },
  yml: { color: '#FF9F0A', preview: 'text', label: 'YAML', icon: FileCode },
  sh: { color: '#FF9F0A', preview: 'text', label: 'Shell 脚本', icon: FileCode },
  py: { color: '#FF9F0A', preview: 'text', label: 'Python', icon: FileCode },
  js: { color: '#FF9F0A', preview: 'text', label: 'JavaScript', icon: FileCode },
  ts: { color: '#64D2FF', preview: 'text', label: 'TypeScript', icon: FileCode },
  html: { color: '#FF9F0A', preview: 'text', label: 'HTML', icon: FileCode },
  css: { color: '#64D2FF', preview: 'text', label: 'CSS', icon: FileCode },
  ini: { color: '#8E8E93', preview: 'text', label: '配置', icon: FileCode },
  conf: { color: '#8E8E93', preview: 'text', label: '配置', icon: FileCode },
  // Office / 文档
  doc: { color: '#3B82F6', preview: 'office', label: 'Word 文档', icon: FileText },
  docx: { color: '#3B82F6', preview: 'office', label: 'Word 文档', icon: FileText },
  odt: { color: '#3B82F6', preview: 'office', label: 'ODT 文档', icon: FileText },
  rtf: { color: '#3B82F6', preview: 'office', label: 'RTF 文档', icon: FileText },
  xls: { color: '#30D158', preview: 'office', label: 'Excel 表格', icon: FileSpreadsheet },
  xlsx: { color: '#30D158', preview: 'office', label: 'Excel 表格', icon: FileSpreadsheet },
  ods: { color: '#30D158', preview: 'office', label: 'ODS 表格', icon: FileSpreadsheet },
  ppt: { color: '#FF9F0A', preview: 'office', label: 'PPT 演示', icon: FileType },
  pptx: { color: '#FF9F0A', preview: 'office', label: 'PPT 演示', icon: FileType },
  odp: { color: '#FF9F0A', preview: 'office', label: 'ODP 演示', icon: FileType },
  pdf: { color: '#FF453A', preview: 'pdf', label: 'PDF', icon: FileText },
  // 图片
  png: { color: '#30D158', preview: 'image', label: 'PNG 图片', icon: FileImage },
  jpg: { color: '#30D158', preview: 'image', label: 'JPEG 图片', icon: FileImage },
  jpeg: { color: '#30D158', preview: 'image', label: 'JPEG 图片', icon: FileImage },
  gif: { color: '#30D158', preview: 'image', label: 'GIF 图片', icon: FileImage },
  webp: { color: '#30D158', preview: 'image', label: 'WebP 图片', icon: FileImage },
  bmp: { color: '#30D158', preview: 'image', label: 'BMP 图片', icon: FileImage },
  svg: { color: '#30D158', preview: 'image', label: 'SVG 图片', icon: FileImage },
  // 压缩包
  zip: { color: '#FF9F0A', preview: 'binary', label: 'ZIP 压缩包', icon: FileArchive },
  tar: { color: '#FF9F0A', preview: 'binary', label: 'TAR 归档', icon: FileArchive },
  gz: { color: '#FF9F0A', preview: 'binary', label: 'GZ 压缩', icon: FileArchive },
  tgz: { color: '#FF9F0A', preview: 'binary', label: 'TGZ 压缩', icon: FileArchive },
  bz2: { color: '#FF9F0A', preview: 'binary', label: 'BZ2 压缩', icon: FileArchive },
  '7z': { color: '#FF9F0A', preview: 'binary', label: '7Z 压缩', icon: FileArchive },
  // 媒体
  mp4: { color: '#BF5AF2', preview: 'binary', label: 'MP4 视频', icon: FileVideo },
  mkv: { color: '#BF5AF2', preview: 'binary', label: 'MKV 视频', icon: FileVideo },
  mov: { color: '#BF5AF2', preview: 'binary', label: 'MOV 视频', icon: FileVideo },
  mp3: { color: '#BF5AF2', preview: 'binary', label: 'MP3 音频', icon: FileAudio },
  wav: { color: '#BF5AF2', preview: 'binary', label: 'WAV 音频', icon: FileAudio },
  // 可执行 / 其他
  exe: { color: '#8E8E93', preview: 'binary', label: '可执行文件', icon: File },
  bin: { color: '#8E8E93', preview: 'binary', label: '二进制文件', icon: File },
}

const MIME_MAP: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/css': 'css',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/zip': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-7z-compressed': '7z',
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
}

export function fileTypeInfo(name: string, mime?: string): FileType {
  const ext = (name.split('.').pop() || '').toLowerCase()
  let entry = EXT_MAP[ext]
  if (!entry && mime) {
    const mapped = MIME_MAP[mime]
    if (mapped) entry = EXT_MAP[mapped]
  }
  if (!entry) {
    entry = { color: '#8E8E93', preview: 'binary', label: '文件', icon: File }
  }
  return { icon: entry.icon, color: entry.color, preview: entry.preview, label: entry.label }
}

export function isPreviewable(mime: string | undefined, name: string): boolean {
  return fileTypeInfo(name, mime).preview !== 'binary'
}

/** 文件图标颜色（供行内图标使用） */
export function fileColor(name: string, mime?: string): string {
  return fileTypeInfo(name, mime).color
}

/* 供 FileIcon / DirectoryView 使用的便捷导出 */
export const FileIconComponent = File
export const FolderIcon = Folder
export const TextIcon = FileText
export const CheckIcon = FileCheck
export const CrossIcon = FileX
