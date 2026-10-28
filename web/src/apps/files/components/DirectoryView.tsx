import ColumnView from './ColumnView'

type DirectoryViewProps = {
  dirId: string | null
  onNavigateDir: (dirId: string | null) => void
  onOpenFile: (fileId: string) => void
}

/**
 * 目录浏览视图：薄封装，实际 UI 与交互全部在 ColumnView（VentoOS 多列复刻）。
 * 保留原 props 契约，registry 无需改动。
 */
const DirectoryView = ({ dirId, onNavigateDir, onOpenFile }: DirectoryViewProps) => {
  return <ColumnView dirId={dirId} onNavigateDir={onNavigateDir} onOpenFile={onOpenFile} />
}

export default DirectoryView
