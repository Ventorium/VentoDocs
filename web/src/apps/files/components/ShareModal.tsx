import { useState } from 'react'
import { useRequest } from 'ahooks'
import { Copy, Link, Trash2 } from 'lucide-react'
import { client } from '@/api'
import type { Share, ShareCreateReq, ShareResourceType } from '@/api/schema'
import { Btn, Empty, IconBtn, Input, Modal, Select, Spin, Switch, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
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
}

const EMPTY_FORM: NewShareForm = {
  password: '',
  expires_in_days: 7,
  max_downloads: null,
  preview_only: false,
}

/** 分享管理弹窗：创建链接（密码 / 有效期 / 下载上限 / 仅预览）+ 已有分享列表（状态 / 撤销 / 复制链接）。 */
const ShareModal = ({ open, resourceType, resourceId, resourceName, onClose }: ShareModalProps) => {
  const [form, setForm] = useState<NewShareForm>(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<Share | null>(null)

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

  const doCreate = async () => {
    setCreating(true)
    const body: ShareCreateReq = {
      resource_type: resourceType,
      resource_id: resourceId,
      expires_in_days: form.expires_in_days,
    }
    if (form.password) body.password = form.password
    if (form.max_downloads != null && form.max_downloads >= 1) body.max_downloads = form.max_downloads
    if (form.preview_only) body.preview_only = true
    const { error } = await client.post('/api/v1/shares', { body })
    setCreating(false)
    if (error) return
    msg.success('分享链接已创建')
    setForm(EMPTY_FORM)
    refresh()
  }

  const doRevoke = async (id: string) => {
    const { error } = await client.post('/api/v1/shares/{id}/revoke', { params: { id } })
    if (error) return
    msg.success('分享已撤销')
    setRevoking(null)
    refresh()
  }

  const shareUrl = (token: string) => `${window.location.origin}/s/${token}`

  const copyUrl = (token: string) => {
    void navigator.clipboard.writeText(shareUrl(token)).then(() => msg.success('链接已复制'))
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
      <Modal open={open} title={`分享「${resourceName}」`} width={720} onClose={onClose}>
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
                      <th style={{ width: 90 }}>状态</th>
                      <th style={{ width: 80 }}>密码</th>
                      <th style={{ width: 140 }}>有效期</th>
                      <th style={{ width: 120 }}>访问 / 下载</th>
                      <th style={{ width: 140 }}>创建时间</th>
                      <th style={{ width: 140 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shares.map((r) => (
                      <tr key={r.id}>
                        <td>{shareStatus(r)}</td>
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
                              <IconBtn small title="复制链接" onClick={() => copyUrl(r.token)}>
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
            <Btn variant="danger" onClick={() => revoking && void doRevoke(revoking.id)}>撤销</Btn>
          </>
        }
      >
        <p className="m-0">撤销后链接立即失效，且不可恢复。</p>
      </Modal>
    </>
  )
}

export default ShareModal
