/**
 * 应用清单（纯元数据，无 React 依赖）：桌面/码头/启动台/窗口内核共用。
 * multiWindow 应用（file）按 appState.fileId 一窗一档；multiInstance 应用（explorer）每次打开新建窗口；其余为单窗口应用。
 */
export type AppMeta = {
  id: string
  name: string
  desc: string
  /** 每个文件一个窗口（否则单窗口：重开=聚焦） */
  multiWindow?: boolean
  /** 多实例应用（M2.20）：每次打开都新建窗口，如文件管理器 */
  multiInstance?: boolean
  defaultSize: { w: number; h: number }
  minSize?: { w: number; h: number }
  /** 仅管理员可见（桌面/码头/启动台/路由同步均受此约束） */
  adminOnly?: boolean
  /** 是否出现在桌面图标与码头 */
  launchable?: boolean
}

export const APP_META: AppMeta[] = [
  {
    id: 'explorer',
    name: '文件管理器',
    desc: '浏览、上传与共享文件',
    multiInstance: true,
    defaultSize: { w: 1000, h: 620 },
    minSize: { w: 64, h: 64 }, // M2.29：最小宽高 64px
    launchable: true,
  },
  {
    id: 'trash',
    name: '回收站',
    desc: '查看与恢复已删除的文件',
    defaultSize: { w: 860, h: 540 },
    minSize: { w: 64, h: 64 }, // M2.29：最小宽高 64px
    launchable: true,
  },
  {
    id: 'settings',
    name: '系统设置',
    desc: '外观与账户安全设置',
    defaultSize: { w: 820, h: 580 },
    minSize: { w: 64, h: 64 }, // M2.29：最小宽高 64px
    launchable: true,
  },
  {
    id: 'teams',
    name: '团队管理',
    desc: '团队、用户与 LDAP 导入',
    defaultSize: { w: 960, h: 580 },
    minSize: { w: 64, h: 64 }, // M2.29：最小宽高 64px
    launchable: true,
  },
  {
    id: 'audits',
    name: '审计日志',
    desc: '操作审计记录',
    defaultSize: { w: 1000, h: 580 },
    minSize: { w: 64, h: 64 }, // M2.29：最小宽高 64px
    launchable: true,
    adminOnly: true,
  },
  {
    id: 'file',
    name: '文件详情',
    desc: '文件预览与在线编辑',
    multiWindow: true,
    defaultSize: { w: 1080, h: 680 },
    minSize: { w: 64, h: 64 }, // M2.29：最小宽高 64px
    launchable: false,
  },
]

export const appMeta = (id: string): AppMeta | undefined => APP_META.find((a) => a.id === id)
