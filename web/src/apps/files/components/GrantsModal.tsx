import { useEffect, useState } from 'react'
import { useRequest } from 'ahooks'
import { Plus, Trash2 } from 'lucide-react'
import type { GrantItem, Team, User } from '@/api/schema'
import { client } from '@/api'
import { Btn, Empty, IconBtn, Modal, Select, Spin, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
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
  const [removing, setRemoving] = useState<GrantItem | null>(null)

  const { data: grants, loading, run: reload } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/directories/{id}/grants', {
        params: { id: dirId! },
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

  const doRemove = async (g: GrantItem) => {
    if (!dirId) return
    const { error } = await client.delete('/api/v1/directories/{id}/grants/{ptype}/{pid}', {
      params: { id: dirId, ptype: g.principal_type, pid: g.principal_id },
    })
    if (error) return
    msg.success('已移除授权')
    setRemoving(null)
    reload()
  }

  const togglePerm = (bit: number) => {
    setChecked((prev) => (prev.includes(bit) ? prev.filter((b) => b !== bit) : [...prev, bit]))
  }

  return (
    <>
      <Modal open={open} title={`权限管理 · ${dirName}`} width={640} onClose={onClose}>
        <div className="vd-faint" style={{ fontSize: 12, marginTop: 4 }}>
          此权限适用于整个目录及其子目录。管理员与目录创建者始终拥有全部权限。
        </div>

        <div className="vd-table-wrap" style={{ marginTop: 10, border: '1px solid var(--vd-border-subtle)', borderRadius: 8 }}>
          {loading ? (
            <div className="vd-flex-center" style={{ height: 120 }}>
              <Spin />
            </div>
          ) : (grants ?? []).length === 0 ? (
            <Empty text="暂无授权，将在下方新增" />
          ) : (
            <table className="vd-table">
              <thead>
                <tr>
                  <th>对象</th>
                  <th>权限</th>
                  <th style={{ width: 150 }}>更新时间</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {grants?.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Tag color={g.principal_type === 'team' ? 'green' : 'blue'}>
                          {g.principal_type === 'team' ? '团队' : '用户'}
                        </Tag>
                        {g.principal_name}
                      </span>
                    </td>
                    <td>
                      <span title={permLabels(g.perms).join('、')}>{permSummary(g.perms)}</span>
                    </td>
                    <td>{formatDateTime(g.created_at)}</td>
                    <td>
                      <IconBtn small danger aria-label="移除" onClick={() => setRemoving(g)}>
                        <Trash2 size={14} />
                      </IconBtn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: 12, borderRadius: 6, background: 'rgba(127,127,127,0.08)', padding: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>新增 / 更新授权</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Select
              style={{ flex: 1 }}
              value={selected ?? ''}
              onChange={(e) => setSelected(e.target.value || null)}
            >
              <option value="">选择用户或团队</option>
              {!usersError
                ? (users ?? []).map((u) => (
                    <option key={u.id} value={`user:${u.id}`}>
                      {u.display_name || u.username}（用户）
                    </option>
                  ))
                : null}
              {(teams ?? []).map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  {t.name}（团队）
                </option>
              ))}
            </Select>
            <Btn variant="primary" loading={saving} onClick={() => void handleSave()}>
              <Plus size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              保存
            </Btn>
          </div>
          {usersError ? (
            <div className="vd-faint" style={{ fontSize: 12, marginTop: 6 }}>
              用户列表需要管理员权限，当前仅可按团队授权。
            </div>
          ) : null}
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
            {USER_CONFIGURABLE_PERMS.map((p) => (
              <label key={p.bit} className="vd-checkbox">
                <input
                  type="checkbox"
                  checked={checked.includes(p.bit)}
                  onChange={() => togglePerm(p.bit)}
                />
                {p.label}
              </label>
            ))}
          </div>
          <div className="vd-faint" style={{ marginTop: 6, fontSize: 12 }}>
            当前勾选：{permLabels(checked.reduce((a, b) => a | b, 0)).join('、') || '无'}
          </div>
        </div>
      </Modal>

      <Modal
        open={!!removing}
        title={`移除「${removing?.principal_name ?? ''}」的授权`}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Btn onClick={() => setRemoving(null)}>取消</Btn>
            <Btn variant="danger" loading={false} onClick={() => removing && void doRemove(removing)}>移除</Btn>
          </>
        }
      >
        <p className="m-0">移除后该对象将失去此目录（含子目录）上被显式授予的权限。</p>
      </Modal>
    </>
  )
}

export default GrantsModal
