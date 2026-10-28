import { useState } from 'react'
import { CloudUpload, FolderPlus, Lock, MoreHorizontal, RefreshCw } from 'lucide-react'
import type { DirectoryPage, Entry } from '@/api/schema'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import RenameModal from '@/components/RenameModal'
import VersionsDrawer from '@/components/VersionsDrawer'
import { Btn, Dropdown, IconBtn, Modal, Tag } from '@/components/ui/kit'
import { useContextMenu, type CtxItem } from '@/shell/ContextMenu'
import MoveCopyModal from './MoveCopyModal'
import GrantsModal from './GrantsModal'
import ShareModal from './ShareModal'
import PublishModal from './PublishModal'
import { useEntryActions } from './useEntryActions'
import { formatBytes, formatTime } from '@/lib/format'
import { hasPerm, PERM } from '@/lib/perm'
import type { AuthUser } from '@/store/useAuth'

type EntryTableProps = {
  page: DirectoryPage
  me: AuthUser
  onReload: () => void
  onOpenFile: (fileId: string) => void
  onOpenDir: (dirId: string) => void
  /** 空白处右键菜单所需（目录视图传入） */
  canCreateDir?: boolean
  canUpload?: boolean
  onNewDir?: () => void
  onUpload?: () => void
}

const isFile = (r: Entry): r is Extract<Entry, { kind: 'file' }> => r.kind === 'file'
const entryId = (r: Entry) => (r.kind === 'file' ? r.file.id : r.directory.id)
const entryName = (r: Entry) => (r.kind === 'file' ? r.file.name : r.directory.name)

/** 目录条目表格：行内菜单按权限位门控，行操作逻辑见 useEntryActions。
 * 支持 Windows 风格右键菜单（行上 = 条目操作，空白处 = 新建/上传/刷新）。 */
const EntryTable = ({ page, me, onReload, onOpenFile, onOpenDir, canCreateDir, canUpload, onNewDir, onUpload }: EntryTableProps) => {
  const { show } = useContextMenu()
  /** 选中行 id 集合：单击选中、Cmd/Ctrl+单击 切换多选、Shift+单击 连选；双击才打开（对齐 Windows 资源管理器） */
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const {
    modal,
    close,
    renameValue,
    renaming,
    deleting,
    doRename,
    doMove,
    doCopy,
    doUnlock,
    doConfirmDelete,
    confirmDeleteMany,
    doConfirmDeleteMany,
    buildFileMenu,
    buildDirMenu,
  } = useEntryActions(page.my_perms, me, onReload)

  const selectedEntries = page.children.filter((r) => selectedIds.includes(entryId(r)))

  /** 多选（≥2 项）时的右键菜单：目前仅批量删除有批量语义，其余操作仍走单项菜单。 */
  const multiCtxItems = (): CtxItem[] => {
    const items: CtxItem[] = []
    if (hasPerm(page.my_perms, PERM.DELETE_RESTORE)) {
      items.push({
        key: 'delete-many',
        label: `删除所选 ${selectedEntries.length} 项（移入回收站）`,
        danger: true,
        onClick: () => {
          const targets = selectedEntries
          setSelectedIds([])
          setAnchorId(null)
          confirmDeleteMany(targets)
        },
      })
    }
    return items
  }

  /** 菜单项（行上 / 空白区）→ 全局右键菜单格式。 */
  const rowCtxItems = (r: Entry): CtxItem[] =>
    (isFile(r) ? buildFileMenu(r) : buildDirMenu(r)).map((it) =>
      it.divider
        ? { key: it.key, divider: true }
        : { key: it.key, label: it.label, danger: it.danger, onClick: () => it.onClick?.() },
    )

  const blankCtxItems = (): CtxItem[] => [
    ...(canCreateDir ? [{ key: 'newdir', label: '新建目录', icon: <FolderPlus size={14} />, onClick: () => onNewDir?.() }] : []),
    ...(canUpload ? [{ key: 'upload', label: '上传文件', icon: <CloudUpload size={14} />, onClick: () => onUpload?.() }] : []),
    { key: 'refresh', label: '刷新', icon: <RefreshCw size={14} />, onClick: onReload },
  ]

  return (
    <>
      <div
        className="vd-table-wrap"
        onClick={(e) => {
          // 点表格空白处取消选中
          if (!(e.target instanceof Element) || !e.target.closest('tr')) {
            setSelectedIds([])
            setAnchorId(null)
          }
        }}
        onContextMenu={(e) => {
          // 行上的右键由行处理器负责；此处只处理表格空白区
          if (e.target instanceof Element && e.target.closest('tr')) return
          e.preventDefault()
          show(e.clientX, e.clientY, blankCtxItems())
        }}
      >
        <table className="vd-table">
          <thead>
            <tr>
              <th>名称</th>
              <th className="num" style={{ width: 100 }}>大小</th>
              <th style={{ width: 150 }}>更新时间</th>
              <th style={{ width: 140 }}>状态</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {page.children.map((r) => (
              <tr
                key={entryId(r)}
                className={`clickable${selectedIds.includes(entryId(r)) ? ' sel' : ''}`}
                // 仅当点击目标在行内 DOM 中才触发：行内弹层（下拉菜单等）挂载在
                // body 级固定定位，其 React 合成事件会沿组件树冒泡到 <tr>，但原生
                // target 不在行内，据此区分，避免点菜单项误触发选中。
                // 单击选中；Cmd/Ctrl+单击 切换多选；Shift+单击 从锚点连选。
                onClick={(e) => {
                  if (!e.currentTarget.contains(e.target as Node)) return
                  const id = entryId(r)
                  if (e.shiftKey && anchorId) {
                    const ids = page.children.map(entryId)
                    const a = ids.indexOf(anchorId)
                    const b = ids.indexOf(id)
                    if (a !== -1 && b !== -1) {
                      const [lo, hi] = a < b ? [a, b] : [b, a]
                      setSelectedIds(ids.slice(lo, hi + 1))
                      return
                    }
                  }
                  if (e.metaKey || e.ctrlKey) {
                    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                    setAnchorId(id)
                    return
                  }
                  setSelectedIds([id])
                  setAnchorId(id)
                }}
                // 单击仅选中；双击才打开（文件打开详情窗口，目录进入）
                onDoubleClick={(e) => {
                  if (!e.currentTarget.contains(e.target as Node)) return
                  if (isFile(r)) onOpenFile(r.file.id)
                  else onOpenDir(r.directory.id)
                }}
                onContextMenu={(e) => {
                  if (!e.currentTarget.contains(e.target as Node)) return
                  e.preventDefault()
                  e.stopPropagation()
                  const id = entryId(r)
                  // 多选态下右键作用于整个选择集（若批量菜单有可用项）；否则右键仅选中该条目
                  if (selectedIds.length > 1 && selectedIds.includes(id)) {
                    const batchItems = multiCtxItems()
                    if (batchItems.length > 0) {
                      show(e.clientX, e.clientY, batchItems)
                      return
                    }
                  }
                  if (!selectedIds.includes(id)) {
                    setSelectedIds([id])
                    setAnchorId(id)
                  }
                  show(e.clientX, e.clientY, rowCtxItems(r))
                }}
              >
                <td>
                  <span className="vd-row-main" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {isFile(r) ? <FileIcon name={r.file.name} size={18} /> : <FolderIcon size={18} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entryName(r)}</span>
                  </span>
                </td>
                <td className="num">{isFile(r) ? formatBytes(r.file.size) : '—'}</td>
                <td>{isFile(r) ? formatTime(r.file.updated_at) : formatTime(r.directory.created_at)}</td>
                <td>
                  {isFile(r) && r.lock ? (
                    <Tag color="blue">
                      <Lock size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                      {r.lock.locked_by_name}
                    </Tag>
                  ) : (
                    <span className="vd-faint">—</span>
                  )}
                </td>
                <td>
                  <Dropdown
                    button={
                      <IconBtn small aria-label="更多操作">
                        <MoreHorizontal size={15} />
                      </IconBtn>
                    }
                    items={isFile(r) ? buildFileMenu(r) : buildDirMenu(r)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal?.type === 'rename' && (
        <RenameModal
          open
          title={`重命名「${entryName(modal.entry)}」`}
          initialName={renameValue}
          submitting={renaming}
          onSubmit={doRename}
        />
      )}
      {modal?.type === 'move' && (
        <MoveCopyModal
          open
          mode="move"
          entryKind={modal.entry.kind}
          entryId={entryId(modal.entry)}
          entryName={entryName(modal.entry)}
          sourceDirId={page.directory.id}
          onSubmit={doMove}
        />
      )}
      {modal?.type === 'copy' && modal.entry.kind === 'file' && (
        <MoveCopyModal
          open
          mode="copy"
          entryKind="file"
          entryId={modal.entry.file.id}
          entryName={modal.entry.file.name}
          sourceDirId={page.directory.id}
          onSubmit={doCopy}
        />
      )}
      {modal?.type === 'delete-many' && (
        <Modal
          open
          title={`删除 ${modal.entries.length} 项`}
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>取消</Btn>
              <Btn variant="danger" loading={deleting} onClick={() => void doConfirmDeleteMany()}>
                删除
              </Btn>
            </>
          }
        >
          <p className="m-0">删除后移入回收站，保留 180 天后自动清理。共 {modal.entries.length} 项。</p>
        </Modal>
      )}
      {modal?.type === 'delete' && (
        <Modal
          open
          title={`删除「${entryName(modal.entry)}」`}
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>取消</Btn>
              <Btn variant="danger" loading={deleting} onClick={() => void doConfirmDelete()}>
                删除
              </Btn>
            </>
          }
        >
          <p className="m-0">删除后移入回收站，保留 180 天后自动清理。</p>
        </Modal>
      )}
      {modal?.type === 'unlock' && (
        <Modal
          open
          title="强制解锁"
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>取消</Btn>
              <Btn variant="danger" onClick={() => void doUnlock(modal.file, true)}>
                强制解锁
              </Btn>
            </>
          }
        >
          <p className="m-0">
            文件当前由 {modal.lock.locked_by_name} 锁定。强制解锁将直接释放锁，可能影响对方正在进行的编辑。
          </p>
        </Modal>
      )}
      {modal?.type === 'versions' && (
        <VersionsDrawer open fileId={modal.file.id} fileName={modal.file.name} onClose={close} />
      )}
      {modal?.type === 'grants' && (
        <GrantsModal open dirId={modal.dir.id} dirName={modal.dir.name} onClose={close} />
      )}
      {modal?.type === 'share' && (
        <ShareModal
          open
          resourceType={modal.entry.kind === 'file' ? 'file' : 'directory'}
          resourceId={modal.entry.kind === 'file' ? modal.entry.file.id : modal.entry.directory.id}
          resourceName={entryName(modal.entry)}
          onClose={close}
        />
      )}
      {modal?.type === 'publish' && (
        <PublishModal
          open
          dirId={modal.entry.directory.id}
          dirName={modal.entry.directory.name}
          onClose={close}
        />
      )}
    </>
  )
}

export default EntryTable
