/**
 * 通知中心（M4）：顶栏铃铛 + 未读徽标 + 下拉活动面板。
 * 数据：GET /api/v1/notifications（管理员=全部活动，普通用户=仅本人操作）。
 * 未读数 = 最近条目中晚于上次打开时间戳（localStorage）的条数；打开面板即标记已读。
 */
import { useState } from 'react'
import { Badge, Popover } from 'antd'
import {
  BellOutlined,
  FileOutlined,
  LockOutlined,
  SettingOutlined,
  ShareAltOutlined,
  SendOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useRequest } from 'ahooks'
import { client } from '@/api'
import type { AuditEntry } from '@/api/schema'
import { formatTime } from '@/lib/format'
import { useAuth } from '@/store/useAuth'

const SEEN_KEY = 'vd-notif-seen-at'

const ACTION_TEXT: Record<string, string> = {
  'file/upload': '上传了文件',
  'file/save': '保存了文件',
  'file/trash': '删除了文件',
  'file/restore': '从回收站恢复了文件',
  'file/dir_create': '创建了文件夹',
  'file/dir_trash': '删除了文件夹',
  'file/dir_restore': '恢复了文件夹',
  'file/restore_version': '恢复了文件历史版本',
  'share/share_create': '创建了分享',
  'share/share_preview': '预览了分享',
  'share/share_access': '访问了分享',
  'share/share_download': '下载了分享文件',
  'share/share_revoke': '取消了分享',
  'share/share_verify': '验证了分享',
  'publish/publish_enable': '启用了发布',
  'publish/publish_disable': '关闭了发布',
  'admin/ldap_import': '从 LDAP 导入了用户',
  'admin/ldap_config_test': '测试了 LDAP 连接',
  'admin/ldap_config_save': '保存了 LDAP 配置',
  'admin/ldap_config_delete': '重置了 LDAP 配置',
  'admin/user_create': '创建了用户',
  'admin/grant_set': '调整了权限',
  'admin/team_add_member': '添加了团队成员',
  'lock/lock': '登录了系统',
  'lock/unlock': '退出了登录',
}

function CategoryIcon({ category }: { category: string }) {
  const style = { fontSize: 15, color: 'var(--vd-accent)' }
  switch (category) {
    case 'file':
      return <FileOutlined style={style} />
    case 'share':
      return <ShareAltOutlined style={style} />
    case 'publish':
      return <SendOutlined style={style} />
    case 'admin':
      return <SettingOutlined style={style} />
    case 'lock':
      return <LockOutlined style={style} />
    default:
      return <UserOutlined style={style} />
  }
}

function entryText(e: AuditEntry): string {
  const actor = e.actor_name || '系统'
  const verb = ACTION_TEXT[`${e.category}/${e.action}`] ?? e.action
  const name = typeof e.detail?.name === 'string' ? `「${e.detail.name}」` : ''
  return `${actor} ${verb}${name}`
}

function relTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  return formatTime(ts)
}

function readSeenAt(): number {
  const v = Number(localStorage.getItem(SEEN_KEY) || 0)
  return Number.isFinite(v) ? v : 0
}

export default function NotificationsBell({ onOpenAudits }: { onOpenAudits?: () => void }) {
  const user = useAuth((s) => s.user)
  const isAdmin = user?.role === 'admin'
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AuditEntry[] | null>(null)

  const { loading, run } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/notifications', { query: { limit: 30 } })
      if (error || !data) return
      setItems(data as unknown as AuditEntry[])
    },
    { manual: true },
  )

  const fetchAndMarkRead = async () => {
    await run()
    localStorage.setItem(SEEN_KEY, String(Date.now()))
  }

  // 首次挂载拉一次（仅用于未读徽标，不标记已读）
  useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/notifications', { query: { limit: 30 } })
      if (!error && data) setItems(data as unknown as AuditEntry[])
    },
    { manual: false },
  )

  const seenAt = readSeenAt()
  const unread = (items ?? []).filter((e) => new Date(e.ts).getTime() > seenAt).length

  const content = (
    <div className="vd-notif-panel">
      <div className="vd-notif-head">
        <span>活动通知</span>
        <span className="vd-notif-sub">最近 {items?.length ?? 0} 条</span>
      </div>
      <div className="vd-notif-list">
        {loading && !items ? (
          <div className="vd-notif-empty">加载中…</div>
        ) : items && items.length > 0 ? (
          items.map((e) => (
            <div key={e.id} className="vd-notif-item">
              <span className="vd-notif-ico">
                <CategoryIcon category={e.category} />
              </span>
              <div className="vd-notif-main">
                <div className="vd-notif-text">{entryText(e)}</div>
                <div className="vd-notif-time" title={formatTime(e.ts)}>
                  {relTime(e.ts)}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="vd-notif-empty">暂无最近活动</div>
        )}
      </div>
      {isAdmin && onOpenAudits && (
        <div className="vd-notif-foot">
          <a onClick={onOpenAudits}>查看全部审计日志</a>
        </div>
      )}
    </div>
  )

  return (
    <Popover
      content={content}
      trigger={['click']}
      open={open}
      arrow={false}
      placement="bottomRight"
      overlayClassName="vd-notif-pop"
      onOpenChange={(v) => {
        setOpen(v)
        if (v) fetchAndMarkRead()
      }}
    >
      <button type="button" className="vd-tb-btn vd-notif-bell" title="通知中心">
        <Badge count={unread} size="small" offset={[-2, 2]}>
          <BellOutlined />
        </Badge>
      </button>
    </Popover>
  )
}
