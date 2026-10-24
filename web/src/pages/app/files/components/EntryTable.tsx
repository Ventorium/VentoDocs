import { useNavigate } from 'react-router'
import { Button, Dropdown, Modal, Table, Tag } from 'antd'
import { LockOutlined, MoreOutlined } from '@ant-design/icons'
import type { DirectoryPage, Entry } from '@/api/schema'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import RenameModal from '@/components/RenameModal'
import VersionsDrawer from '@/components/VersionsDrawer'
import MoveCopyModal from './MoveCopyModal'
import GrantsModal from './GrantsModal'
import ShareModal from './ShareModal'
import PublishModal from './PublishModal'
import { useEntryActions } from './useEntryActions'
import { formatBytes, formatTime } from '@/lib/format'
import type { AuthUser } from '@/store/useAuth'

type EntryTableProps = {
  page: DirectoryPage
  me: AuthUser
  onReload: () => void
}

/** 目录条目表格：行内菜单按权限位门控，行操作逻辑见 useEntryActions。 */
const EntryTable = ({ page, me, onReload }: EntryTableProps) => {
  const navigate = useNavigate()
  const {
    modal,
    close,
    renameValue,
    renaming,
    doRename,
    doMove,
    doCopy,
    doUnlock,
    buildFileMenu,
    buildDirMenu,
  } = useEntryActions(page.my_perms, me, onReload)

  const entryId = (r: Entry) => (r.kind === 'file' ? r.file.id : r.directory.id)
  const entryName = (r: Entry) => (r.kind === 'file' ? r.file.name : r.directory.name)

  return (
    <>
      <Table<Entry>
        rowKey={entryId}
        size="middle"
        dataSource={page.children}
        pagination={false}
        onRow={(r) => ({
          // 仅当点击目标在行内 DOM 中才导航：行内弹层（Dropdown 菜单 / Popconfirm /
          // Select 等）挂载在 body 级 portal，其 React 合成事件会沿组件树冒泡到 <tr>，
          // 但原生 target 不在行内，据此区分，避免点菜单项误触发整行跳转。
          onClick: (e) => {
            if (e.currentTarget.contains(e.target as Node) && r.kind === 'file') {
              navigate(`/app/file/${r.file.id}`)
            }
          },
          onDoubleClick: (e) => {
            if (e.currentTarget.contains(e.target as Node) && r.kind === 'directory') {
              navigate(`/app/files/${r.directory.id}`)
            }
          },
          style: { cursor: 'pointer' },
        })}
        columns={[
          {
            title: '名称',
            key: 'name',
            render: (_, r) =>
              r.kind === 'file' ? (
                <span className="flex items-center gap-8px min-w-0">
                  <FileIcon name={r.file.name} size={18} />
                  <span className="truncate">{r.file.name}</span>
                </span>
              ) : (
                <span className="flex items-center gap-8px min-w-0">
                  <FolderIcon size={18} />
                  <span className="truncate">{r.directory.name}</span>
                </span>
              ),
          },
          {
            title: '大小',
            key: 'size',
            width: 100,
            render: (_, r) => (r.kind === 'file' ? formatBytes(r.file.size) : '—'),
          },
          {
            title: '更新时间',
            key: 'time',
            width: 150,
            render: (_, r) =>
              r.kind === 'file' ? formatTime(r.file.updated_at) : formatTime(r.directory.created_at),
          },
          {
            title: '状态',
            key: 'status',
            width: 140,
            render: (_, r) =>
              r.kind === 'file' && r.lock ? (
                <Tag color="orange" icon={<LockOutlined />}>
                  {r.lock.locked_by_name}
                </Tag>
              ) : (
                <span className="text-12px text-#9CA3AF">—</span>
              ),
          },
          {
            title: '',
            key: 'op',
            width: 48,
            render: (_, r) => (
              <Dropdown
                menu={{ items: r.kind === 'file' ? buildFileMenu(r) : buildDirMenu(r) }}
                trigger={['click']}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<MoreOutlined />}
                  onClick={(e) => e.stopPropagation()}
                />
              </Dropdown>
            ),
          },
        ]}
      />

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
      {modal?.type === 'unlock' && (
        <Modal
          open
          title="强制解锁"
          okText="强制解锁"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onOk={() => void doUnlock(modal.file, true)}
          onCancel={close}
        >
          <p className="py-6px m-0">
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
