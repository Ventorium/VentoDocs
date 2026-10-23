import { useEffect, useState } from 'react'
import { Input, Modal, TreeSelect } from 'antd'
import { client } from '@/api'
import { msg } from '@/components/GlobalMessage'
import { ROOT_DIR_ID } from '@/lib/constants'

type TreeNode = {
  title: string
  value: string
  isLeaf: boolean
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

function setChildren(nodes: TreeNode[], id: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.value === id) return { ...n, children, isLeaf: children.length === 0 }
    if (n.children) return { ...n, children: setChildren(n.children, id, children) }
    return n
  })
}

function suggestCopyName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0) return `${name.slice(0, dot)}（副本）${name.slice(dot)}`
  return `${name}（副本）`
}

/** 移动 / 复制弹窗：懒加载目录树 TreeSelect。 */
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

  useEffect(() => {
    if (open) {
      setTarget(null)
      setNewName(mode === 'copy' ? suggestCopyName(entryName) : '')
      setLoadedRoot(false)
      setTreeData([])
    }
  }, [open, mode, entryName])

  const loadData = async (node: { value?: string | number | null; isLeaf?: boolean }) => {
    const id = node.value == null ? '' : String(node.value)
    if (!id) return
    const { error, data } = await client.get('/api/v1/directories/{id}', {
      params: { id }
    })
    if (error || !data) return
    const children: TreeNode[] = data.children
      .filter((e) => e.kind === 'directory')
      .map((e) => ({ title: e.directory.name, value: e.directory.id, isLeaf: false }))
    setTreeData((prev) => setChildren(prev, id, children))
  }

  const loadRoot = async () => {
    if (loadedRoot) return
    setLoadedRoot(true)
    const { error, data } = await client.get('/api/v1/directories/root')
    if (error || !data) return
    const children: TreeNode[] = data.children
      .filter((e) => e.kind === 'directory')
      .map((e) => ({ title: e.directory.name, value: e.directory.id, isLeaf: false }))
    setTreeData([{ title: data.directory.name, value: ROOT_DIR_ID, isLeaf: false, children }])
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
    if (mode === 'move' && entryKind === 'directory') {
      // 禁止移动到自身（目标在树中不会包含自身，此处兜底）
      if (target === entryId) {
        msg.warning('不能移动到自身目录')
        return
      }
    }
    const name = newName.trim() || undefined
    await onSubmit(target, mode === 'copy' ? name : undefined)
  }

  const title = mode === 'move' ? `移动「${entryName}」` : `复制「${entryName}」`

  return (
    <Modal
      open={open}
      title={title}
      okText="确定"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={handleOk}
      destroyOnHidden
    >
      <div className="flex flex-col gap-10px py-4px">
        <div className="text-13px text-#6B7280 mb-4px">目标目录</div>
        <TreeSelect
          style={{ width: '100%' }}
          placeholder="选择目标目录"
          value={target ?? undefined}
          onChange={handleTarget}
          treeData={treeData}
          loadData={loadData}
          onPopupVisibleChange={(visible) => {
            if (visible && !loadedRoot) loadRoot()
          }}
          allowClear
          dropdownStyle={{ maxHeight: 360, overflow: 'auto' }}
        />
        {mode === 'copy' && (
          <div className="mt-10px">
            <div className="text-13px text-#6B7280 mb-4px">新名称（可选）</div>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="缺省沿用原名称"
              maxLength={200}
            />
          </div>
        )}
        {mode === 'copy' && (
          <div className="text-12px text-#9CA3AF mt-8px">
            复制到目标目录；若名称冲突，系统将提示处理。
          </div>
        )}
      </div>
    </Modal>
  )
}

export default MoveCopyModal
