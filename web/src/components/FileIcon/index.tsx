/**
 * 文件图标（M5：lucide 线条图标 + 类型色，替代 antd 双色调图标）。
 */
import { fileTypeInfo } from '@/lib/fileType'

export { FolderIcon } from '@/lib/fileType'

export default function FileIcon({
  name,
  mime,
  size = 18,
  style,
}: {
  name: string
  mime?: string
  size?: number
  style?: React.CSSProperties
}) {
  const info = fileTypeInfo(name, mime)
  const Icon = info.icon
  return <Icon size={size} style={{ color: info.color, ...style }} aria-label={info.label} />
}
