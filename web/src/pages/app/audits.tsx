import { useState } from 'react'
import { useRequest } from 'ahooks'
import { Button, Input, Popover, Select, Table, Tag } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { client } from '@/api'
import type { AuditEntry } from '@/api/schema'
import StateView from '@/components/StateView'
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
]

const CATEGORY_TAG: Record<string, string> = {
  auth: 'geekblue',
  file: 'green',
  directory: 'blue',
  user: 'purple',
  team: 'cyan',
  admin: 'red',
}

/** 审计日志：按类别/操作筛选，分页查看（管理员）。 */
const AuditsPage = () => {
  const { user } = useAuth()
  const me = user!
  const [category, setCategory] = useState<string | undefined>(undefined)
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)

  const { data, loading, error, refresh } = useRequest(
    async () => {
      const query: Record<string, string | number> = {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }
      if (category) query.category = category
      const act = action.trim()
      if (act) query.action = act
      const { error: err, data: d } = await client.get('/api/v1/audits', { query })
      if (err || !d) throw new Error('加载失败')
      return d as AuditEntry[]
    },
    { refreshDeps: [category, action, page] },
  )

  if (me.role !== 'admin') {
    return <StateView state="noPerm">{null}</StateView>
  }

  const cols = [
    {
      title: '时间',
      dataIndex: 'ts',
      width: 170,
      render: (t: string) => formatDateTime(t),
    },
    {
      title: '操作人',
      dataIndex: 'actor_name',
      width: 130,
      render: (n: string | null) => n ?? '系统',
    },
    {
      title: '类别',
      dataIndex: 'category',
      width: 90,
      render: (c: string) => <Tag color={CATEGORY_TAG[c] ?? 'default'}>{c}</Tag>,
    },
    { title: '操作', dataIndex: 'action', width: 160 },
    {
      title: '资源',
      width: 200,
      ellipsis: true,
      render: (_: unknown, r: AuditEntry) =>
        r.resource_type ? `${r.resource_type}:${(r.resource_id ?? '').slice(0, 8)}` : '-',
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 130,
      render: (ip: string | null) => ip ?? '-',
    },
    {
      title: '详情',
      width: 80,
      render: (_: unknown, r: AuditEntry) => {
        const detail = r.detail ?? {}
        const text = Object.keys(detail).length > 0 ? JSON.stringify(detail, null, 2) : '无'
        return (
          <Popover
            content={
              <pre className="max-h-400px max-w-520px overflow-auto text-12px leading-20px">
                {text}
              </pre>
            }
          >
            <Button size="small" type="link">
              查看
            </Button>
          </Popover>
        )
      },
    },
  ]

  return (
    <div className="flex flex-col gap-12px">
      <div className="text-16px font-600">审计日志</div>

      <div className="flex items-center gap-8px rounded-8px border-1px border-#E5E7EB bg-white p-12px">
        <Select
          allowClear
          placeholder="类别"
          value={category}
          onChange={setCategory}
          style={{ width: 140 }}
          options={CATEGORY_OPTIONS}
        />
        <Input
          allowClear
          placeholder="操作，如 upload"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ width: 200 }}
        />
        <Button
          type="primary"
          icon={<SearchOutlined />}
          onClick={() => {
            setPage(1)
            refresh()
          }}
        >
          查询
        </Button>
      </div>

      <div className="rounded-8px border-1px border-#E5E7EB bg-white">
        <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} retry={refresh}>
          <Table<AuditEntry>
            rowKey="id"
            size="small"
            dataSource={data ?? []}
            columns={cols}
            locale={{ emptyText: '暂无审计记录' }}
            pagination={{
              current: page,
              pageSize: PAGE_SIZE,
              showSizeChanger: false,
              onChange: setPage,
            }}
          />
        </StateView>
      </div>
    </div>
  )
}

export default AuditsPage
