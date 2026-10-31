import { useEffect, useState } from 'react'
import { useRequest } from 'ahooks'
import { Copy, Plus, Trash2 } from 'lucide-react'
import type { FileGrantItem, GrantItem, Team, User } from '@/api/schema'
import { client } from '@/api'
import { Btn, Empty, IconBtn, Modal, Select, Spin, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { formatDateTime } from '@/lib/format'
import { USER_CONFIGURABLE_PERMS, permLabels, permSummary } from '@/lib/perm'

type GrantsModalProps = {
  open: boolean
  dirId: string | null
  dirName: string
  /** M2.23：文件模式——dirId 仍为所在目录 id（供门控/上下文），file 为被管理文件。 */
  file?: { id: string; name: string } | null
  onClose: () => void
}

/** 合并后的授权行：文件模式 = 本文件独立授权（file）+ 所在目录继承授权（dir）。 */
type Row = {
  id: string
  principal_type: 'user' | 'team'
  principal_id: string
  principal_name: string
  perms: number
  created_at: string
  source: 'file' | 'dir'
}

const dirRow = (g: GrantItem): Row => ({
  id: g.id,
  principal_type: g.principal_type,
  principal_id: g.principal_id,
  principal_name: g.principal_name,
  perms: g.perms,
  created_at: g.created_at,
  source: 'dir',
})

const fileRow = (g: FileGrantItem): Row => ({
  id: g.id,
  principal_type: g.principal_type,
  principal_id: g.principal_id,
  principal_name: g.principal_name,
  perms: g.perms,
  created_at: g.created_at,
  source: 'file',
})

const bitsOf = (perms: number): number[] => USER_CONFIGURABLE_PERMS.map((p) => p.bit).filter((b) => (perms & b) === b)

/**
 * 权限管理弹窗（M2.23 增加文件级模式）：
 * - 目录模式（原样）：按用户/团队授予 8 项权限，作用于整个目录树。
 * - 文件模式：管理「本文件独立授权」——对同一主体覆盖所在目录的继承权限；
 *   「恢复继承」删除该主体的文件授权使其回退为目录权限；「覆盖继承」把某继承行
 *   的权限预填进编辑器，保存即创建覆盖。
 */
const GrantsModal = ({ open, dirId, dirName, file, onClose }: GrantsModalProps) => {
  const isFile = !!file
  const [selected, setSelected] = useState<string | null>(null) // `${type}:${id}`
  const [checked, setChecked] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<Row | null>(null)

  const { data: rows, loading, run: reload } = useRequest(
    async () => {
      if (isFile && file) {
        const { error, data } = await client.get('/api/v1/files/{id}/grants', { params: { id: file.id } })
        if (error || !data) throw new Error('加载权限失败')
        const fg = data.file_grants ?? []
        const inherited = data.inherited?.grants ?? []
        const fileKeys = new Set(fg.map((g) => `${g.principal_type}:${g.principal_id}`))
        return [...fg.map(fileRow), ...inherited.filter((g) => !fileKeys.has(`${g.principal_type}:${g.principal_id}`)).map(dirRow)]
      }
      const { error, data } = await client.get('/api/v1/directories/{id}/grants', { params: { id: dirId! } })
      if (error || !data) throw new Error('加载权限失败')
      return (data.grants ?? []).map(dirRow)
    },
    { ready: open && (isFile ? !!file?.id : !!dirId), refreshDeps: [dirId, file?.id, open] },
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
    const { error } = await client.put(isFile ? '/api/v1/files/{id}/grants' : '/api/v1/directories/{id}/grants', {
      params: { id: isFile && file ? file.id : dirId! },
      body: {
        principal_type: ptype === 'team' ? 'team' : 'user',
        principal_id: pid,
        perms: checked.reduce((acc, b) => acc | b, 0),
      },
    })
    setSaving(false)
    if (error) return
    msg.success(isFile ? '已保存文件权限' : '已保存授权')
    setSelected(null)
    setChecked([USER_CONFIGURABLE_PERMS[0].bit])
    reload()
  }

  /** 恢复继承：删除该主体的文件级授权，回退为所在目录的继承权限。 */
  const doRestore = async (r: Row) => {
    if (!isFile || !file) return
    const { error } = await client.delete('/api/v1/files/{id}/grants/{ptype}/{pid}', {
      params: { id: file.id, ptype: r.principal_type, pid: r.principal_id },
    })
    if (error) return
    msg.success('已恢复为目录权限')
    setRemoving(null)
    reload()
  }

  const doRemove = async (r: Row) => {
    if (!dirId) return
    const { error } = await client.delete('/api/v1/directories/{id}/grants/{ptype}/{pid}', {
      params: { id: dirId, ptype: r.principal_type, pid: r.principal_id },
    })
    if (error) return
    msg.success('已移除授权')
    setRemoving(null)
    reload()
  }

  /** 覆盖继承：把继承行的权限预填进编辑器，供用户调整后保存为文件级覆盖。 */
  const prefillOverride = (r: Row) => {
    setSelected(`${r.principal_type}:${r.principal_id}`)
    setChecked(bitsOf(r.perms))
  }

  const togglePerm = (bit: number) => {
    setChecked((prev) => (prev.includes(bit) ? prev.filter((b) => b !== bit) : [...prev, bit]))
  }

  const removeText =
    removing?.source === 'file'
      ? `移除「${removing?.principal_name ?? ''}」在本文件上的独立权限，该对象将回退为所在目录的继承权限。`
      : `移除后该对象将失去此目录（含子目录）上被显式授予的权限。`

  return (
    <>
      <Modal open={open} title={isFile ? `权限管理 · 文件「${file!.name}」` : `权限管理 · ${dirName}`} width={680} onClose={onClose}>
        <div className="vd-faint" style={{ fontSize: 12, marginTop: 4 }}>
          {isFile
            ? '本文件独立权限覆盖所在目录的继承权限（针对同一主体）；未单独管理的对象沿用目录权限。文件创建者始终拥有全部权限。'
            : '此权限适用于整个目录及其子目录。目录创建者始终拥有全部权限，且仅目录创建者可管理授权。'}
        </div>

        <div className="vd-table-wrap" style={{ marginTop: 10, border: '1px solid var(--vd-border-subtle)', borderRadius: 8 }}>
          {loading ? (
            <div className="vd-flex-center" style={{ height: 120 }}>
              <Spin />
            </div>
          ) : (rows ?? []).length === 0 ? (
            <Empty text={isFile ? '暂无授权，本文件继承所在目录权限' : '暂无授权，将在下方新增'} />
          ) : (
            <table className="vd-table">
              <thead>
                <tr>
                  <th>对象</th>
                  <th>权限</th>
                  {isFile ? <th style={{ width: 70 }}>来源</th> : null}
                  <th style={{ width: 150 }}>更新时间</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {rows?.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Tag color={r.principal_type === 'team' ? 'green' : 'blue'}>
                          {r.principal_type === 'team' ? '团队' : '用户'}
                        </Tag>
                        {r.principal_name}
                      </span>
                    </td>
                    <td>
                      <span title={permLabels(r.perms).join('、')}>{permSummary(r.perms)}</span>
                    </td>
                    {isFile ? (
                      <td>
                        <Tag color={r.source === 'file' ? 'green' : 'gray'}>{r.source === 'file' ? '本文件' : '继承'}</Tag>
                      </td>
                    ) : null}
                    <td>{formatDateTime(r.created_at)}</td>
                    <td>
                      {r.source === 'file' ? (
                        <IconBtn small danger aria-label="恢复继承" onClick={() => setRemoving(r)}>
                          <Trash2 size={14} />
                        </IconBtn>
                      ) : isFile ? (
                        <IconBtn small aria-label="覆盖继承" onClick={() => prefillOverride(r)}>
                          <Copy size={14} />
                        </IconBtn>
                      ) : (
                        <IconBtn small danger aria-label="移除" onClick={() => setRemoving(r)}>
                          <Trash2 size={14} />
                        </IconBtn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: 12, borderRadius: 6, background: 'rgba(127,127,127,0.08)', padding: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
            {isFile ? '新增 / 更新本文件独立权限（保存后覆盖该对象的继承权限）' : '新增 / 更新授权'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Select
              style={{ flex: 1 }}
              value={selected ?? ''}
              onChange={(e) => setSelected(e.target.value || null)}
            >
              <option value="">{isFile ? '选择用户或团队（将创建文件级覆盖）' : '选择用户或团队'}</option>
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
        title={removing?.source === 'file' ? `移除「${removing?.principal_name ?? ''}」的文件级权限` : `移除「${removing?.principal_name ?? ''}」的授权`}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Btn onClick={() => setRemoving(null)}>取消</Btn>
            <Btn
              variant="danger"
              onClick={() => {
                if (!removing) return
                void (removing.source === 'file' ? doRestore(removing) : doRemove(removing))
              }}
            >
              {removing?.source === 'file' ? '恢复继承' : '移除'}
            </Btn>
          </>
        }
      >
        <p className="m-0">{removeText}</p>
      </Modal>
    </>
  )
}

export default GrantsModal
