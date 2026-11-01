import { useEffect, useMemo, useRef, useState } from 'react'
import { useRequest } from 'ahooks'
import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import dayjs from 'dayjs'
import { client } from '@/api'
import type { TrashedDirectory, TrashedFile } from '@/api/schema'
import { Btn, Empty, Input, Modal, Spin } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import { useContextMenu, type CtxItem } from '@/shell/ContextMenu'
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

type ConfirmPurge = { title: string; content: string; run: () => Promise<void> }

/** 回收站：文件与目录混合显示（Windows 风格），按删除时间倒序；恢复、彻底删除按类型路由。 */
const TrashPage = () => {
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmPurge | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const { show } = useContextMenu()
  const wrapRef = useRef<HTMLDivElement>(null)

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

  /** 选中集合里文件数（彻底删除仅对文件可用，用于禁用顶部批量彻底删除按钮）。 */
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

  /** 恢复：单项走单项路径（文件 409 弹改名框），多项走批量循环（冲突跳过）。 */
  const restoreTargets = async (targets: TrashItem[]) => {
    if (targets.length === 0) return
    if (targets.length === 1) {
      const t = targets[0]
      if (t.kind === 'dir') await restoreDir(t)
      else await restoreFile(t)
      return
    }
    let okCount = 0
    for (const t of targets) {
      const res =
        t.kind === 'file'
          ? await client.post('/api/v1/files/{id}/restore', { params: { id: t.id } })
          : await client.post('/api/v1/directories/{id}/restore', { params: { id: t.id } })
      if (!res.error) okCount++
    }
    msg.success(`恢复完成（成功 ${okCount}/${targets.length}，冲突项已跳过）`)
    setSelectedIds([])
    refresh()
  }

  /** 彻底删除（仅文件）：单项 / 多项统一弹确认框。 */
  const purgeTargets = (targets: TrashItem[]) => {
    const files = targets.filter((t): t is Extract<TrashItem, { kind: 'file' }> => t.kind === 'file')
    if (files.length === 0) return
    setConfirm(
      files.length === 1
        ? {
            title: '彻底删除',
            content: `彻底删除「${files[0].name}」？删除后不可恢复。`,
            run: async () => {
              const res = await client.delete('/api/v1/files/{id}/purge', { params: { id: files[0].id } })
              if (res.error) return
              msg.success(`已彻底删除「${files[0].name}」`)
              setSelectedIds((ids) => ids.filter((i) => i !== files[0].id))
              refresh()
            },
          }
        : {
            title: `彻底删除（${files.length} 项）`,
            content: `彻底删除选中的 ${files.length} 个文件？删除后不可恢复。`,
            run: async () => {
              for (const t of files) {
                await client.delete('/api/v1/files/{id}/purge', { params: { id: t.id } })
              }
              msg.success(`已彻底删除 ${files.length} 个文件`)
              setSelectedIds([])
              refresh()
            },
          },
    )
  }

  /** 顶部「批量恢复 / 批量彻底删除」：作用于当前点选集合。 */
  const batchRestore = () => void restoreTargets((items ?? []).filter((it) => selectedIds.includes(it.id)))
  const batchPurge = () => purgeTargets((items ?? []).filter((it) => selectedIds.includes(it.id)))

  // ── 键盘：Ctrl/Cmd+A 全选 / ↑↓ 选择移动 / Shift+↑↓ 连选 / Delete 彻底删除 / Esc 取消 ──

  // 挂载聚焦表格容器（与文件管理器多列导航一致，窗口打开后键盘即生效）。
  useEffect(() => {
    wrapRef.current?.focus()
  }, [])

  const onTableKey = (e: React.KeyboardEvent) => {
    // 模态打开时（恢复改名框 / 彻底删除确认框）不响应列表快捷键，避免二次触发
    if (confirm || renameTarget) return
    const list = items ?? []
    if (list.length === 0) return
    const modKey = e.metaKey || e.ctrlKey
    if (modKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      setSelectedIds(list.map((it) => it.id))
      setAnchorId(null)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = anchorId ? list.findIndex((it) => it.id === anchorId) : -1
      if (e.shiftKey) {
        // Shift+↑↓：从锚点连选（无锚点时忽略）
        if (cur < 0) return
        const nextIdx = e.key === 'ArrowDown' ? Math.min(cur + 1, list.length - 1) : Math.max(cur - 1, 0)
        const [lo, hi] = cur <= nextIdx ? [cur, nextIdx] : [nextIdx, cur]
        setSelectedIds(list.slice(lo, hi + 1).map((it) => it.id))
        return
      }
      const nextIdx =
        cur < 0
          ? e.key === 'ArrowDown' ? 0 : list.length - 1
          : e.key === 'ArrowDown' ? Math.min(cur + 1, list.length - 1) : Math.max(cur - 1, 0)
      const it = list[nextIdx]
      setSelectedIds([it.id])
      setAnchorId(it.id)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (selectedIds.length === 0) return
      const targets = list.filter((it) => selectedIds.includes(it.id))
      if (targets.every((t) => t.kind === 'dir')) {
        msg.error('彻底删除仅支持文件，暂不支持目录')
        return
      }
      purgeTargets(targets)
      return
    }
    if (e.key === 'Escape') {
      setSelectedIds([])
      setAnchorId(null)
    }
  }

  const runConfirm = async () => {
    if (!confirm) return
    setConfirmBusy(true)
    await confirm.run()
    setConfirmBusy(false)
    setConfirm(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>回收站</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, fontSize: 13, color: 'var(--vd-text-tertiary)' }}>
          点击选中，Cmd/Ctrl+单击 多选，Shift+单击 连选；快捷键：Ctrl/Cmd+A 全选、↑↓ 移动选择、Shift+↑↓ 连选、Delete 彻底删除（仅文件）、Esc 取消选择；右键或顶部按钮恢复 / 彻底删除（仅文件）。
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn size="sm" disabled={selectedIds.length === 0} onClick={() => void batchRestore()}>
            <RefreshCw size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            批量恢复
          </Btn>
          <Btn size="sm" variant="danger" disabled={selectedFileCount === 0} onClick={batchPurge}>
            <Trash2 size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            批量彻底删除
          </Btn>
        </div>
      </div>

      <div
        ref={wrapRef}
        className="vd-table-wrap"
        tabIndex={-1}
        onKeyDown={onTableKey}
        onClick={(e) => {
          // 点表格空白处取消选中
          if (!(e.target instanceof Element) || !e.target.closest('tr')) {
            setSelectedIds([])
            setAnchorId(null)
          }
        }}
      >
        {loading ? (
          <div style={{ padding: 40 }}>
            <Spin />
          </div>
        ) : items && items.length > 0 ? (
          <table className="vd-table">
            <thead>
              <tr>
                <th>名称</th>
                <th style={{ width: 80 }}>类型</th>
                <th style={{ width: 110 }}>大小</th>
                <th>原路径</th>
                <th style={{ width: 170 }}>删除时间</th>
                <th style={{ width: 110 }}>剩余保留</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr
                  key={r.id}
                  className={`clickable${selectedIds.includes(r.id) ? ' sel' : ''}`}
                  onClick={(e) => {
                    // 单击选中；Cmd/Ctrl+单击 切换多选；Shift+单击 从锚点连选
                    if (!e.currentTarget.contains(e.target as Node)) return
                    if (e.shiftKey && anchorId) {
                      const ids = items.map((it) => it.id)
                      const a = ids.indexOf(anchorId)
                      const b = ids.indexOf(r.id)
                      if (a !== -1 && b !== -1) {
                        const [lo, hi] = a < b ? [a, b] : [b, a]
                        setSelectedIds(ids.slice(lo, hi + 1))
                        return
                      }
                    }
                    if (e.metaKey || e.ctrlKey) {
                      setSelectedIds((prev) =>
                        prev.includes(r.id) ? prev.filter((i) => i !== r.id) : [...prev, r.id],
                      )
                      setAnchorId(r.id)
                      return
                    }
                    setSelectedIds([r.id])
                    setAnchorId(r.id)
                  }}
                  onContextMenu={(e) => {
                    // 仅当点击目标在行内 DOM 中才触发（避免弹层冒泡误触发）
                    if (!e.currentTarget.contains(e.target as Node)) return
                    e.preventDefault()
                    e.stopPropagation()
                    // 多选态下右键作用于整个选择集；否则右键即选中该条目
                    const isMulti = selectedIds.length > 1 && selectedIds.includes(r.id)
                    const targets = isMulti ? items.filter((it) => selectedIds.includes(it.id)) : [r]
                    if (!isMulti) {
                      setSelectedIds([r.id])
                      setAnchorId(r.id)
                    }
                    const menuItems: CtxItem[] = [
                      {
                        key: 'restore',
                        label: targets.length > 1 ? `恢复（${targets.length} 项）` : '恢复',
                        icon: <RotateCcw size={14} />,
                        onClick: () => void restoreTargets(targets),
                      },
                    ]
                    if (targets.every((t) => t.kind === 'file')) {
                      menuItems.push(
                        { key: 'div-purge', divider: true },
                        {
                          key: 'purge',
                          label: targets.length > 1 ? `彻底删除（${targets.length} 项）` : '彻底删除',
                          danger: true,
                          icon: <Trash2 size={14} />,
                          onClick: () => purgeTargets(targets),
                        },
                      )
                    }
                    show(e.clientX, e.clientY, menuItems)
                  }}
                >
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {r.kind === 'dir' ? <FolderIcon size={16} /> : <FileIcon name={r.name} size={16} />}
                      <span>{r.name}</span>
                    </span>
                  </td>
                  <td>{r.kind === 'dir' ? '目录' : '文件'}</td>
                  <td>{r.kind === 'dir' ? '—' : formatBytes(r.size)}</td>
                  <td>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 260 }}>
                      {r.path || '—'}
                    </span>
                  </td>
                  <td>{formatTime(r.deletedAt)}</td>
                  <td>{remainDays(r.deletedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text={error ? '加载失败，请刷新重试' : '回收站是空的'} />
        )}
      </div>

      <Modal
        open={!!renameTarget}
        title="恢复并改名"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Btn onClick={() => setRenameTarget(null)}>取消</Btn>
            <Btn variant="primary" loading={renamingBusy} onClick={() => void doRestoreRename()}>恢复</Btn>
          </>
        }
      >
        <p className="m-0" style={{ fontSize: 13, color: 'var(--vd-text-secondary)' }}>
          原位置已存在同名文件，请为待恢复文件指定新名称：
        </p>
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void doRestoreRename()}
          autoFocus
        />
      </Modal>

      <Modal
        open={!!confirm}
        title={confirm?.title ?? ''}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Btn onClick={() => setConfirm(null)}>取消</Btn>
            <Btn variant="danger" loading={confirmBusy} onClick={() => void runConfirm()}>
              彻底删除
            </Btn>
          </>
        }
      >
        <p className="m-0">{confirm?.content}</p>
      </Modal>
    </div>
  )
}

export default TrashPage
