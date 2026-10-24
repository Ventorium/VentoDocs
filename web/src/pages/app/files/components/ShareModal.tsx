import { useState } from 'react'
import { useRequest } from 'ahooks'
import {
  Button,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
} from 'antd'
import { LinkOutlined, CopyOutlined } from '@ant-design/icons'
import { client } from '@/api'
import type { Share, ShareCreateReq, ShareResourceType } from '@/api/schema'
import { msg } from '@/components/GlobalMessage'
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
  { value: 7, label: '7 天（默认）' },
  { value: 1, label: '1 天' },
  { value: 30, label: '30 天' },
  { value: 365, label: '1 年' },
  { value: null, label: '永久有效' },
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
    refresh()
  }

  const shareUrl = (token: string) => `${window.location.origin}/s/${token}`

  const copyUrl = (token: string) => {
    void navigator.clipboard.writeText(shareUrl(token)).then(() => msg.success('链接已复制'))
  }

  /** 状态优先级：已撤销 > 已过期 > 有效。 */
  const shareStatus = (s: Share) => {
    if (s.revoked) return <Tag color="default">已撤销</Tag>
    if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
      return <Tag color="warning">已过期</Tag>
    }
    return <Tag color="success">有效</Tag>
  }

  return (
    <Modal
      open={open}
      title={`分享「${resourceName}」`}
      width={720}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <div className="flex flex-col gap-16px">
        <div className="rounded-8px border-1px border-#E5E7EB p-12px">
          <div className="mb-8px text-13px font-600">创建分享链接</div>
          <div className="flex flex-col gap-10px">
            <div className="flex items-center gap-8px">
              <span className="w-88px shrink-0 text-13px text-rgba(0,0,0,0.65)">访问密码</span>
              <Input.Password
                placeholder="留空表示无密码，任何人打开即可访问"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                style={{ flex: 1 }}
                allowClear
              />
            </div>
            <div className="flex items-center gap-8px">
              <span className="w-88px shrink-0 text-13px text-rgba(0,0,0,0.65)">有效期</span>
              <Select
                value={form.expires_in_days}
                options={EXPIRE_OPTIONS}
                onChange={(v: number | null) => setForm((f) => ({ ...f, expires_in_days: v }))}
                style={{ width: 180 }}
              />
            </div>
            <div className="flex items-center gap-8px">
              <span className="w-88px shrink-0 text-13px text-rgba(0,0,0,0.65)">下载上限</span>
              <InputNumber
                min={1}
                placeholder="留空表示不限"
                value={form.max_downloads}
                onChange={(v) => setForm((f) => ({ ...f, max_downloads: v }))}
                style={{ width: 180 }}
              />
            </div>
            <div className="flex items-center gap-8px">
              <span className="w-88px shrink-0 text-13px text-rgba(0,0,0,0.65)">仅预览</span>
              <Switch
                checked={form.preview_only}
                onChange={(v) => setForm((f) => ({ ...f, preview_only: v }))}
              />
              <span className="text-12px text-#9CA3AF">开启后访问者只能在线预览，无法下载</span>
            </div>
          </div>
          <div className="mt-10px flex justify-end">
            <Button type="primary" icon={<LinkOutlined />} loading={creating} onClick={doCreate}>
              创建链接
            </Button>
          </div>
        </div>

        <div>
          <div className="mb-8px text-13px font-600">已有分享（{shares.length}）</div>
          <Table<Share>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={shares}
            pagination={false}
            scroll={{ y: 260 }}
            columns={[
              { title: '状态', key: 'status', width: 90, render: (_, r) => shareStatus(r) },
              {
                title: '密码',
                key: 'pwd',
                width: 80,
                render: (_, r) => (r.has_password ? '已设置' : '—'),
              },
              {
                title: '有效期',
                key: 'exp',
                width: 140,
                render: (_, r) => (r.expires_at ? formatTime(r.expires_at) : '永久'),
              },
              {
                title: '访问 / 下载',
                key: 'cnt',
                width: 120,
                render: (_, r) =>
                  `${r.access_count} / ${r.download_count}${r.max_downloads ? `（限 ${r.max_downloads}）` : ''}`,
              },
              {
                title: '创建时间',
                key: 'created',
                width: 140,
                render: (_, r) => formatTime(r.created_at),
              },
              {
                title: '操作',
                key: 'op',
                width: 150,
                render: (_, r) =>
                  r.revoked ? (
                    <span className="text-12px text-#9CA3AF">已失效</span>
                  ) : (
                    <Space size={4}>
                      <Tooltip title="复制链接">
                        <Button
                          type="text"
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => copyUrl(r.token)}
                        />
                      </Tooltip>
                      <Popconfirm
                        title="撤销该分享？"
                        description="撤销后链接立即失效，且不可恢复。"
                        onConfirm={() => doRevoke(r.id)}
                        okText="撤销"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                      >
                        <Button type="text" size="small" danger>
                          撤销
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
              },
            ]}
          />
        </div>
      </div>
    </Modal>
  )
}

export default ShareModal
