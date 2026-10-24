import { useEffect, useState } from 'react'
import { useRequest } from 'ahooks'
import { Alert, Button, Descriptions, Modal, Radio, Space, Spin, Tag } from 'antd'
import { CopyOutlined, GlobalOutlined } from '@ant-design/icons'
import { client } from '@/api'
import type { PublishPolicy, PublishedDir } from '@/api/schema'
import { getConfig } from '@/store/config'
import { msg } from '@/components/GlobalMessage'
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

  const copyUrl = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => msg.success('地址已复制'))
  }

  return (
    <Modal
      open={open}
      title={`发布为网站「${dirName}」`}
      width={640}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <Spin spinning={loading || !data}>
        <div className="flex flex-col gap-16px">
          {!canEnable && (
            <Alert
              type="warning"
              showIcon
              message="管理员未配置发布域名（VIENTO_PUBLISH_DOMAIN）"
              description="配置环境变量并重启服务后，才能将目录发布为公开网站。"
            />
          )}

          {!publish ? (
            <div>
              <Alert
                type="info"
                showIcon
                message="该目录尚未发布"
                description="发布后，目录及其子内容将以独立网站形式对外展示。"
                style={{ marginBottom: 12 }}
              />
              <div className="flex flex-col gap-8px">
                <div className="text-13px font-600">访问策略</div>
                <Radio.Group
                  value={policy}
                  onChange={(e) => setPolicy(e.target.value as PublishPolicy)}
                  className="flex flex-col gap-8px"
                >
                  {POLICY_OPTIONS.map((o) => (
                    <Radio key={o.value} value={o.value}>
                      <span className="font-600">{o.label}</span>
                      <span className="ml-8px text-12px text-#9CA3AF">{o.desc}</span>
                    </Radio>
                  ))}
                </Radio.Group>
              </div>
              <div className="mt-12px flex justify-end">
                <Button
                  type="primary"
                  icon={<GlobalOutlined />}
                  loading={submitting}
                  disabled={!canEnable}
                  onClick={doEnable}
                >
                  启用发布
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-12px">
              <div className="flex items-center gap-8px">
                <span className="text-13px font-600">发布状态</span>
                {publish.enabled ? (
                  <Tag color="success">已启用</Tag>
                ) : (
                  <Tag color="default">已停用</Tag>
                )}
              </div>
              <Descriptions
                column={1}
                size="small"
                bordered
                items={[
                  {
                    key: 'pid',
                    label: '站点标识',
                    children: (
                      <Space>
                        <code className="text-13px">{publish.publish_id}</code>
                        <Button
                          type="text"
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(publish.publish_id)
                              .then(() => msg.success('标识已复制'))
                          }
                        />
                      </Space>
                    ),
                  },
                  {
                    key: 'url',
                    label: '站点地址',
                    children: siteUrl ? (
                      <Space>
                        <span className="text-13px">{siteUrl}</span>
                        <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyUrl(siteUrl)} />
                      </Space>
                    ) : (
                      <span className="text-12px text-#9CA3AF">
                        未配置发布域名，站点标识：{publish.publish_id}
                      </span>
                    ),
                  },
                  {
                    key: 'policy',
                    label: '访问策略',
                    children: (
                      <Radio.Group
                        value={policy}
                        onChange={(e) => setPolicy(e.target.value as PublishPolicy)}
                        disabled={!publish.enabled}
                      >
                        {POLICY_OPTIONS.map((o) => (
                          <Radio key={o.value} value={o.value}>
                            {o.label}
                          </Radio>
                        ))}
                      </Radio.Group>
                    ),
                  },
                  {
                    key: 'updated',
                    label: '更新时间',
                    children: formatTime(publish.updated_at),
                  },
                ]}
              />
              <div className="flex justify-end gap-8px">
                <Button
                  danger
                  loading={submitting}
                  disabled={!publish.enabled}
                  onClick={doDisable}
                >
                  停用站点
                </Button>
                {publish.enabled && (
                  <Button
                    type="primary"
                    loading={submitting}
                    disabled={!canEnable || policy === publish.policy}
                    onClick={doEnable}
                  >
                    更新策略
                  </Button>
                )}
                {!publish.enabled && (
                  <Button
                    type="primary"
                    loading={submitting}
                    disabled={!canEnable}
                    onClick={doEnable}
                  >
                    重新启用
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </Spin>
    </Modal>
  )
}

export default PublishModal
