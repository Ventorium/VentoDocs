import { useState } from 'react'
import { useRequest } from 'ahooks'
import { CloudUpload, KeyRound, Plus, Users } from 'lucide-react'
import { client } from '@/api'
import type { LdapImportResult, Role, Team, TeamDetail, User } from '@/api/schema'
import { Btn, Drawer, Input, Modal, Select, Spin, Switch, Tabs, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import StateView from '@/components/StateView'
import { formatTime } from '@/lib/format'
import { useAuth } from '@/store/useAuth'

type LdapConfigInfo = {
  host: string
  port: number
  startTls: boolean
  baseDn: string
  userFilter: string
  attrUsername: string
  attrName: string
  attrEmail: string
  source: 'database' | 'env'
  passwordSet: boolean
  bindDnSet: boolean
}

/** 通用确认框（替代 Popconfirm）。 */
type ConfirmState = { title: string; content: string; okText?: string; danger?: boolean; run: () => Promise<void> }

const ConfirmModal = ({
  confirm,
  busy,
  onClose,
}: {
  confirm: ConfirmState
  busy: boolean
  onClose: () => void
}) => (
  <Modal
    open
    title={confirm.title}
    onClose={() => {
      if (!busy) onClose()
    }}
    footer={
      <>
        <Btn onClick={() => onClose()} disabled={busy}>
          取消
        </Btn>
        <Btn
          variant={confirm.danger ? 'danger' : 'primary'}
          loading={busy}
          onClick={() => {
            void confirm.run()
          }}
        >
          {confirm.okText ?? '确定'}
        </Btn>
      </>
    }
  >
    <p className="m-0">{confirm.content}</p>
  </Modal>
)

const RoleTag = ({ role }: { role: Role }) =>
  role === 'admin' ? <Tag color="blue">管理员</Tag> : <Tag>普通用户</Tag>

const ProviderTag = ({ provider }: { provider: string }) =>
  provider === 'ldap' ? <Tag color="gray">LDAP</Tag> : <Tag>本地</Tag>

const ROLE_OPTIONS = [
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '管理员' },
]

/* ============================== 团队 Tab ============================== */

const TeamsPanel = () => {
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Team | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [detailTeam, setDetailTeam] = useState<Team | null>(null)
  const [addUserId, setAddUserId] = useState('')
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  const { data: teams, loading, error, refresh } = useRequest(async () => {
    const { error: err, data, response } = await client.get('/api/v1/teams')
    if (err || !data) {
      if (response?.status === 403) throw new Error('no-perm')
      throw new Error('加载失败')
    }
    return data as Team[]
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

  const doCreate = async () => {
    const name = createName.trim()
    if (!name) {
      setCreateError('请输入团队名称')
      return
    }
    setCreating(true)
    const res = await client.post('/api/v1/teams', { body: { name } })
    setCreating(false)
    if (res.error) return
    msg.success(`团队 ${name} 已创建`)
    setCreateOpen(false)
    setCreateName('')
    setCreateError('')
    refresh()
  }

  const doRename = async () => {
    if (!renameTarget) return
    const name = renameValue.trim()
    if (!name) return
    setRenaming(true)
    const res = await client.patch('/api/v1/teams/{team_id}', {
      params: { team_id: renameTarget.id },
      body: { name },
    })
    setRenaming(false)
    if (res.error) return
    msg.success('团队已重命名')
    setRenameTarget(null)
    refresh()
  }

  const doDelete = (t: Team) => {
    setConfirm({
      title: `删除团队「${t.name}」？`,
      content: t.member_count > 0 ? '该团队仍有成员，无法删除' : '删除后不可恢复',
      okText: '删除',
      danger: true,
      run: async () => {
        const res = await client.delete('/api/v1/teams/{team_id}', {
          params: { team_id: t.id },
        })
        setConfirmBusy(false)
        setConfirm(null)
        if (res.error) return
        msg.success(`团队 ${t.name} 已删除`)
        refresh()
      },
    })
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
    setAddUserId('')
    refreshDetail()
    refresh()
  }

  const doRemoveMember = (u: User) => {
    if (!detailTeam) return
    setConfirm({
      title: `移除成员 ${u.username}？`,
      content: `将 ${u.username} 从团队「${detailTeam.name}」中移除。`,
      okText: '移除',
      danger: true,
      run: async () => {
        const res = await client.delete('/api/v1/teams/{team_id}/members/{user_id}', {
          params: { team_id: detailTeam.id, user_id: u.id },
        })
        setConfirmBusy(false)
        setConfirm(null)
        if (res.error) return
        msg.success(`已移除成员 ${u.username}`)
        refreshDetail()
        refresh()
      },
    })
  }

  const memberIds = new Set((detail?.members ?? []).map((m) => m.id))
  const addableUsers = (users ?? []).filter((u) => !memberIds.has(u.id))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>团队列表</div>
        <Btn variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          新建团队
        </Btn>
      </div>

      <div className="vd-table-wrap">
        <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} retry={refresh}>
          {loading ? (
            <div style={{ padding: 40 }}>
              <Spin />
            </div>
          ) : (teams ?? []).length === 0 ? (
            <div className="vd-empty">暂无团队</div>
          ) : (
            <table className="vd-table">
              <thead>
                <tr>
                  <th>团队名称</th>
                  <th style={{ width: 100 }}>成员数</th>
                  <th style={{ width: 160 }}>创建时间</th>
                  <th style={{ width: 170 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {teams?.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Btn size="xs" variant="ghost" onClick={() => setDetailTeam(t)}>
                        <Users size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                        {t.name}
                      </Btn>
                    </td>
                    <td>
                      <Tag color={t.member_count > 0 ? 'blue' : 'gray'}>{t.member_count}</Tag>
                    </td>
                    <td>{formatTime(t.created_at)}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        <Btn
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setRenameTarget(t)
                            setRenameValue(t.name)
                          }}
                        >
                          重命名
                        </Btn>
                        <Btn
                          size="xs"
                          variant="danger"
                          disabled={t.member_count > 0}
                          onClick={() => doDelete(t)}
                        >
                          删除
                        </Btn>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </StateView>
      </div>

      <Modal
        open={createOpen}
        title="新建团队"
        onClose={() => {
          setCreateOpen(false)
          setCreateError('')
        }}
        footer={
          <>
            <Btn
              onClick={() => {
                setCreateOpen(false)
                setCreateError('')
              }}
            >
              取消
            </Btn>
            <Btn variant="primary" loading={creating} onClick={() => void doCreate()}>
              创建
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="vd-field-label">团队名称</span>
          <Input
            placeholder="例如：研发团队"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doCreate()}
            autoFocus
          />
          {createError ? <span style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{createError}</span> : null}
        </div>
      </Modal>

      <Modal
        open={!!renameTarget}
        title={renameTarget ? `重命名团队 ${renameTarget.name}` : '重命名团队'}
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Btn onClick={() => setRenameTarget(null)}>取消</Btn>
            <Btn variant="primary" loading={renaming} disabled={!renameValue.trim()} onClick={() => void doRename()}>
              保存
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="vd-field-label">团队名称</span>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doRename()}
            autoFocus
          />
        </div>
      </Modal>

      <Drawer
        open={!!detailTeam}
        title={detail ? `团队 ${detail.team.name}` : '团队详情'}
        onClose={() => setDetailTeam(null)}
        width={520}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>成员（{detail?.team.member_count ?? 0}）</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Select
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value)}
                style={{ width: 200 }}
              >
                <option value="">选择用户添加</option>
                {addableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}（{u.display_name}）
                  </option>
                ))}
              </Select>
              <Btn variant="primary" size="sm" disabled={!addUserId} loading={adding} onClick={() => void doAddMember()}>
                <Plus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                添加成员
              </Btn>
            </div>
          </div>

          <div className="vd-table-wrap">
            {detailLoading ? (
              <div style={{ padding: 40 }}>
                <Spin />
              </div>
            ) : (detail?.members ?? []).length === 0 ? (
              <div className="vd-empty">暂无成员</div>
            ) : (
              <table className="vd-table">
                <thead>
                  <tr>
                    <th>用户名</th>
                    <th>显示名</th>
                    <th style={{ width: 90 }}>来源</th>
                    <th style={{ width: 100 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {detail?.members.map((m) => (
                    <tr key={m.id}>
                      <td>{m.username}</td>
                      <td>{m.display_name}</td>
                      <td>
                        <ProviderTag provider={m.auth_provider} />
                      </td>
                      <td>
                        <Btn size="xs" variant="danger" onClick={() => doRemoveMember(m)}>
                          移除
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Drawer>

      {confirm ? (
        <ConfirmModal
          confirm={confirm}
          busy={confirmBusy}
          onClose={() => {
            setConfirmBusy(false)
            setConfirm(null)
          }}
        />
      ) : null}
    </div>
  )
}

/* ============================== 用户 Tab ============================== */

const UsersPanel = () => {
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [cu, setCu] = useState({ username: '', display_name: '', password: '', role: 'user' as Role })
  const [createError, setCreateError] = useState<{ username?: string; password?: string }>({})

  const [editTarget, setEditTarget] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [eu, setEu] = useState({ display_name: '', role: 'user' as Role, disabled: false })
  const [editError, setEditError] = useState('')

  const [pwdTarget, setPwdTarget] = useState<User | null>(null)
  const [pwd, setPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const [pwdError, setPwdError] = useState('')

  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<LdapImportResult | null>(null)

  const { data: users, loading, error, refresh } = useRequest(async () => {
    const { error: err, data, response } = await client.get('/api/v1/users')
    if (err || !data) {
      if (response?.status === 403) throw new Error('no-perm')
      throw new Error('加载失败')
    }
    return data as User[]
  })

  // LDAP 服务端配置（导入弹窗内只读展示）
  const {
    data: ldapConfig,
    loading: ldapConfigLoading,
    error: ldapConfigError,
  } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/users/ldap/config')
      if (error || !data) throw new Error('LDAP 未配置')
      return data as LdapConfigInfo
    },
    { ready: importOpen },
  )

  const openCreate = () => {
    setCreateOpen(true)
    setCu({ username: '', display_name: '', password: '', role: 'user' })
    setCreateError({})
  }

  const doCreate = async () => {
    const errs: { username?: string; password?: string } = {}
    if (!cu.username.trim()) errs.username = '请输入用户名'
    if (!cu.password) errs.password = '请输入初始密码'
    else if (cu.password.length < 6) errs.password = '至少 6 位'
    setCreateError(errs)
    if (Object.keys(errs).length > 0) return
    setCreating(true)
    const body: { username: string; display_name?: string; password: string; role: Role } = {
      username: cu.username.trim(),
      password: cu.password,
      role: cu.role,
    }
    if (cu.display_name.trim()) body.display_name = cu.display_name.trim()
    const res = await client.post('/api/v1/users', { body })
    setCreating(false)
    if (res.error) return
    msg.success(`用户 ${body.username} 已创建`)
    setCreateOpen(false)
    refresh()
  }

  const openEdit = (u: User) => {
    setEditTarget(u)
    setEu({ display_name: u.display_name, role: u.role, disabled: u.disabled })
    setEditError('')
  }

  const doSaveEdit = async () => {
    if (!editTarget) return
    if (!eu.display_name.trim()) {
      setEditError('请输入显示名')
      return
    }
    setSaving(true)
    const res = await client.patch('/api/v1/users/{id}', {
      params: { id: editTarget.id },
      body: { display_name: eu.display_name.trim(), role: eu.role, disabled: eu.disabled },
    })
    setSaving(false)
    if (res.error) return
    msg.success('用户已更新')
    setEditTarget(null)
    refresh()
  }

  const openPwd = (u: User) => {
    setPwdTarget(u)
    setPwd('')
    setPwdError('')
  }

  const doResetPwd = async () => {
    if (!pwdTarget) return
    if (!pwd) {
      setPwdError('请输入新密码')
      return
    }
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
    setImportResult(res.data as LdapImportResult)
    refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>用户列表</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn size="sm" onClick={() => setImportOpen(true)}>
            <CloudUpload size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            LDAP 导入
          </Btn>
          <Btn variant="primary" size="sm" onClick={openCreate}>
            <Plus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            新建用户
          </Btn>
        </div>
      </div>

      <div className="vd-table-wrap">
        <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} retry={refresh}>
          {loading ? (
            <div style={{ padding: 40 }}>
              <Spin />
            </div>
          ) : (users ?? []).length === 0 ? (
            <div className="vd-empty">暂无用户</div>
          ) : (
            <table className="vd-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>显示名</th>
                  <th style={{ width: 90 }}>来源</th>
                  <th style={{ width: 90 }}>角色</th>
                  <th style={{ width: 90 }}>状态</th>
                  <th style={{ width: 160 }}>创建时间</th>
                  <th style={{ width: 280 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {users?.map((u) => (
                  <tr key={u.id}>
                    <td>{u.username}</td>
                    <td>{u.display_name}</td>
                    <td>
                      <ProviderTag provider={u.auth_provider} />
                    </td>
                    <td>
                      <RoleTag role={u.role} />
                    </td>
                    <td>{u.disabled ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>}</td>
                    <td>{formatTime(u.created_at)}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        <Btn size="xs" variant="ghost" onClick={() => openEdit(u)}>
                          编辑
                        </Btn>
                        {u.auth_provider === 'local' ? (
                          <Btn size="xs" variant="ghost" onClick={() => openPwd(u)}>
                            <KeyRound size={12} style={{ verticalAlign: '-2px', marginRight: 3 }} />
                            重置密码
                          </Btn>
                        ) : null}
                        <Btn size="xs" variant={u.disabled ? 'danger' : 'ghost'} onClick={() => openEdit(u)}>
                          {u.disabled ? '启用' : '禁用'}
                        </Btn>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </StateView>
      </div>

      {/* 新建用户 */}
      <Modal
        open={createOpen}
        title="新建用户"
        onClose={() => {
          setCreateOpen(false)
          setCreateError({})
        }}
        footer={
          <>
            <Btn
              onClick={() => {
                setCreateOpen(false)
                setCreateError({})
              }}
            >
              取消
            </Btn>
            <Btn variant="primary" loading={creating} onClick={() => void doCreate()}>
              创建
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="vd-field-label">用户名</span>
            <Input
              placeholder="登录用户名"
              value={cu.username}
              onChange={(e) => setCu((s) => ({ ...s, username: e.target.value }))}
              autoFocus
            />
            {createError.username ? (
              <span style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{createError.username}</span>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="vd-field-label">显示名</span>
            <Input
              placeholder="可选，默认同用户名"
              value={cu.display_name}
              onChange={(e) => setCu((s) => ({ ...s, display_name: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="vd-field-label">初始密码</span>
            <Input
              type="password"
              placeholder="至少 6 位"
              autoComplete="new-password"
              value={cu.password}
              onChange={(e) => setCu((s) => ({ ...s, password: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && void doCreate()}
            />
            {createError.password ? (
              <span style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{createError.password}</span>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="vd-field-label">角色</span>
            <Select
              value={cu.role}
              onChange={(e) => setCu((s) => ({ ...s, role: e.target.value as Role }))}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Modal>

      {/* 编辑用户 */}
      <Modal
        open={!!editTarget}
        title={editTarget ? `编辑用户 ${editTarget.username}` : '编辑用户'}
        onClose={() => setEditTarget(null)}
        footer={
          <>
            <Btn onClick={() => setEditTarget(null)}>取消</Btn>
            <Btn variant="primary" loading={saving} onClick={() => void doSaveEdit()}>
              保存
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="vd-field-label">显示名</span>
            <Input
              value={eu.display_name}
              onChange={(e) => setEu((s) => ({ ...s, display_name: e.target.value }))}
              autoFocus
            />
            {editError ? <span style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{editError}</span> : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="vd-field-label">角色</span>
            <Select
              value={eu.role}
              onChange={(e) => setEu((s) => ({ ...s, role: e.target.value as Role }))}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span className="vd-field-label">状态</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--vd-text-secondary)' }}>
                {eu.disabled ? '已禁用' : '启用中'}
              </span>
              <Switch checked={!eu.disabled} onChange={(v) => setEu((s) => ({ ...s, disabled: !v }))} />
            </div>
          </div>
        </div>
      </Modal>

      {/* 重置密码 */}
      <Modal
        open={!!pwdTarget}
        title={pwdTarget ? `重置密码 · ${pwdTarget.username}` : '重置密码'}
        onClose={() => {
          setPwdTarget(null)
          setPwd('')
        }}
        footer={
          <>
            <Btn
              onClick={() => {
                setPwdTarget(null)
                setPwd('')
              }}
            >
              取消
            </Btn>
            <Btn variant="primary" loading={pwdSaving} onClick={() => void doResetPwd()}>
              重置
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="vd-field-label">新密码</span>
          <Input
            type="password"
            placeholder="至少 6 位"
            autoComplete="new-password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doResetPwd()}
            autoFocus
          />
          {pwdError ? <span style={{ fontSize: 12, color: 'var(--vd-accent-danger)' }}>{pwdError}</span> : null}
        </div>
      </Modal>

      {/* LDAP 导入 */}
      <Modal
        open={importOpen}
        title="LDAP 导入"
        onClose={() => setImportOpen(false)}
        width={560}
        footer={
          <>
            <Btn onClick={() => setImportOpen(false)}>关闭</Btn>
            <Btn
              variant="primary"
              loading={importing}
              disabled={ldapConfigLoading || !!ldapConfigError}
              onClick={() => void doImport()}
            >
              <CloudUpload size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              从 LDAP 导入
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ldapConfigError ? (
            <div className="vd-alert vd-alert-warning">
              <div style={{ fontWeight: 600 }}>LDAP 未配置</div>
              <div style={{ fontSize: 12 }}>
                请在「系统设置 → 账户与安全」中在线配置，或设置 VIENTO_LDAP_HOST 等环境变量并重启服务后重试。
              </div>
            </div>
          ) : ldapConfigLoading || !ldapConfig ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : (
            <div
              style={{
                border: '1px solid var(--vd-border-subtle)',
                borderRadius: 8,
                overflow: 'hidden',
                fontSize: 13,
              }}
            >
              {(
                [
                  ['服务器地址', `${ldapConfig.host}:${ldapConfig.port}${ldapConfig.startTls ? '（StartTLS）' : ''}`],
                  ['Base DN', ldapConfig.baseDn],
                  ['用户过滤器', ldapConfig.userFilter],
                  ['字段映射', `用户名=${ldapConfig.attrUsername} · 显示名=${ldapConfig.attrName} · 邮箱=${ldapConfig.attrEmail}`],
                ] as [string, string][]
              ).map(([k, v], i) => (
                <div
                  key={k}
                  style={{
                    display: 'flex',
                    borderBottom: i < 3 ? '1px solid var(--vd-border-subtle)' : 'none',
                  }}
                >
                  <div style={{ width: 110, flexShrink: 0, padding: '8px 10px', background: 'var(--vd-bg-overlay)', color: 'var(--vd-text-secondary)' }}>
                    {k}
                  </div>
                  <div style={{ flex: 1, padding: '8px 10px', wordBreak: 'break-all' }}>{v}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--vd-text-tertiary)' }}>
            按上述配置从 LDAP 同步用户：已存在的用户名将跳过并同步显示名/邮箱；导入的用户角色为普通用户。
            不在系统内修改 LDAP 密码；LDAP 侧删除不联动删除本地用户。
          </div>
        </div>
      </Modal>

      {/* 导入结果 */}
      <Modal
        open={!!importResult}
        title="导入结果"
        onClose={() => {
          setImportResult(null)
          setImportOpen(false)
        }}
        footer={
          <Btn
            variant="primary"
            onClick={() => {
              setImportResult(null)
              setImportOpen(false)
            }}
          >
            完成
          </Btn>
        }
      >
        {importResult ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div>
              成功创建 <span style={{ fontWeight: 600 }}>{importResult.created}</span> 个用户
            </div>
            <div>
              跳过（已存在） <span style={{ fontWeight: 600 }}>{importResult.skipped}</span> 个
            </div>
            <div>
              失败 <span style={{ fontWeight: 600 }}>{importResult.failed.length}</span> 个
              {importResult.failed.length > 0 ? (
                <ul style={{ margin: '4px 0 0', paddingLeft: 16, color: 'var(--vd-accent-danger)' }}>
                  {importResult.failed.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

/* ============================== 页面（团队 | 用户） ============================== */

/** 团队管理：团队 CRUD、成员增删 + 用户管理（合并）；均仅管理员可见。 */
const TeamsPage = () => {
  const { user } = useAuth()
  const me = user!
  const [tab, setTab] = useState('teams')

  if (me.role !== 'admin') {
    return <StateView state="noPerm">{null}</StateView>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
      <Tabs
        items={[
          { key: 'teams', label: '团队' },
          { key: 'users', label: '用户' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'teams' ? <TeamsPanel /> : <UsersPanel />}
    </div>
  )
}

export default TeamsPage
