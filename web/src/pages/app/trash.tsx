import { useMemo, useState } from 'react'
import { useRequest } from 'ahooks'
import { Button, Input, Modal, Space, Table } from 'antd'
import { DeleteOutlined, RedoOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { client } from '@/api'
import type { TrashedDirectory, TrashedFile } from '@/api/schema'
import { msg } from '@/components/GlobalMessage'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import { formatBytes, formatTime } from '@/lib/format'
import { TRASH_RETENTION_DAYS } from '@/lib/constants'

/** 剩余保留天数：deleted_at + 180 天 - 今天。 */
function remainDays(deletedAt?: string | null): string {
  if (!deletedAt) return '-'
  const days = Math.ceil(dayjs(deletedAt).add(TRASH_RETENTION_DAYS, 'day').diff(dayjs(), 'day'))
  return `${Math.max(0, days)} 天`
}

type TrashItem =
  | { kind: 'file'; id: string; name: string; size: number; path: string; deletedAt: string | null }
  | { kind: 'dir'; id: string; name: string; size: number; path: string; deletedAt: string | null }

type RenameTarget = { id: string; name: string }

/** 回收站：文件与目录混合显示（Windows 风格），按删除时间倒序；恢复、彻底删除按类型路由。 */
const TrashPage = () => {
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const {
    data: items,
    loading,
    error,
    refresh,
  } = useRequest(async () => {
    const [filesRes, dirsRes] = await Promise.all([
      client.get('/api/v1/trash/files'),
      client.get('/api/v1/trash/directories'),
    ])
    if (filesRes.error || !filesRes.data) throw new Error('加载文件失败')
    if (dirsRes.error || !dirsRes.data) throw new Error('加载目录失败')
    const files = filesRes.data as unknown as TrashedFile[]
    const dirs = dirsRes.data as unknown as TrashedDirectory[]
    const merged: TrashItem[] = [
      ...files.map((f) => ({
        kind: 'file' as const,
        id: f.id,
        name: f.name,
        size: f.size,
        path: f.original_path ?? '',
        deletedAt: f.deleted_at ?? null,
      })),
      ...dirs.map((d) => ({
        kind: 'dir' as const,
        id: d.id,
        name: d.name,
        size: 0,
        path: d.original_path ?? d.path,
        deletedAt: d.deleted_at ?? null,
      })),
    ]
    merged.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
    return merged
  })

  const byId = useMemo(() => {
    const m = new Map<string, TrashItem>()
    for (const it of items ?? []) m.set(it.id, it)
    return m
  }, [items])

  const selectedFileCount = useMemo(
    () => selectedIds.filter((id) => byId.get(id)?.kind === 'file').length,
    [selectedIds, byId],
  )

  const restoreFile = async (f: TrashItem) => {
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
    refresh()
  }

  const restoreDir = async (d: TrashItem) => {
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
    refresh()
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
    refresh()
  }

  const purgeFile = (f: TrashItem) => {
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
        setSelectedIds((ids) => ids.filter((i) => i !== f.id))
        refresh()
      },
    })
  }

  const batchRestore = async () => {
    const targets = (items ?? []).filter((it) => selectedIds.includes(it.id))
    if (targets.length === 0) return
    let okCount = 0
    for (const t of targets) {
      const res =
        t.kind === 'file'
          ? await client.post('/api/v1/files/{id}/restore', { params: { id: t.id } })
          : await client.post('/api/v1/directories/{id}/restore', { params: { id: t.id } })
      if (!res.error) okCount++
    }
    msg.success(`批量恢复完成（成功 ${okCount}/${targets.length}，冲突项已跳过）`)
    setSelectedIds([])
    refresh()
  }

  const batchPurge = () => {
    const targets = (items ?? []).filter((it) => selectedIds.includes(it.id) && it.kind === 'file')
    if (targets.length === 0) return
    Modal.confirm({
      title: '批量彻底删除',
      content: `彻底删除选中的 ${targets.length} 个文件？删除后不可恢复。`,
      okText: '彻底删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        for (const t of targets) {
          await client.delete('/api/v1/files/{id}/purge', { params: { id: t.id } })
        }
        msg.success('批量彻底删除完成')
        setSelectedIds([])
        refresh()
      },
    })
  }

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_: string, r: TrashItem) => (
        <Space>
          {r.kind === 'dir' ? <FolderIcon size={16} /> : <FileIcon name={r.name} size={16} />}
          <span>{r.name}</span>
        </Space>
      ),
    },
    {
      title: '类型',
      width: 80,
      render: (_: unknown, r: TrashItem) => (r.kind === 'dir' ? '目录' : '文件'),
    },
    {
      title: '大小',
      width: 110,
      render: (_: unknown, r: TrashItem) => (r.kind === 'dir' ? '—' : formatBytes(r.size)),
    },
    {
      title: '原路径',
      dataIndex: 'path',
      ellipsis: true,
      render: (p: string) => p || '—',
    },
    {
      title: '删除时间',
      width: 170,
      render: (_: unknown, r: TrashItem) => formatTime(r.deletedAt),
    },
    {
      title: '剩余保留',
      width: 110,
      render: (_: unknown, r: TrashItem) => remainDays(r.deletedAt),
    },
    {
      title: '操作',
      width: 210,
      render: (_: unknown, r: TrashItem) => (
        <Space>
          <Button
            size="small"
            icon={<RedoOutlined />}
            onClick={() => void (r.kind === 'dir' ? restoreDir(r) : restoreFile(r))}
          >
            恢复
          </Button>
          {r.kind === 'file' && (
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => purgeFile(r)}>
              彻底删除
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-12px">
      <div className="text-16px font-600">回收站</div>
      <div className="flex items-center gap-12px">
        <div className="flex-1 text-13px text-rgba(0,0,0,0.45)">
          文件与目录混合显示；彻底删除仅适用于文件。
        </div>
        <Space>
          <Button
            size="small"
            disabled={selectedIds.length === 0}
            icon={<RedoOutlined />}
            onClick={() => void batchRestore()}
          >
            批量恢复
          </Button>
          <Button
            size="small"
            danger
            disabled={selectedFileCount === 0}
            icon={<DeleteOutlined />}
            onClick={batchPurge}
          >
            批量彻底删除
          </Button>
        </Space>
      </div>

      <div className="rounded-8px border-1px border-#E5E7EB bg-white">
        <Table<TrashItem>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={items ?? []}
          columns={columns as any}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys as string[]),
          }}
          locale={{
            emptyText: error ? '加载失败，请刷新重试' : '回收站是空的',
          }}
          pagination={false}
        />
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
