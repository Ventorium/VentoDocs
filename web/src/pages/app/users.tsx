import { useState } from 'react'
import { useRequest } from 'ahooks'
import { Alert, Button, Descriptions, Form, Input, Modal, Select, Space, Spin, Switch, Table, Tag } from 'antd'
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
    setImporting(true)
    const res = await client.post('/api/v1/users/ldap/import', { body: undefined })
    setImporting(false)
    if (res.error || !res.data) return
    setImportResult(res.data)
    refresh()
  }

  // LDAP 服务端配置（只读展示，来自环境变量）
  const {
    data: ldapConfig,
    loading: ldapConfigLoading,
    error: ldapConfigError,
  } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/users/ldap/config')
      if (error || !data) throw new Error('LDAP 未配置')
      return data
    },
    { ready: importOpen },
  )

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
        onCancel={() => setImportOpen(false)}
        footer={[
          <Button key="close" onClick={() => setImportOpen(false)}>
            关闭
          </Button>,
          <Button
            key="import"
            type="primary"
            icon={<UserSwitchOutlined />}
            loading={importing}
            disabled={ldapConfigLoading || !!ldapConfigError}
            onClick={() => void doImport()}
          >
            从 LDAP 导入
          </Button>,
        ]}
        width={560}
        destroyOnHidden
      >
        <div className="flex flex-col gap-12px">
          {ldapConfigError ? (
            <Alert
              type="warning"
              showIcon
              message="LDAP 未配置"
              description="请在服务端设置 VIENTO_LDAP_HOST 等环境变量并重启服务后重试。"
            />
          ) : ldapConfigLoading || !ldapConfig ? (
            <div className="flex justify-center py-24px">
              <Spin />
            </div>
          ) : (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="服务器地址">
                {ldapConfig!.host}:{ldapConfig!.port}
                {ldapConfig!.startTls ? '（StartTLS）' : ''}
              </Descriptions.Item>
              <Descriptions.Item label="Base DN">{ldapConfig!.baseDn}</Descriptions.Item>
              <Descriptions.Item label="用户过滤器">{ldapConfig!.userFilter}</Descriptions.Item>
              <Descriptions.Item label="字段映射">
                用户名={ldapConfig!.attrUsername} · 显示名={ldapConfig!.attrName} · 邮箱={ldapConfig!.attrEmail}
              </Descriptions.Item>
            </Descriptions>
          )}
          <div className="text-12px text-#9CA3AF">
            按上述配置从 LDAP 同步用户：已存在的用户名将跳过并同步显示名/邮箱；导入的用户角色为普通用户。
            不在系统内修改 LDAP 密码；LDAP 侧删除不联动删除本地用户。
          </div>
        </div>
      </Modal>

      <Modal
        title="导入结果"
        open={!!importResult}
        onOk={() => {
          setImportResult(null)
          setImportOpen(false)
        }}
        cancelButtonProps={{ style: { display: 'none' } }}
        okText="完成"
      >
        {importResult && (
          <div className="flex flex-col gap-8px text-13px">
            <div>
              成功创建 <span className="font-600">{importResult.created}</span> 个用户
            </div>
            <div>
              跳过（已存在） <span className="font-600">{importResult.skipped}</span> 个
            </div>
            <div>
              失败 <span className="font-600">{importResult.failed.length}</span> 个
              {importResult.failed.length > 0 && (
                <ul className="m-0 mt-4px ml-16px list-disc text-#DC2626">
                  {importResult.failed.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default UsersPage
