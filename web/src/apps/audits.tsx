import { useState } from 'react'
import { useRequest } from 'ahooks'
import { History, Search } from 'lucide-react'
import { client } from '@/api'
import type { AuditEntry } from '@/api/schema'
import StateView from '@/components/StateView'
import { Btn, Drawer, Input, Select, Spin, Tag } from '@/components/ui/kit'
import { formatDateTime } from '@/lib/format'
import { useAuth } from '@/store/useAuth'

const PAGE_SIZE = 50

const CATEGORY_OPTIONS = [
  { value: 'auth', label: '认证' },
  { value: 'file', label: '文件' },
  { value: 'directory', label: '目录' },
  { value: 'user', label: '用户' },
  { value: 'team', label: '团队' },
  { value: 'admin', label: '管理' },
  { value: 'lock', label: '编辑锁' },
  { value: 'publish', label: '发布' },
  { value: 'share', label: '分享' },
]

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((o) => [o.value, o.label]),
)

const CATEGORY_TAG: Record<string, 'blue' | 'green' | 'red' | 'gray'> = {
  auth: 'blue',
  file: 'green',
  directory: 'blue',
  user: 'gray',
  team: 'gray',
  admin: 'red',
  lock: 'gray',
  publish: 'blue',
  share: 'green',
}

/** 审计操作标识 → 中文显示（数据库中保存英文标识，仅展示层翻译）。 */
const ACTION_LABEL: Record<string, string> = {
  bootstrap: '系统初始化',
  upload: '上传文件',
  save: '保存文件',
  trash: '删除文件',
  restore: '恢复文件',
  restore_version: '恢复历史版本',
  dir_create: '新建目录',
  dir_trash: '删除目录',
  dir_restore: '恢复目录',
  dir_rename: '重命名目录',
  dir_move: '移动目录',
  move: '移动文件',
  rename: '重命名文件',
  lock: '获取编辑锁',
  unlock: '释放编辑锁',
  publish_enable: '启用发布',
  publish_disable: '停用发布',
  share_create: '创建分享',
  share_revoke: '撤销分享',
  share_access: '访问分享',
  share_verify: '验证分享',
  share_preview: '分享预览',
  share_download: '分享下载',
  grant_set: '设置目录权限',
  grant_remove: '移除目录权限',
  team_create: '创建团队',
  team_rename: '重命名团队',
  team_add_member: '添加团队成员',
  team_remove_member: '移除团队成员',
  team_delete: '删除团队',
  user_create: '创建用户',
  user_update: '更新用户',
  password_reset: '重置密码',
  ldap_import: 'LDAP 导入用户',
}

const ACTION_LABEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(ACTION_LABEL).map(([k, v]) => [v, k]),
)

const RESOURCE_LABEL: Record<string, string> = {
  file: '文件',
  directory: '目录',
  user: '用户',
  team: '团队',
  share: '分享',
  publish: '发布',
}

/** 审计日志：按类别/操作筛选，分页查看（管理员）。 */
const AuditsPage = () => {
  const { user } = useAuth()
  const me = user!
  const [category, setCategory] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<AuditEntry | null>(null)

  const { data, loading, error, refresh } = useRequest(
    async () => {
      const query: Record<string, string | number> = {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }
      if (category) query.category = category
      const act = action.trim()
      if (act) query.action = ACTION_LABEL_TO_KEY[act] ?? act
      const { error: err, data: d } = await client.get('/api/v1/audits', { query })
      if (err || !d) throw new Error('加载失败')
      return d as AuditEntry[]
    },
    { refreshDeps: [category, action, page] },
  )

  if (me.role !== 'admin') {
    return <StateView state="noPerm">{null}</StateView>
  }

  const detailText = detail ? JSON.stringify(detail.detail ?? {}, null, 2) : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>审计日志</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8, border: '1px solid var(--vd-border-subtle)', background: 'var(--vd-bg-overlay)', padding: 12 }}>
        <Select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
            setPage(1)
          }}
          style={{ width: 140 }}
        >
          <option value="">全部类别</option>
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
        <Input
          placeholder="操作，如 上传文件"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ width: 200 }}
        />
        <Btn
          variant="primary"
          onClick={() => {
            setPage(1)
            refresh()
          }}
        >
          <Search size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          查询
        </Btn>
      </div>

      <div className="vd-table-wrap">
        <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} retry={refresh}>
          {loading ? (
            <div style={{ padding: 40 }}>
              <Spin />
            </div>
          ) : (data ?? []).length === 0 ? (
            <div className="vd-empty">暂无审计记录</div>
          ) : (
            <>
              <table className="vd-table">
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>时间</th>
                    <th style={{ width: 130 }}>操作人</th>
                    <th style={{ width: 90 }}>类别</th>
                    <th style={{ width: 160 }}>操作</th>
                    <th style={{ width: 200 }}>资源</th>
                    <th style={{ width: 130 }}>IP</th>
                    <th style={{ width: 80 }}>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDateTime(r.ts)}</td>
                      <td>{r.actor_name ?? '系统'}</td>
                      <td>
                        <Tag color={CATEGORY_TAG[r.category] ?? 'gray'}>
                          {CATEGORY_LABEL[r.category] ?? r.category}
                        </Tag>
                      </td>
                      <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                      <td>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 180 }}>
                          {r.resource_type
                            ? `${RESOURCE_LABEL[r.resource_type] ?? r.resource_type}:${(r.resource_id ?? '').slice(0, 8)}`
                            : '-'}
                        </span>
                      </td>
                      <td>{r.ip ?? '-'}</td>
                      <td>
                        <Btn size="xs" variant="ghost" onClick={() => setDetail(r)}>查看</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '8px 10px' }}>
                <span className="vd-faint" style={{ fontSize: 12, marginRight: 4 }}>
                  第 {page} 页，每页 {PAGE_SIZE} 条
                </span>
                <Btn size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  上一页
                </Btn>
                <Btn size="sm" disabled={(data ?? []).length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
                  下一页
                </Btn>
              </div>
            </>
          )}
        </StateView>
      </div>

      {/* 详情抽屉：Esc / 点遮罩 / ✕ 均可关闭，返回列表 */}
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={
          <>
            <History size={15} style={{ color: 'var(--vd-accent)' }} />
            审计日志详情
          </>
        }
      >
        {detail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <table className="vd-table" style={{ width: '100%' }}>
              <tbody>
                <tr>
                  <th style={{ width: 90 }}>时间</th>
                  <td>{formatDateTime(detail.ts)}</td>
                </tr>
                <tr>
                  <th>操作人</th>
                  <td>{detail.actor_name ?? '系统'}</td>
                </tr>
                <tr>
                  <th>类别</th>
                  <td>
                    <Tag color={CATEGORY_TAG[detail.category] ?? 'gray'}>
                      {CATEGORY_LABEL[detail.category] ?? detail.category}
                    </Tag>
                  </td>
                </tr>
                <tr>
                  <th>操作</th>
                  <td>{ACTION_LABEL[detail.action] ?? detail.action}</td>
                </tr>
                <tr>
                  <th>资源</th>
                  <td>
                    {detail.resource_type
                      ? `${RESOURCE_LABEL[detail.resource_type] ?? detail.resource_type}:${(detail.resource_id ?? '').slice(0, 8)}`
                      : '-'}
                  </td>
                </tr>
                <tr>
                  <th>IP</th>
                  <td>{detail.ip ?? '-'}</td>
                </tr>
              </tbody>
            </table>
            <div>
              <div className="vd-faint" style={{ fontSize: 12, marginBottom: 6 }}>详情数据</div>
              <pre
                style={{
                  margin: 0,
                  maxHeight: 360,
                  overflow: 'auto',
                  fontSize: 12,
                  lineHeight: 20,
                  background: 'var(--vd-bg-input)',
                  border: '1px solid var(--vd-border-subtle)',
                  borderRadius: 8,
                  padding: 10
                }}
              >
                {detailText}
              </pre>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}

export default AuditsPage
