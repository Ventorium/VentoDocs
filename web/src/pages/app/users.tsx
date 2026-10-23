import { useState } from 'react'
import { useRequest } from 'ahooks'
import { Button, Form, Input, Modal, Select, Space, Switch, Table, Tag } from 'antd'
import { KeyOutlined, PlusOutlined, UserSwitchOutlined } from '@ant-design/icons'
import { client } from '@/api'
import type { LdapImportResult, Role, User } from '@/api/schema'
import { msg } from '@/components/GlobalMessage'
import StateView from '@/components/StateView'
import { formatTime } from '@/lib/format'
import { useAuth } from '@/store/useAuth'

type UserForm = {
  username: string
  display_name?: string
  password: string
  role: Role
}

type EditUserForm = {
  display_name: string
  role: Role
  disabled: boolean
}

/** 解析 LDAP 导入文本：每行「username[, 显示名]」。 */
function parseLdapText(text: string): { username: string; display_name?: string }[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [u, ...rest] = l.split(',')
      const username = u.trim()
      const dn = rest.join(',').trim()
      return dn ? { username, display_name: dn } : { username }
    })
    .filter((r) => r.username)
}

/** 用户管理：用户 CRUD、重置密码、禁用/启用、LDAP 导入（管理员）。 */
const UsersPage = () => {
  const { user } = useAuth()
  const me = user!
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createForm] = Form.useForm<UserForm>()
  const [editTarget, setEditTarget] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [editForm] = Form.useForm<EditUserForm>()
  const [pwdTarget, setPwdTarget] = useState<User | null>(null)
  const [pwd, setPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<LdapImportResult | null>(null)

  const { data: users, loading, error, refresh } = useRequest(async () => {
    const { error: err, data, response } = await client.get('/api/v1/users')
    if (err || !data) {
      if (response?.status === 403) throw new Error('no-perm')
      throw new Error('加载失败')
    }
    return data
  })

  if (me.role !== 'admin') {
    return <StateView state="noPerm">{null}</StateView>
  }

  const doCreate = async () => {
    const v = await createForm.validateFields()
    setCreating(true)
    const res = await client.post('/api/v1/users', { body: v })
    setCreating(false)
    if (res.error) return
    msg.success(`用户 ${v.username} 已创建`)
    setCreateOpen(false)
    createForm.resetFields()
    refresh()
  }

  const doSaveEdit = async () => {
    if (!editTarget) return
    const v = await editForm.validateFields()
    setSaving(true)
    const res = await client.patch('/api/v1/users/{id}', {
      params: { id: editTarget.id },
      body: v,
    })
    setSaving(false)
    if (res.error) return
    msg.success('用户已更新')
    setEditTarget(null)
    refresh()
  }

  const openEdit = (u: User) => {
    setEditTarget(u)
    editForm.setFieldsValue({
      display_name: u.display_name,
      role: u.role,
      disabled: u.disabled,
    })
  }

  const doResetPwd = async () => {
    if (!pwdTarget) return
    if (!pwd) return
    setPwdSaving(true)
    const res = await client.post('/api/v1/users/{id}/password', {
      params: { id: pwdTarget.id },
      body: { password: pwd },
    })
    setPwdSaving(false)
    if (res.error) return
    msg.success(`已重置 ${pwdTarget.username} 的密码`)
    setPwdTarget(null)
    setPwd('')
  }

  const doImport = async () => {
    const rows = parseLdapText(importText)
    if (rows.length === 0) {
      msg.warning('请输入至少一行用户名')
      return
    }
    setImporting(true)
    const res = await client.post('/api/v1/users/ldap/import', { body: { users: rows } })
    setImporting(false)
    if (res.error || !res.data) return
    setImportResult(res.data)
    refresh()
  }

  const cols = [
    { title: '用户名', dataIndex: 'username' },
    { title: '显示名', dataIndex: 'display_name' },
    {
      title: '来源',
      dataIndex: 'auth_provider',
      width: 90,
      render: (p: string) => (p === 'ldap' ? <Tag color="purple">LDAP</Tag> : <Tag>本地</Tag>),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 90,
      render: (r: Role) =>
        r === 'admin' ? <Tag color="blue">管理员</Tag> : <Tag>普通用户</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'disabled',
      width: 90,
      render: (d: boolean) =>
        d ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 160,
      render: (t: string) => formatTime(t),
    },
    {
      title: '操作',
      width: 280,
      render: (_: unknown, u: User) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => openEdit(u)}>
            编辑
          </Button>
          {u.auth_provider === 'local' && (
            <Button
              size="small"
              type="link"
              icon={<KeyOutlined />}
              onClick={() => setPwdTarget(u)}
            >
              重置密码
            </Button>
          )}
          <Button
            size="small"
            type="link"
            danger={u.disabled}
            onClick={() => openEdit(u)}
          >
            {u.disabled ? '启用' : '禁用'}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-12px">
      <div className="flex items-center justify-between">
        <div className="text-16px font-600">用户管理</div>
        <Space>
          <Button icon={<UserSwitchOutlined />} onClick={() => setImportOpen(true)}>
            LDAP 导入
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建用户
          </Button>
        </Space>
      </div>

      <div className="rounded-8px border-1px border-#E5E7EB bg-white">
        <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} retry={refresh}>
          <Table<User>
            rowKey="id"
            size="small"
            dataSource={users ?? []}
            columns={cols}
            locale={{ emptyText: '暂无用户' }}
            pagination={false}
          />
        </StateView>
      </div>

      <Modal
        title="新建用户"
        open={createOpen}
        onOk={() => void doCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={creating}
        okText="创建"
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" initialValues={{ role: 'user' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="登录用户名" autoComplete="off" />
          </Form.Item>
          <Form.Item name="display_name" label="显示名">
            <Input placeholder="可选，默认同用户名" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[{ required: true, message: '请输入初始密码' }, { min: 6, message: '至少 6 位' }]}
          >
            <Input.Password placeholder="至少 6 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'user', label: '普通用户' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editTarget ? `编辑用户 ${editTarget.username}` : '编辑用户'}
        open={!!editTarget}
        onOk={() => void doSaveEdit()}
        onCancel={() => setEditTarget(null)}
        confirmLoading={saving}
        okText="保存"
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="display_name" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'user', label: '普通用户' },
                { value: 'admin', label: '管理员' },
              ]}
            />
          </Form.Item>
          <Form.Item name="disabled" label="状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={pwdTarget ? `重置密码 · ${pwdTarget.username}` : '重置密码'}
        open={!!pwdTarget}
        onOk={() => void doResetPwd()}
        onCancel={() => {
          setPwdTarget(null)
          setPwd('')
        }}
        confirmLoading={pwdSaving}
        okText="重置"
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="新密码" required>
            <Input.Password
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="至少 6 位"
              autoComplete="new-password"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="LDAP 导入"
        open={importOpen}
        onOk={() => void doImport()}
        onCancel={() => setImportOpen(false)}
        confirmLoading={importing}
        okText="导入"
        width={560}
        destroyOnHidden
      >
        <div className="mb-8px text-13px text-rgba(0,0,0,0.65)">
          每行一个用户，格式：<code>username</code> 或 <code>username, 显示名</code>。已存在的用户名将跳过，导入用户的来源标记为 LDAP。
        </div>
        <Input.TextArea
          rows={8}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={'zhangsan\nlisi, 李四'}
        />
      </Modal>

      <Modal
        title="导入结果"
        open={!!importResult}
        onOk={() => {
          setImportResult(null)
          setImportOpen(false)
          setImportText('')
        }}
        cancelButtonProps={{ style: { display: 'none' } }}
        okText="完成"
      >
        {importResult && (
          <div className="flex flex-col gap-8px text-13px">
            <div>
              <span className="font-600">新建（{importResult.created.length}）：</span>
              {importResult.created.join('、') || '无'}
            </div>
            <div>
              <span className="font-600">跳过（{importResult.skipped.length}）：</span>
              {importResult.skipped.join('、') || '无'}
            </div>
            <div>
              <span className="font-600">失败（{importResult.failed.length}）：</span>
              {importResult.failed.join('；') || '无'}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default UsersPage
