import { useState } from 'react'
import { useRequest } from 'ahooks'
import { Copy, Link, Trash2 } from 'lucide-react'
import { client } from '@/api'
import type { Share, ShareCreateReq, ShareResourceType, ShareSystemSettings } from '@/api/schema'
import { Btn, Empty, IconBtn, Input, Modal, Seg, Select, Spin, Switch, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { copyText } from '@/lib/clipboard'
import { formatTime } from '@/lib/format'

type ShareModalProps = {
  open: boolean
  resourceType: ShareResourceType
  resourceId: string
  resourceName: string
  onClose: () => void
}

/** 有效期选项；null = 永久有效（后端省略字段 = 默认 7 天，此处显式发送）。 */
const EXPIRE_OPTIONS = [
  { value: '7', label: '7 天（默认）' },
  { value: '1', label: '1 天' },
  { value: '30', label: '30 天' },
  { value: '365', label: '1 年' },
  { value: '', label: '永久有效' },
]

type NewShareForm = {
  password: string
  expires_in_days: number | null
  max_downloads: number | null
  preview_only: boolean
  scope: 'internal' | 'external'
}

const EMPTY_FORM: NewShareForm = {
  password: '',
  expires_in_days: 7,
  max_downloads: null,
  preview_only: false,
  scope: 'internal',
}

/** M2.24：外网域名归一化（未写协议头时默认 https）。 */
const normalizeExternalBase = (domain: string) =>
  domain.includes('://') ? domain : `https://${domain}`

/** 分享管理弹窗：创建链接（密码 / 有效期 / 下载上限 / 仅预览）+ 已有分享列表（状态 / 撤销 / 复制链接）。 */
const ShareModal = ({ open, resourceType, resourceId, resourceName, onClose }: ShareModalProps) => {
  const [form, setForm] = useState<NewShareForm>(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<Share | null>(null)
  const [revokingBusy, setRevokingBusy] = useState(false)

  const { data: shares = [], loading, refresh } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/shares', {
        query: { resource_type: resourceType, resource_id: resourceId },
      })
      if (error || !data) throw new Error('加载失败')
      return data.shares
    },
    { refreshDeps: [open, resourceType, resourceId], ready: open },
  )

  // M2.24：分享系统设置（分享端口 / 外网域名），用于计算内网 / 外网双链接。
  const { data: shareCfg } = useRequest(async () => {
    const { error, data } = await client.get('/api/v1/settings/system/share')
    if (error || !data) throw new Error('加载失败')
    return data
  }, { refreshDeps: [open], ready: open })

  // M2.24：内网链接 = 当前主机名 + 分享端口；外网链接 = 管理端配置的外网域名。
  const host = window.location.hostname || '127.0.0.1'
  // 内网链接用「实际绑定端口」（active_port），改端口重启前也能给出可用链接
  const internalUrl = (token: string) => `http://${host}:${shareCfg?.active_port ?? 8090}/s/${token}`
  const externalUrl = (token: string) =>
    shareCfg?.external_enabled && shareCfg.external_domain
      ? `${normalizeExternalBase(shareCfg.external_domain)}/s/${token}`
      : null
  /** 按 scope 取链接；外网未启用时回退内网链接。 */
  const primaryUrl = (token: string, scope: 'internal' | 'external' = 'internal') =>
    scope === 'external' ? (externalUrl(token) ?? internalUrl(token)) : internalUrl(token)

  const doCreate = async () => {
    setCreating(true)
    // 外网未启用时强制内网（与后端校验一致）。
    const scope: 'internal' | 'external' =
      shareCfg?.external_enabled && form.scope === 'external' ? 'external' : 'internal'
    const body: ShareCreateReq = {
      resource_type: resourceType,
      resource_id: resourceId,
      expires_in_days: form.expires_in_days,
      scope,
    }
    if (form.password) body.password = form.password
    if (form.max_downloads != null && form.max_downloads >= 1) body.max_downloads = form.max_downloads
    if (form.preview_only) body.preview_only = true
    const { error, data } = await client.post('/api/v1/shares', { body })
    setCreating(false)
    if (error || !data) return
    // M2.24：自动复制新链接；仅当真实复制成功才提示「已复制」。
    const ok = await copyText(primaryUrl(data.share.token, scope))
    msg.success(
      ok
        ? scope === 'external'
          ? '外网链接已创建并复制'
          : '内网链接已创建并复制'
        : '分享链接已创建，请点击行内复制图标手动复制',
    )
    setForm(EMPTY_FORM)
    refresh()
  }

  const doRevoke = async (id: string) => {
    if (revokingBusy) return
    setRevokingBusy(true)
    const { error } = await client.post('/api/v1/shares/{id}/revoke', { params: { id } })
    setRevokingBusy(false)
    if (error) return
    msg.success('分享已撤销')
    setRevoking(null)
    refresh()
  }

  // M2.23：navigator.clipboard 可能不可用（WebView/非安全上下文）→ 统一走带回退的 copyText
  const copyUrl = (token: string, scope: 'internal' | 'external' = 'internal') => {
    void copyText(primaryUrl(token, scope)).then((ok) => {
      if (ok) msg.success('链接已复制')
      else msg.error('复制失败，请手动复制')
    })
  }

  /** 状态优先级：已撤销 > 已过期 > 有效。 */
  const shareStatus = (s: Share) => {
    if (s.revoked) return <Tag>已撤销</Tag>
    if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
      return <Tag color="red">已过期</Tag>
    }
    return <Tag color="green">有效</Tag>
  }

  const label = (w: number) => ({ width: w, flexShrink: 0, fontSize: 13, color: 'var(--vd-text-secondary)' })

  return (
    <>
      <Modal open={open} title={`分享「${resourceName}」`} width={920} onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ borderRadius: 8, border: '1px solid var(--vd-border-subtle)', padding: 12 }}>
            <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 600 }}>创建分享链接</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={label(88)}>访问密码</span>
                <Input
                  type="password"
                  placeholder="留空表示无密码，任何人打开即可访问"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  style={{ flex: 1 }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={label(88)}>链接范围</span>
                {shareCfg?.external_enabled ? (
                  <Seg
                    value={form.scope}
                    onChange={(v) => setForm((f) => ({ ...f, scope: v as 'internal' | 'external' }))}
                    options={[
                      { key: 'internal', label: '内网' },
                      { key: 'external', label: '外网' },
                    ]}
                  />
                ) : (
                  <span className="vd-faint" style={{ fontSize: 12 }}>
                    仅内网（管理员尚未启用外网域名）
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={label(88)}>有效期</span>
                <Select
                  value={String(form.expires_in_days ?? '')}
                  onChange={(e) => {
                    const v = e.target.value
                    setForm((f) => ({ ...f, expires_in_days: v === '' ? null : Number(v) }))
                  }}
                  style={{ width: 180 }}
                >
                  {EXPIRE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={label(88)}>下载上限</span>
                <Input
                  type="number"
                  min={1}
                  placeholder="留空表示不限"
                  value={form.max_downloads ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    setForm((f) => ({ ...f, max_downloads: v === '' ? null : Math.max(1, Number(v)) }))
                  }}
                  style={{ width: 180 }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={label(88)}>仅预览</span>
                <Switch
                  checked={form.preview_only}
                  onChange={(v) => setForm((f) => ({ ...f, preview_only: v }))}
                />
                <span className="vd-faint" style={{ fontSize: 12 }}>
                  开启后访问者只能在线预览，无法下载
                </span>
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
              <Btn variant="primary" loading={creating} onClick={() => void doCreate()}>
                <Link size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                创建链接
              </Btn>
            </div>
          </div>

          <div>
            <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 600 }}>已有分享（{shares.length}）</div>
            <div
              className="vd-table-wrap"
              style={{ maxHeight: 280, border: '1px solid var(--vd-border-subtle)', borderRadius: 8 }}
            >
              {loading ? (
                <div className="vd-flex-center" style={{ height: 160 }}>
                  <Spin />
                </div>
              ) : shares.length === 0 ? (
                <Empty text="暂无分享链接" />
              ) : (
                <table className="vd-table">
                  <thead>
                    <tr>
                      <th style={{ width: 56 }}>状态</th>
                      <th style={{ width: 230 }}>链接</th>
                      <th style={{ width: 52 }}>密码</th>
                      <th style={{ width: 104 }}>有效期</th>
                      <th style={{ width: 104 }}>访问 / 下载</th>
                      <th style={{ width: 104 }}>创建时间</th>
                      <th style={{ width: 88 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shares.map((r) => (
                      <tr key={r.id}>
                        <td>{shareStatus(r)}</td>
                        <td>
                          {/* M2.25：只展示本分享 scope 的链接（内网分享不再附带外网地址），过长时省略号截断，悬停 title 显示完整 URL */}
                          <span
                            title={primaryUrl(r.token, r.scope)}
                            style={{
                              display: 'block',
                              maxWidth: 230,
                              fontSize: 12,
                              fontFamily: 'monospace',
                              color: r.revoked ? 'var(--vd-text-tertiary)' : 'var(--vd-accent)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {r.scope === 'external' ? '外网：' : '内网：'}{primaryUrl(r.token, r.scope)}
                          </span>
                        </td>
                        <td>{r.has_password ? '已设置' : '—'}</td>
                        <td>{r.expires_at ? formatTime(r.expires_at) : '永久'}</td>
                        <td>
                          {r.access_count} / {r.download_count}
                          {r.max_downloads ? `（限 ${r.max_downloads}）` : ''}
                        </td>
                        <td>{formatTime(r.created_at)}</td>
                        <td>
                          {r.revoked ? (
                            <span className="vd-faint" style={{ fontSize: 12 }}>已失效</span>
                          ) : (
                            <span style={{ display: 'inline-flex', gap: 2 }}>
                              <IconBtn small title="复制链接" onClick={() => copyUrl(r.token, r.scope)}>
                                <Copy size={14} />
                              </IconBtn>
                              <IconBtn small danger title="撤销该分享" onClick={() => setRevoking(r)}>
                                <Trash2 size={14} />
                              </IconBtn>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!revoking}
        title="撤销该分享？"
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Btn onClick={() => setRevoking(null)}>取消</Btn>
            <Btn variant="danger" loading={revokingBusy} onClick={() => revoking && void doRevoke(revoking.id)}>撤销</Btn>
          </>
        }
      >
        <p className="m-0">撤销后链接立即失效，且不可恢复。</p>
      </Modal>
    </>
  )
}

export default ShareModal
