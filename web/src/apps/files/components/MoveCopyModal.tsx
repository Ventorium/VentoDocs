import { useEffect, useState } from 'react'
import { ChevronRight, Folder } from 'lucide-react'
import { client } from '@/api'
import { Btn, Input, Modal } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { ROOT_DIR_ID } from '@/lib/constants'

type TreeNode = {
  title: string
  value: string
  loaded?: boolean
  children?: TreeNode[]
}

type MoveCopyModalProps = {
  open: boolean
  mode: 'move' | 'copy'
  entryKind: 'file' | 'directory'
  entryId: string
  entryName: string
  sourceDirId: string
  submitting?: boolean
  onSubmit: (targetDirId: string, newName?: string) => Promise<void>
}

function suggestCopyName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0) return `${name.slice(0, dot)}（副本）${name.slice(dot)}`
  return `${name}（副本）`
}

/** 目录行：点击选中为目标，展开箭头懒加载子目录。 */
function DirRow({
  node,
  depth,
  target,
  onPick,
  onToggle,
  loading,
}: {
  node: TreeNode
  depth: number
  target: string | null
  onPick: (id: string) => void
  onToggle: (id: string) => void
  loading: boolean
}) {
  const expanded = node.children !== undefined
  return (
    <>
      <div
        className={`vd-treedir ${target === node.value ? 'sel' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onPick(node.value)}
      >
        <span
          style={{ display: 'inline-flex', width: 16, flexShrink: 0, cursor: 'pointer' }}
          onClick={(e) => {
            e.stopPropagation()
            if (node.children?.length === 0) return
            onToggle(node.value)
          }}
        >
          {node.children?.length === 0 ? null : (
            <ChevronRight
              size={13}
              style={{
                opacity: 0.55,
                transform: expanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s',
              }}
            />
          )}
        </span>
        <Folder size={14} style={{ color: '#F59E0B', flexShrink: 0, margin: '0 4px' }} />
        <span className="vd-treedir-label">{node.title}</span>
        {loading ? <span className="vd-faint" style={{ fontSize: 11.5, marginLeft: 8 }}>加载中…</span> : null}
      </div>
      {expanded
        ? (node.children ?? []).map((c) => (
            <DirRow
              key={c.value}
              node={c}
              depth={depth + 1}
              target={target}
              onPick={onPick}
              onToggle={onToggle}
              loading={loading && c === node.children?.[0]}
            />
          ))
        : null}
    </>
  )
}

/** 移动 / 复制弹窗：懒加载目录树。 */
const MoveCopyModal = ({
  open,
  mode,
  entryKind,
  entryId,
  entryName,
  sourceDirId,
  submitting,
  onSubmit,
}: MoveCopyModalProps) => {
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [target, setTarget] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [loadedRoot, setLoadedRoot] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTarget(null)
      setNewName(mode === 'copy' ? suggestCopyName(entryName) : '')
      setLoadedRoot(false)
      setTreeData([])
    }
  }, [open, mode, entryName])

  const fetchChildren = async (id: string): Promise<TreeNode[]> => {
    const { error, data } = await client.get('/api/v1/directories/{id}', { params: { id } })
    if (error || !data) return []
    return data.children
      .filter((e) => e.kind === 'directory')
      .map((e) => ({ title: e.directory.name, value: e.directory.id }))
  }

  useEffect(() => {
    if (open && !loadedRoot) {
      setLoadedRoot(true)
      setLoadingId(ROOT_DIR_ID)
      client
        .get('/api/v1/directories/root')
        .then(({ error, data }) => {
          if (error || !data) return
          const children = data.children
            .filter((e) => e.kind === 'directory')
            .map((e) => ({ title: e.directory.name, value: e.directory.id }))
          setTreeData([{ title: data.directory.name, value: ROOT_DIR_ID, loaded: true, children }])
        })
        .catch(() => undefined)
        .finally(() => setLoadingId(null))
    }
  }, [open, loadedRoot])

  const toggle = async (id: string) => {
    const find = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.value === id) return n
        if (n.children) {
          const hit = find(n.children)
          if (hit) return hit
        }
      }
      return null
    }
    const node = find(treeData)
    if (!node || node.children) return
    setLoadingId(id)
    try {
      const children = await fetchChildren(id)
      setTreeData((prev) => {
        const walk = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) =>
            n.value === id
              ? { ...n, children, loaded: true }
              : n.children
                ? { ...n, children: walk(n.children) }
                : n,
          )
        return walk(prev)
      })
    } finally {
      setLoadingId(null)
    }
  }

  const handleTarget = (v: string) => {
    setTarget(v)
    if (mode === 'copy') {
      setNewName(v === sourceDirId ? suggestCopyName(entryName) : '')
    }
  }

  const handleOk = async () => {
    if (!target) {
      msg.warning('请选择目标目录')
      return
    }
    if (mode === 'move' && target === sourceDirId) {
      msg.warning('目标目录与当前目录相同')
      return
    }
    if (mode === 'move' && entryKind === 'directory' && target === entryId) {
      msg.warning('不能移动到自身目录')
      return
    }
    const name = newName.trim() || undefined
    await onSubmit(target, mode === 'copy' ? name : undefined)
  }

  const title = mode === 'move' ? `移动「${entryName}」` : `复制「${entryName}」`

  return (
    <Modal
      open={open}
      title={title}
      width={460}
      onClose={() => setTarget(null)}
      footer={
        <>
          <Btn onClick={() => setTarget(null)}>取消</Btn>
          <Btn variant="primary" loading={submitting} onClick={() => void handleOk()}>确定</Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
        <div>
          <div className="vd-field-label" style={{ marginBottom: 4 }}>目标目录</div>
          <div className="vd-treedir-wrap">
            {treeData.map((n) => (
              <DirRow
                key={n.value}
                node={n}
                depth={0}
                target={target}
                onPick={handleTarget}
                onToggle={(id) => void toggle(id)}
                loading={loadingId === n.value}
              />
            ))}
          </div>
        </div>
        {mode === 'copy' ? (
          <div>
            <div className="vd-field-label" style={{ marginBottom: 4 }}>新名称（可选）</div>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="缺省沿用原名称"
              maxLength={200}
            />
          </div>
        ) : null}
        {mode === 'copy' ? (
          <div className="vd-faint" style={{ fontSize: 12 }}>
            复制到目标目录；若名称冲突，系统将提示处理。
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

export default MoveCopyModal
