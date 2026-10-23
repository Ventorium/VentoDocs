import { useState } from 'react'
import { useRequest } from 'ahooks'
import {
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd'
import { PlusOutlined, TeamOutlined } from '@ant-design/icons'
import { client } from '@/api'
import type { Team, TeamDetail, User } from '@/api/schema'
import { msg } from '@/components/GlobalMessage'
import StateView from '@/components/StateView'
import { formatTime } from '@/lib/format'
import { useAuth } from '@/store/useAuth'

/** 团队管理：团队 CRUD、成员增删（管理员）。 */
const TeamsPage = () => {
  const { user } = useAuth()
  const me = user!
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createForm] = Form.useForm<{ name: string }>()
  const [renameTarget, setRenameTarget] = useState<Team | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameForm] = Form.useForm<{ name: string }>()
  const [detailTeam, setDetailTeam] = useState<Team | null>(null)
  const [addUserId, setAddUserId] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)

  const { data: teams, loading, error, refresh } = useRequest(async () => {
    const { error: err, data, response } = await client.get('/api/v1/teams')
    if (err || !data) {
      if (response?.status === 403) throw new Error('no-perm')
      throw new Error('加载失败')
    }
    return data
  })

  const {
    data: detail,
    loading: detailLoading,
    refresh: refreshDetail,
  } = useRequest(
    async () => {
      if (!detailTeam) return null
      const { error: err, data } = await client.get('/api/v1/teams/{team_id}', {
        params: { team_id: detailTeam.id },
        query: { with_members: 'true' },
      })
      if (err || !data) throw new Error('加载失败')
      return data as TeamDetail
    },
    {
      ready: !!detailTeam,
      refreshDeps: [detailTeam?.id],
    },
  )

  const { data: users } = useRequest(
    async () => {
      const { data } = await client.get('/api/v1/users')
      return (data ?? []) as User[]
    },
    { ready: !!detailTeam, refreshDeps: [detailTeam?.id, detail?.team.id] },
  )

  if (me.role !== 'admin') {
    return <StateView state="noPerm">{null}</StateView>
  }

  const doCreate = async () => {
    const v = await createForm.validateFields()
    setCreating(true)
    const res = await client.post('/api/v1/teams', { body: v })
    setCreating(false)
    if (res.error) return
    msg.success(`团队 ${v.name} 已创建`)
    setCreateOpen(false)
    createForm.resetFields()
    refresh()
  }

  const doRename = async () => {
    if (!renameTarget) return
    const v = await renameForm.validateFields()
    setRenaming(true)
    const res = await client.patch('/api/v1/teams/{team_id}', {
      params: { team_id: renameTarget.id },
      body: v,
    })
    setRenaming(false)
    if (res.error) return
    msg.success('团队已重命名')
    setRenameTarget(null)
    refresh()
  }

  const doDelete = async (t: Team) => {
    const res = await client.delete('/api/v1/teams/{team_id}', {
      params: { team_id: t.id },
    })
    if (res.error) return
    msg.success(`团队 ${t.name} 已删除`)
    refresh()
  }

  const doAddMember = async () => {
    if (!detailTeam || !addUserId) return
    setAdding(true)
    const res = await client.post('/api/v1/teams/{team_id}/members', {
      params: { team_id: detailTeam.id },
      body: { user_id: addUserId },
    })
    setAdding(false)
    if (res.error) return
    msg.success('成员已添加')
    setAddUserId(undefined)
    refreshDetail()
    refresh()
  }

  const doRemoveMember = async (userId: string, username: string) => {
    if (!detailTeam) return
    const res = await client.delete('/api/v1/teams/{team_id}/members/{user_id}', {
      params: { team_id: detailTeam.id, user_id: userId },
    })
    if (res.error) return
    msg.success(`已移除成员 ${username}`)
    refreshDetail()
    refresh()
  }

  const teamCols = [
    {
      title: '团队名称',
      dataIndex: 'name',
      render: (name: string, t: Team) => (
        <Button type="link" size="small" onClick={() => setDetailTeam(t)}>
          <TeamOutlined className="mr-6px" />
          {name}
        </Button>
      ),
    },
    {
      title: '成员数',
      dataIndex: 'member_count',
      width: 100,
      render: (n: number) => <Tag color={n > 0 ? 'blue' : 'default'}>{n}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 160,
      render: (t: string) => formatTime(t),
    },
    {
      title: '操作',
      width: 170,
      render: (_: unknown, t: Team) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setRenameTarget(t)
              renameForm.setFieldsValue({ name: t.name })
            }}
          >
            重命名
          </Button>
          <Popconfirm
            title={`删除团队「${t.name}」？`}
            description={t.member_count > 0 ? '该团队仍有成员，无法删除' : '删除后不可恢复'}
            okText="删除"
            okButtonProps={{ danger: true, disabled: t.member_count > 0 }}
            onConfirm={() => void doDelete(t)}
            disabled={t.member_count > 0}
          >
            <Button size="small" type="link" danger disabled={t.member_count > 0}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const memberCols = [
    { title: '用户名', dataIndex: 'username' },
    { title: '显示名', dataIndex: 'display_name' },
    {
      title: '来源',
      dataIndex: 'auth_provider',
      width: 90,
      render: (p: string) => (p === 'ldap' ? <Tag color="purple">LDAP</Tag> : <Tag>本地</Tag>),
    },
    {
      title: '操作',
      width: 100,
      render: (_: unknown, u: User) => (
        <Popconfirm
          title={`移除成员 ${u.username}？`}
          okText="移除"
          okButtonProps={{ danger: true }}
          onConfirm={() => void doRemoveMember(u.id, u.username)}
        >
          <Button size="small" type="link" danger>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  const memberIds = new Set((detail?.members ?? []).map((m) => m.id))
  const addableUsers = (users ?? []).filter((u) => !memberIds.has(u.id))

  return (
    <div className="flex flex-col gap-12px">
      <div className="flex items-center justify-between">
        <div className="text-16px font-600">团队管理</div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建团队
        </Button>
      </div>

      <div className="rounded-8px border-1px border-#E5E7EB bg-white">
        <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} retry={refresh}>
          <Table<Team>
            rowKey="id"
            size="small"
            dataSource={teams ?? []}
            columns={teamCols}
            locale={{ emptyText: '暂无团队' }}
            pagination={false}
          />
        </StateView>
      </div>

      <Modal
        title="新建团队"
        open={createOpen}
        onOk={() => void doCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={creating}
        okText="创建"
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="name" label="团队名称" rules={[{ required: true, message: '请输入团队名称' }]}>
            <Input placeholder="例如：研发团队" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={renameTarget ? `重命名团队 ${renameTarget.name}` : '重命名团队'}
        open={!!renameTarget}
        onOk={() => void doRename()}
        onCancel={() => setRenameTarget(null)}
        confirmLoading={renaming}
        okText="保存"
        destroyOnHidden
      >
        <Form form={renameForm} layout="vertical">
          <Form.Item name="name" label="团队名称" rules={[{ required: true, message: '请输入团队名称' }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detail ? `团队 ${detail.team.name}` : '团队详情'}
        width={520}
        open={!!detailTeam}
        onClose={() => setDetailTeam(null)}
        destroyOnHidden
      >
        <div className="flex flex-col gap-16px">
          <div className="flex items-center justify-between">
            <span className="text-14px font-600">成员（{detail?.team.member_count ?? 0}）</span>
            <Select
              placeholder="选择用户添加"
              value={addUserId}
              onChange={setAddUserId}
              style={{ width: 200 }}
              showSearch
              optionFilterProp="label"
              options={addableUsers.map((u) => ({
                value: u.id,
                label: `${u.username}（${u.display_name}）`,
              }))}
            />
          </div>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!addUserId}
            loading={adding}
            onClick={() => void doAddMember()}
          >
            添加成员
          </Button>
          <Table<User>
            rowKey="id"
            size="small"
            loading={detailLoading}
            dataSource={detail?.members ?? []}
            columns={memberCols}
            locale={{ emptyText: '暂无成员' }}
            pagination={false}
          />
        </div>
      </Drawer>
    </div>
  )
}

export default TeamsPage
