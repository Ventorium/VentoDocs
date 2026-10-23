import { useEffect, useState } from 'react'
import { useRequest } from 'ahooks'
import { Button, Checkbox, Modal, Select, Table, Tag, Tooltip } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { GrantItem, Team, User } from '@/api/schema'
import { client } from '@/api'
import { msg } from '@/components/GlobalMessage'
import { formatDateTime } from '@/lib/format'
import { USER_CONFIGURABLE_PERMS, permLabels, permSummary } from '@/lib/perm'

type GrantsModalProps = {
  open: boolean
  dirId: string | null
  dirName: string
  onClose: () => void
}

/** 目录权限管理弹窗：按用户 / 团队授予 8 项可配置权限（作用于整个目录树）。 */
const GrantsModal = ({ open, dirId, dirName, onClose }: GrantsModalProps) => {
  const [selected, setSelected] = useState<string | null>(null) // `${type}:${id}`
  const [checked, setChecked] = useState<number[]>([])
  const [saving, setSaving] = useState(false)

  const { data: grants, loading, run: reload } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/directories/{id}/grants', {
        params: { id: dirId! }
      })
      if (error || !data) throw new Error('加载权限失败')
      return data.grants
    },
    { ready: open && !!dirId, refreshDeps: [dirId, open] },
  )

  const { data: users, error: usersError } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/users')
      if (error || !data) return []
      return data as unknown as User[]
    },
    { ready: open },
  )

  const { data: teams } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/teams')
      if (error || !data) return []
      return data as unknown as Team[]
    },
    { ready: open },
  )

  useEffect(() => {
    if (open) {
      setSelected(null)
      setChecked([USER_CONFIGURABLE_PERMS[0].bit])
    }
  }, [open])

  const handleSave = async () => {
    if (!selected) {
      msg.warning('请选择授权对象')
      return
    }
    if (checked.length === 0) {
      msg.warning('请至少勾选一项权限')
      return
    }
    const [ptype, pid] = selected.split(':') as [string, string]
    setSaving(true)
    const { error } = await client.put('/api/v1/directories/{id}/grants', {
      params: { id: dirId! },
      body: {
        principal_type: ptype === 'team' ? 'team' : 'user',
        principal_id: pid,
        perms: checked.reduce((acc, b) => acc | b, 0),
      },
    })
    setSaving(false)
    if (error) return
    msg.success('已保存授权')
    setSelected(null)
    setChecked([USER_CONFIGURABLE_PERMS[0].bit])
    reload()
  }

  const handleRemove = (g: GrantItem) => {
    Modal.confirm({
      title: `移除「${g.principal_name}」的授权`,
      content: '移除后该对象将失去此目录（含子目录）上被显式授予的权限。',
      okText: '移除',
      okButtonProps: { danger: true },
      onOk: async () => {
        const { error } = await client.delete(
          '/api/v1/directories/{id}/grants/{ptype}/{pid}',
          {
            params: { id: dirId!, ptype: g.principal_type, pid: g.principal_id },
          },
        )
        if (error) return
        msg.success('已移除授权')
        reload()
      },
    })
  }

  return (
    <Modal
      open={open}
      title={`权限管理 · ${dirName}`}
      width={640}
      footer={null}
      destroyOnHidden
      onCancel={onClose}
    >
      <div className="text-12px text-#9CA3AF mt-4px">
        此权限适用于整个目录及其子目录。管理员与目录创建者始终拥有全部权限。
      </div>
      <Table<GrantItem>
        rowKey="id"
        size="middle"
        className="mt-10px"
        loading={loading}
        dataSource={grants ?? []}
        pagination={false}
        locale={{ emptyText: '暂无授权，将在下方新增' }}
        columns={[
          {
            title: '对象',
            dataIndex: 'principal_name',
            render: (name: string, r) => (
              <span className="flex items-center gap-6px">
                <Tag color={r.principal_type === 'team' ? 'purple' : 'blue'} className="!m-0">
                  {r.principal_type === 'team' ? '团队' : '用户'}
                </Tag>
                {name}
              </span>
            ),
          },
          {
            title: '权限',
            dataIndex: 'perms',
            render: (p: number) => (
              <Tooltip title={permLabels(p).join('、')}>
                <span>{permSummary(p)}</span>
              </Tooltip>
            ),
          },
          {
            title: '更新时间',
            dataIndex: 'created_at',
            width: 150,
            render: (t: string) => formatDateTime(t),
          },
          {
            title: '',
            width: 60,
            render: (_, r) => (
              <Button
                type="text"
                danger
                size="small"
                icon={<DeleteOutlined />}
                onClick={() => handleRemove(r)}
              />
            ),
          },
        ]}
      />
      <div className="mt-12px rounded-6px bg-#F7F8FA p-10px">
        <div className="text-13px font-medium mb-8px">新增 / 更新授权</div>
        <div className="flex gap-8px">
          <Select
            style={{ flex: 1 }}
            placeholder="选择用户或团队"
            value={selected}
            onChange={setSelected}
            showSearch
            optionFilterProp="label"
            options={[
              ...(usersError
                ? []
                : (users ?? []).map((u) => ({
                    label: `${u.display_name || u.username}（用户）`,
                    value: `user:${u.id}`,
                  }))),
              ...(teams ?? []).map((t) => ({
                label: `${t.name}（团队）`,
                value: `team:${t.id}`,
              })),
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} loading={saving} onClick={handleSave}>
            保存
          </Button>
        </div>
        {usersError && (
          <div className="text-12px text-#9CA3AF mt-6px">
            用户列表需要管理员权限，当前仅可按团队授权。
          </div>
        )}
        <div className="mt-8px">
          <Checkbox.Group
            value={checked}
            onChange={(vals) => setChecked(vals as number[])}
            options={USER_CONFIGURABLE_PERMS.map((p) => ({ label: p.label, value: p.bit }))}
          />
        </div>
        <div className="mt-6px text-12px text-#9CA3AF">
          当前勾选：{permLabels(checked.reduce((a, b) => a | b, 0)).join('、') || '无'}
        </div>
      </div>
    </Modal>
  )
}

export default GrantsModal
