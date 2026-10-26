/**
 * 应用注册表（M2）：清单 + 彩色图标 + 渲染闭包。
 * 渲染闭包直接挂载现有页面组件（无独立路由）；file 窗口通过 props 传
 * fileId / onBack / onTitleChange，绕开窗口内 useParams 为空的问题。
 */
import type { ReactNode } from 'react'
import {
  AuditOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  SettingOutlined,
  TeamOutlined,
  UsergroupAddOutlined,
} from '@ant-design/icons'
import { globalNavigate } from '@/components/GlobalHistory'
import { useWindows, type WinState } from '@/kernel/window/store'
import DirectoryView from '@/pages/app/files/components/DirectoryView'
import FileDetailPage from '@/pages/app/file/[id]'
import TrashPage from '@/pages/app/trash'
import SettingsPage from '@/pages/app/settings'
import TeamsPage from '@/pages/app/teams'
import UsersPage from '@/pages/app/users'
import AuditsPage from '@/pages/app/audits'
import { APP_META, type AppMeta } from './manifest'

export type AppEntry = AppMeta & {
  icon: ReactNode
  render: (win: WinState) => ReactNode
}

function buildApps(): AppEntry[] {
  const builders: Record<string, () => { icon: ReactNode; render: (win: WinState) => ReactNode }> = {
    explorer: () => ({
      icon: <FolderOpenOutlined style={{ color: '#f5a623' }} />,
      render: (win) => <DirectoryView dirId={win.appState.dirId || null} />,
    }),
    file: () => ({
      icon: <FileTextOutlined style={{ color: '#4a90d9' }} />,
      render: (win) => (
        <FileDetailPage
          fileId={win.appState.fileId}
          onBack={() => {
            useWindows.getState().close(win.id)
            globalNavigate('/app/files')
          }}
          onTitleChange={(name) => useWindows.getState().setTitle(win.id, name)}
        />
      ),
    }),
    trash: () => ({
      icon: <DeleteOutlined style={{ color: '#8e8e93' }} />,
      render: () => <TrashPage />,
    }),
    settings: () => ({
      icon: <SettingOutlined style={{ color: '#64748b' }} />,
      render: () => <SettingsPage />,
    }),
    teams: () => ({
      icon: <TeamOutlined style={{ color: '#007aff' }} />,
      render: () => <TeamsPage />,
    }),
    users: () => ({
      icon: <UsergroupAddOutlined style={{ color: '#34c759' }} />,
      render: () => <UsersPage />,
    }),
    audits: () => ({
      icon: <AuditOutlined style={{ color: '#af52de' }} />,
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
