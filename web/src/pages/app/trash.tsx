import { useState } from 'react'
import { useRequest } from 'ahooks'
import { Button, Input, Modal, Space, Table, Tabs } from 'antd'
import { DeleteOutlined, RedoOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { client } from '@/api'
import type { Directory, FileMeta } from '@/api/schema'
import { msg } from '@/components/GlobalMessage'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import { formatBytes, formatTime } from '@/lib/format'
import { TRASH_RETENTION_DAYS } from '@/lib/constants'

/** 剩余保留天数：deleted_at + 180 天 - 今天。 */
function remainDays(deletedAt?: string | null): string {
  if (!deletedAt) return '-'
  const days = Math.ceil(dayjs(deletedAt).add(TRASH_RETENTION_DAYS, 'day').diff(dayjs()))
  return `${Math.max(0, days)} 天`
}

type RenameTarget = { id: string; name: string }

/** 回收站：文件/目录 tabs，恢复（冲突时改名恢复）、彻底删除。 */
const TrashPage = () => {
  const [tab, setTab] = useState('files')
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])

  const {
    data: files,
    loading: filesLoading,
    error: filesError,
    refresh: refreshFiles,
  } = useRequest(async () => {
    const { error, data } = await client.get('/api/v1/trash/files')
    if (error || !data) throw new Error('加载失败')
    return data as unknown as FileMeta[]
  })

  const {
    data: dirs,
    loading: dirsLoading,
    error: dirsError,
    refresh: refreshDirs,
  } = useRequest(async () => {
    const { error, data } = await client.get('/api/v1/trash/directories')
    if (error || !data) throw new Error('加载失败')
    return data as unknown as Directory[]
  })

  const restoreFile = async (f: FileMeta) => {
    const res = await client.post('/api/v1/files/{id}/restore', {
      params: { id: f.id },
    })
    if (res.error) {
      if (res.response?.status === 409) {
        setRenameTarget({ id: f.id, name: f.name })
        setRenameValue(`${f.name} (1)`)
      }
      return
    }
    msg.success(`已恢复「${f.name}」`)
    refreshFiles()
  }

  const restoreDir = async (d: Directory) => {
    const res = await client.post('/api/v1/directories/{id}/restore', {
      params: { id: d.id },
    })
    if (res.error) {
      if (res.response?.status === 409) {
        msg.error('原位置已存在同名目录，请先处理冲突目录后再恢复')
      }
      return
    }
    msg.success(`已恢复「${d.name}」`)
    refreshDirs()
  }

  const doRestoreRename = async () => {
    if (!renameTarget) return
    const newName = renameValue.trim()
    if (!newName) return
    setRenamingBusy(true)
    const res = await client.post('/api/v1/files/{id}/restore/rename', {
      params: { id: renameTarget.id },
      body: { new_name: newName },
    })
    setRenamingBusy(false)
    if (res.error) return
    msg.success(`已恢复为「${newName}」`)
    setRenameTarget(null)
    refreshFiles()
  }

  const purgeFile = (f: FileMeta) => {
    Modal.confirm({
      title: '彻底删除',
      content: `彻底删除「${f.name}」？删除后不可恢复。`,
      okText: '彻底删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        const res = await client.delete('/api/v1/files/{id}/purge', {
          params: { id: f.id },
        })
        if (res.error) return
        msg.success(`已彻底删除「${f.name}」`)
        setSelectedFileIds((ids) => ids.filter((i) => i !== f.id))
        refreshFiles()
      },
    })
  }

  const batchRestore = async () => {
    const targets = (files ?? []).filter((f) => selectedFileIds.includes(f.id))
    if (targets.length === 0) return
    for (const f of targets) {
      await client.post('/api/v1/files/{id}/restore', { params: { id: f.id } })
    }
    msg.success(`批量恢复完成（${targets.length} 个，冲突项已跳过）`)
    setSelectedFileIds([])
    refreshFiles()
  }

  const batchPurge = () => {
    if (selectedFileIds.length === 0) return
    Modal.confirm({
      title: '批量彻底删除',
      content: `彻底删除选中的 ${selectedFileIds.length} 个文件？删除后不可恢复。`,
      okText: '彻底删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        for (const id of selectedFileIds) {
          await client.delete('/api/v1/files/{id}/purge', { params: { id } })
        }
        msg.success('批量彻底删除完成')
        setSelectedFileIds([])
        refreshFiles()
      },
    })
  }

  const fileCols = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_: string, r: FileMeta) => (
        <Space>
          <FileIcon name={r.name} size={16} />
          <span>{r.name}</span>
        </Space>
      ),
    },
    { title: '大小', dataIndex: 'size', width: 110, render: (s: number) => formatBytes(s) },
    {
      title: '删除时间',
      dataIndex: 'deleted_at',
      width: 170,
      render: (t?: string | null) => formatTime(t),
    },
    {
      title: '剩余保留',
      width: 110,
      render: (_: unknown, r: FileMeta) => remainDays(r.deleted_at),
    },
    {
      title: '操作',
      width: 210,
      render: (_: unknown, r: FileMeta) => (
        <Space>
          <Button size="small" icon={<RedoOutlined />} onClick={() => void restoreFile(r)}>
            恢复
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => purgeFile(r)}>
            彻底删除
          </Button>
        </Space>
      ),
    },
  ]

  const dirCols = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_: string, r: Directory) => (
        <Space>
          <FolderIcon size={16} />
          <span>{r.name}</span>
        </Space>
      ),
    },
    { title: '原路径', dataIndex: 'path', ellipsis: true },
    {
      title: '删除时间',
      dataIndex: 'deleted_at',
      width: 170,
      render: (t?: string | null) => formatTime(t),
    },
    {
      title: '剩余保留',
      width: 110,
      render: (_: unknown, r: Directory) => remainDays(r.deleted_at),
    },
    {
      title: '操作',
      width: 110,
      render: (_: unknown, r: Directory) => (
        <Button size="small" icon={<RedoOutlined />} onClick={() => void restoreDir(r)}>
          恢复
        </Button>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-12px">
      <div className="text-16px font-600">回收站</div>
      <div className="flex items-center gap-12px">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          className="flex-1"
          items={[
            { key: 'files', label: '文件' },
            { key: 'directories', label: '目录' },
          ]}
        />
        {tab === 'files' && (
          <Space>
            <Button
              size="small"
              disabled={selectedFileIds.length === 0}
              icon={<RedoOutlined />}
              onClick={() => void batchRestore()}
            >
              批量恢复
            </Button>
            <Button
              size="small"
              danger
              disabled={selectedFileIds.length === 0}
              icon={<DeleteOutlined />}
              onClick={batchPurge}
            >
              批量彻底删除
            </Button>
          </Space>
        )}
      </div>

      <div className="rounded-8px border-1px border-#E5E7EB bg-white">
        {tab === 'files' ? (
          <Table<FileMeta>
            rowKey="id"
            size="small"
            loading={filesLoading}
            dataSource={files ?? []}
            columns={fileCols}
            rowSelection={{
              selectedRowKeys: selectedFileIds,
              onChange: (keys) => setSelectedFileIds(keys as string[]),
            }}
            locale={{
              emptyText: filesError ? '加载失败，请刷新重试' : '回收站是空的',
            }}
            pagination={false}
          />
        ) : (
          <Table<Directory>
            rowKey="id"
            size="small"
            loading={dirsLoading}
            dataSource={dirs ?? []}
            columns={dirCols}
            locale={{
              emptyText: dirsError ? '加载失败，请刷新重试' : '回收站是空的',
            }}
            pagination={false}
          />
        )}
      </div>

      <Modal
        title="恢复并改名"
        open={!!renameTarget}
        okText="恢复"
        confirmLoading={renamingBusy}
        onOk={() => void doRestoreRename()}
        onCancel={() => setRenameTarget(null)}
        destroyOnHidden
      >
        <div className="mb-12px text-13px text-rgba(0,0,0,0.65)">
          原位置已存在同名文件，请为待恢复文件指定新名称：
        </div>
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={() => void doRestoreRename()}
          autoFocus
        />
      </Modal>
    </div>
  )
}

export default TrashPage
