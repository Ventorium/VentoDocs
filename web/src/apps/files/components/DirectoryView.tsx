import ColumnView from './ColumnView'

type DirectoryViewProps = {
  dirId: string | null
  /** 刷新恢复：初始共享作用域（team/me），null = 个人作用域 */
  initialScope?: 'team' | 'me' | null
  onNavigateDir: (dirId: string | null, scope?: 'personal' | 'team' | 'me') => void
  onOpenFile: (fileId: string) => void
  /** M2.20：窗口标题回传（多 FM 窗口区分当前作用域/路径） */
  onTitleChange?: (title: string) => void
}

/**
 * 目录浏览视图：薄封装，实际 UI 与交互全部在 ColumnView（VentoOS 多列复刻）。
 * M2.19：新增 initialScope，用于刷新后恢复共享作用域（团队共享/分享给我）下的钻取位置。
 */
const DirectoryView = ({ dirId, initialScope = null, onNavigateDir, onOpenFile, onTitleChange }: DirectoryViewProps) => {
  return (
    <ColumnView
      dirId={dirId}
      initialScope={initialScope}
      onNavigateDir={onNavigateDir}
      onOpenFile={onOpenFile}
      onTitleChange={onTitleChange}
    />
  )
}

export default DirectoryView
