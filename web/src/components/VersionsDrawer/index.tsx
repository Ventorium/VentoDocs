import { useRequest } from 'ahooks'
import { Button, Drawer, Modal, Table, Tag } from 'antd'
import { HistoryOutlined } from '@ant-design/icons'
import type { VersionInfo } from '@/api/schema'
import { client } from '@/api'
import { msg } from '@/components/GlobalMessage'
import { formatBytes, formatDateTime } from '@/lib/format'

type VersionsDrawerProps = {
  open: boolean
  fileId: string | null
  fileName?: string
  onClose: () => void
}

/** 版本历史抽屉：列出全部版本，支持「恢复为当前版本」（生成新版本，不覆盖）。 */
const VersionsDrawer = ({ open, fileId, fileName, onClose }: VersionsDrawerProps) => {
  const { data, loading, run } = useRequest(
    async () => {
      const { error, data: d } = await client.get('/api/v1/files/{id}/versions', {
        params: { id: fileId! }
      })
      if (error || !d) throw new Error('加载版本历史失败')
      return d as unknown as VersionInfo[]
    },
    {
      ready: open && !!fileId,
      refreshDeps: [fileId, open],
    },
  )

  const doRestore = (v: VersionInfo) => {
    Modal.confirm({
      title: `恢复到版本 v${v.version}`,
      content: '恢复不会覆盖现有版本，而是以旧版本内容创建一个新的当前版本。',
      okText: '恢复',
      onOk: async () => {
        const { error } = await client.post('/api/v1/files/{id}/versions/{version}/restore', {
          params: { id: fileId!, version: v.version }
        })
        if (error) return
        msg.success(`已恢复 v${v.version}（生成新版本）`)
        run()
      },
    })
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-6px">
          <HistoryOutlined className="text-#2563EB" />
          版本历史{fileName ? ` · ${fileName}` : ''}
        </span>
      }
      width={560}
      destroyOnHidden
    >
      <Table<VersionInfo>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={data ?? []}
        pagination={false}
        columns={[
          {
            title: '版本',
            dataIndex: 'version',
            width: 90,
            render: (v: number) => (
              <span className="flex items-center gap-6px">
                v{v}
                {v === (data?.[0]?.version ?? -1) && (
                  <Tag color="blue" className="!m-0">当前</Tag>
                )}
              </span>
            ),
          },
          {
            title: '大小',
            dataIndex: 'size',
            width: 90,
            render: (s: number) => formatBytes(s),
          },
          {
            title: '来源',
            dataIndex: 'encoding',
            width: 80,
            render: (enc: 'office' | 'univer') =>
              enc === 'univer' ? <Tag color="purple" className="!m-0">在线</Tag> : '—',
          },
          {
            title: '说明',
            dataIndex: 'note',
            ellipsis: true,
            render: (n: string | null) => n || '—',
          },
          {
            title: '操作人',
            dataIndex: 'created_by_name',
            width: 110,
            ellipsis: true,
          },
          {
            title: '时间',
            dataIndex: 'created_at',
            width: 150,
            render: (t: string) => formatDateTime(t),
          },
          {
            title: '',
            width: 76,
            render: (_, r) =>
              r.version !== (data?.[0]?.version ?? -1) ? (
                <Button type="link" size="small" className="!px-0" onClick={() => doRestore(r)}>
                  恢复
                </Button>
              ) : (
                <span className="text-12px text-#9CA3AF">当前版本</span>
              ),
          },
        ]}
      />
    </Drawer>
  )
}

export default VersionsDrawer
