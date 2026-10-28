import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useRequest } from 'ahooks'
import { Copy, Globe } from 'lucide-react'
import { client } from '@/api'
import type { PublishPolicy, PublishedDir } from '@/api/schema'
import { getConfig } from '@/store/config'
import { Btn, IconBtn, Modal, Spin, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { formatTime } from '@/lib/format'

type PublishModalProps = {
  open: boolean
  dirId: string
  dirName: string
  onClose: () => void
}

const POLICY_OPTIONS: { value: PublishPolicy; label: string; desc: string }[] = [
  { value: 'anon', label: '公开访问', desc: '任何访问者均可浏览' },
  { value: 'login', label: '需登录', desc: '仅已登录用户可访问' },
  { value: 'preview_only', label: '仅预览', desc: '可在线预览，禁止下载' },
]

/** 目录网站发布弹窗：开关 + 访问策略 + 16 位站点标识 / 完整地址。 */
const PublishModal = ({ open, dirId, dirName, onClose }: PublishModalProps) => {
  const [policy, setPolicy] = useState<PublishPolicy>('anon')
  const [submitting, setSubmitting] = useState(false)

  const publishDomain = getConfig().publishDomain

  const { data, loading, refresh } = useRequest(
    async () => {
      const { error, data } = await client.get('/api/v1/directories/{id}/publish', {
        params: { id: dirId },
      })
      if (error || !data) throw new Error('加载失败')
      return data
    },
    { refreshDeps: [open, dirId], ready: open },
  )

  const publish: PublishedDir | null = data?.publish ?? null
  const canEnable = publishDomain != null

  // 载入已有发布状态时，同步当前策略到表单
  useEffect(() => {
    if (publish) setPolicy(publish.policy)
  }, [publish])

  const doEnable = async () => {
    setSubmitting(true)
    const { error } = await client.post('/api/v1/directories/{id}/publish', {
      params: { id: dirId },
      body: { policy },
    })
    setSubmitting(false)
    if (error) return
    msg.success(publish ? '发布策略已更新' : '目录已发布为网站')
    refresh()
  }

  const doDisable = async () => {
    setSubmitting(true)
    const { error } = await client.delete('/api/v1/directories/{id}/publish', {
      params: { id: dirId },
    })
    setSubmitting(false)
    if (error) return
    msg.success('站点已下线')
    refresh()
  }

  const siteUrl = data?.url ?? null

  const copyUrl = (text: string, okMsg: string) => {
    void navigator.clipboard.writeText(text).then(() => msg.success(okMsg))
  }

  const policyRadios = (disabled: boolean) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {POLICY_OPTIONS.map((o) => (
        <label key={o.value} className="vd-radio" style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : undefined }}>
          <input
            type="radio"
            name="publish-policy"
            checked={policy === o.value}
            onChange={() => setPolicy(o.value)}
          />
          <span style={{ fontWeight: 600 }}>{o.label}</span>
          <span className="vd-faint" style={{ fontSize: 12 }}>{o.desc}</span>
        </label>
      ))}
    </div>
  )

  const descRow = (labelText: string, children: ReactNode) => (
    <div
      style={{
        display: 'flex',
        borderBottom: '1px solid var(--vd-border-subtle)',
        padding: '8px 10px',
        fontSize: 13,
      }}
    >
      <div style={{ width: 96, flexShrink: 0, color: 'var(--vd-text-tertiary)', fontSize: 12.5 }}>{labelText}</div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>{children}</div>
    </div>
  )

  return (
    <Modal open={open} title={`发布为网站「${dirName}」`} width={640} onClose={onClose}>
      {loading || !data ? (
              <Spin large text="加载发布状态…" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {!canEnable ? (
                  <div className="vd-alert vd-alert-warning">
                    <Globe size={14} style={{ marginTop: 3, flexShrink: 0 }} />
                    <div>
                      <div style={{ fontWeight: 600 }}>管理员未配置发布域名（VIENTO_PUBLISH_DOMAIN）</div>
                      <div style={{ fontSize: 12 }}>配置环境变量并重启服务后，才能将目录发布为公开网站。</div>
                    </div>
                  </div>
                ) : null}

                {!publish ? (
                  <div>
                    <div className="vd-alert vd-alert-info" style={{ marginBottom: 12 }}>
                      <Globe size={14} style={{ marginTop: 3, flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 600 }}>该目录尚未发布</div>
                        <div style={{ fontSize: 12 }}>发布后，目录及其子内容将以独立网站形式对外展示。</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>访问策略</div>
                      {policyRadios(false)}
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                      <Btn variant="primary" loading={submitting} disabled={!canEnable} onClick={() => void doEnable()}>
                        <Globe size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                        启用发布
                      </Btn>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>发布状态</span>
                      {publish.enabled ? <Tag color="green">已启用</Tag> : <Tag>已停用</Tag>}
                    </div>
                    <div style={{ border: '1px solid var(--vd-border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
                      {descRow('站点标识', (
                        <>
                          <code style={{ fontSize: 13 }}>{publish.publish_id}</code>
                          <IconBtn small title="复制标识" onClick={() => copyUrl(publish.publish_id, '标识已复制')}>
                            <Copy size={13} />
                          </IconBtn>
                        </>
                      ))}
                      {descRow('站点地址', siteUrl ? (
                        <>
                          <span style={{ fontSize: 13 }}>{siteUrl}</span>
                          <IconBtn small title="复制地址" onClick={() => copyUrl(siteUrl, '地址已复制')}>
                            <Copy size={13} />
                          </IconBtn>
                        </>
                      ) : (
                        <span className="vd-faint" style={{ fontSize: 12 }}>
                          未配置发布域名，站点标识：{publish.publish_id}
                        </span>
                      ))}
                      {descRow('访问策略', policyRadios(!publish.enabled))}
                      {descRow('更新时间', <span>{formatTime(publish.updated_at)}</span>)}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <Btn variant="danger" loading={submitting} disabled={!publish.enabled} onClick={() => void doDisable()}>
                        停用站点
                      </Btn>
                      {publish.enabled ? (
                        <Btn
                          variant="primary"
                          loading={submitting}
                          disabled={!canEnable || policy === publish.policy}
                          onClick={() => void doEnable()}
                        >
                          更新策略
                        </Btn>
                      ) : null}
                      {!publish.enabled ? (
                        <Btn variant="primary" loading={submitting} disabled={!canEnable} onClick={() => void doEnable()}>
                          重新启用
                        </Btn>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            )}
    </Modal>
  )
}

export default PublishModal
