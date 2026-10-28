/**
 * 应用注册表（M5）：清单 + 渐变图标（Ventos 风格整块色块） + 渲染闭包。
 * 渲染闭包直接挂载应用组件（无独立路由）；file 窗口通过 props 传
 * fileId / onTitleChange，绕开窗口内 useParams 为空的问题。
 */
import type { ReactNode } from 'react'
import { FileText, FolderOpen, History, Settings, Trash2, Users } from 'lucide-react'
import { useWindows, type WinState } from '@/kernel/window/store'
import DirectoryView from '@/apps/files/components/DirectoryView'
import FileDetailPage from '@/apps/file/[id]'
import TrashPage from '@/apps/trash'
import SettingsPage from '@/apps/settings'
import TeamsPage from '@/apps/teams'
import AuditsPage from '@/apps/audits'
import { APP_META, type AppMeta } from './manifest'

export type AppEntry = AppMeta & {
  icon: ReactNode
  render: (win: WinState) => ReactNode
}

/** 整块渐变图标（Ventos 风格）：容器尺寸由调用方设定，内部图标固定 22px。 */
function tile(cls: string, icon: ReactNode): ReactNode {
  return (
    <span className={`vd-app-icon ${cls}`} style={{ width: '100%', height: '100%' }}>
      {icon}
    </span>
  )
}

function buildApps(): AppEntry[] {
  const builders: Record<string, () => { icon: ReactNode; render: (win: WinState) => ReactNode }> = {
    explorer: () => ({
      icon: tile('vd-app-icon-explorer', <FolderOpen size={22} />),
      render: (win) => (
        <DirectoryView
          dirId={win.appState.dirId || null}
          onNavigateDir={(dirId) =>
            useWindows.getState().setAppState(win.id, dirId ? { dirId } : {})
          }
          onOpenFile={(fileId) => useWindows.getState().open('file', { fileId })}
        />
      ),
    }),
    file: () => ({
      icon: tile('vd-app-icon-file', <FileText size={22} />),
      render: (win) => (
        <FileDetailPage
          fileId={win.appState.fileId}
          onTitleChange={(name) => useWindows.getState().setTitle(win.id, name)}
        />
      ),
    }),
    trash: () => ({
      icon: tile('vd-app-icon-trash', <Trash2 size={22} />),
      render: () => <TrashPage />,
    }),
    settings: () => ({
      icon: tile('vd-app-icon-settings', <Settings size={22} />),
      render: () => <SettingsPage />,
    }),
    teams: () => ({
      icon: tile('vd-app-icon-teams', <Users size={22} />),
      render: () => <TeamsPage />,
    }),
    audits: () => ({
      icon: tile('vd-app-icon-audits', <History size={22} />),
      render: () => <AuditsPage />,
    }),
  }
  return APP_META.map((m) => {
    const b = builders[m.id] ?? { icon: null, render: () => null }
    return { ...m, ...b() }
  })
}

export const APPS: AppEntry[] = buildApps()

export const getApp = (id: string): AppEntry | undefined => APPS.find((a) => a.id === id)
