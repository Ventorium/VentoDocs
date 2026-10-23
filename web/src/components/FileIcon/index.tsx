import { FileTextTwoTone, FolderOpenTwoTone } from '@ant-design/icons'
import { cn } from '@/lib/utils'
import { fileTypeInfo } from '@/lib/fileType'

type FileIconProps = {
  name: string
  size?: number
  className?: string
}

/** 按扩展名着色的文件图标。 */
const FileIcon = ({ name, size = 18, className }: FileIconProps) => {
  const { icon: Icon, color } = fileTypeInfo(name)
  return <Icon twoToneColor={color} style={{ fontSize: size, color }} className={cn('shrink-0', className)} />
}

export default FileIcon

/** 目录图标。 */
export const FolderIcon = ({ size = 18, className }: { size?: number; className?: string }) => (
  <FolderOpenTwoTone twoToneColor="#f59e0b" style={{ fontSize: size, color: '#f59e0b' }} className={cn('shrink-0', className)} />
)

/** 通用文本图标（未知类型兜底）。 */
export const TextIcon = ({ size = 18, className }: { size?: number; className?: string }) => (
  <FileTextTwoTone style={{ fontSize: size, color: '#9ca3af' }} className={cn('shrink-0', className)} />
)
