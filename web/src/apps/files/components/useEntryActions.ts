import { useState } from 'react'
import { saveAs } from 'file-saver'
import { client, fetchFileContent } from '@/api'
import type { Directory, Entry, FileLock, FileMeta } from '@/api/schema'
import { msg } from '@/components/ui/toast'
import type { DropItem } from '@/components/ui/kit'
import { hasPerm, PERM } from '@/lib/perm'
import type { AuthUser } from '@/store/useAuth'

export type ModalTarget =
  | { type: 'rename'; entry: Entry }
  | { type: 'move'; entry: Entry }
  | { type: 'copy'; entry: Entry }
  | { type: 'delete'; entry: Entry }
  | { type: 'delete-many'; entries: Entry[] }
  | { type: 'share'; entry: Entry }
  | { type: 'publish'; entry: Extract<Entry, { kind: 'directory' }> }
  | { type: 'unlock'; file: FileMeta; lock: FileLock }
  | { type: 'versions'; file: FileMeta }
  | { type: 'grants'; dir: Directory }
  | { type: 'file-grants'; file: FileMeta; dir: Directory }
  | null

type FileEntry = Extract<Entry, { kind: 'file' }>
type DirEntry = Extract<Entry, { kind: 'directory' }>

/**
 * 菜单动作接口（M2.7）：纯菜单构建器只依赖 perms/me + 本接口回调，
 * EntryTable（旧表格）与 ColumnView（多列导航）各自注入自己的动作实现。
 */
export type EntryMenuActions = {
  download: (file: FileMeta) => void
  share: (entry: Entry) => void
  rename: (entry: Entry) => void
  move: (entry: Entry) => void
  copy: (entry: Entry) => void
  versions: (file: FileMeta) => void
  lock: (file: FileMeta) => void
  /** force=true（管理员解锁他人）由调用方弹确认框后执行 */
  unlock: (file: FileMeta, lock: FileLock, force: boolean) => void
  deleteEntry: (entry: Entry) => void
  /** 权限管理：传 Directory（目录菜单）或 { id, file? }（文件菜单，需先取目录并校验管理者身份；带 file 时打开文件级权限）。 */
  grants: (dir: Directory | { id: string; file?: FileMeta }) => void
  publish: (entry: DirEntry) => void
}

/** 纯函数：文件条目右键菜单项布局（与 useEntryActions 原 buildFileMenu 一致）。 */
export function fileMenuItems(
  perms: number,
  me: AuthUser,
  entry: FileEntry,
  a: EntryMenuActions,
): DropItem[] {
  const { file, lock } = entry
  const items: DropItem[] = []
  if (hasPerm(perms, PERM.DOWNLOAD)) {
    items.push({ key: 'download', label: '下载', onClick: () => a.download(file) })
  }
  // M2.35: 分享不再按权限位委派，仅文件创建者本人可分享
  if (file.created_by === me.id) {
    items.push({ key: 'share', label: '分享', onClick: () => a.share(entry) })
  }
  // M2.18: 文件也提供「权限管理」。M2.23: 带 file 打开文件级权限（本文件独立授权，覆盖所在目录继承权限）。
  // M2.35: 无管理员旁路——仅文件创建者可管理该文件的授权。
  if (file.created_by === me.id) {
    items.push({ key: 'grants', label: '权限管理', onClick: () => a.grants({ id: file.directory_id, file }) })
  }
  if (hasPerm(perms, PERM.MODIFY_RENAME)) {
    items.push({ key: 'rename', label: '重命名', onClick: () => a.rename(entry) })
  }
  if (hasPerm(perms, PERM.MOVE_COPY)) {
    items.push({ key: 'move', label: '移动', onClick: () => a.move(entry) })
    items.push({ key: 'copy', label: '复制', onClick: () => a.copy(entry) })
  }
  if (hasPerm(perms, PERM.READ_PREVIEW)) {
    items.push({ key: 'versions', label: '版本历史', onClick: () => a.versions(file) })
    if (!lock) {
      items.push({ key: 'lock', label: '锁定', onClick: () => a.lock(file) })
    } else if (lock.locked_by === me.id || me.role === 'admin') {
      const force = me.role === 'admin' && lock.locked_by !== me.id
      items.push({
        key: 'unlock',
        label: force ? '强制解锁' : '解锁',
        danger: force,
        onClick: () => a.unlock(file, lock, force),
      })
    }
  }
  if (hasPerm(perms, PERM.DELETE_RESTORE)) {
    items.push(
      { key: 'divider-del', label: '', divider: true },
      { key: 'delete', label: '删除', danger: true, onClick: () => a.deleteEntry(entry) },
    )
  }
  return items
}

/** 纯函数：目录条目右键菜单项布局（与 useEntryActions 原 buildDirMenu 一致）。 */
export function dirMenuItems(
  perms: number,
  me: AuthUser,
  entry: DirEntry,
  a: EntryMenuActions,
): DropItem[] {
  const { directory } = entry
  const items: DropItem[] = []
  if (hasPerm(perms, PERM.MODIFY_RENAME)) {
    items.push({ key: 'rename', label: '重命名', onClick: () => a.rename(entry) })
  }
  if (hasPerm(perms, PERM.MOVE_COPY)) {
    items.push({ key: 'move', label: '移动', onClick: () => a.move(entry) })
  }
  // M2.35: 分享不再按权限位委派，仅目录创建者本人可分享
  if (directory.created_by === me.id) {
    items.push({ key: 'share', label: '分享', onClick: () => a.share(entry) })
  }
  // M2.35: 发布为网站仅目录创建者（无管理员旁路）
  if (directory.created_by === me.id) {
    items.push({ key: 'publish', label: '发布为网站', onClick: () => a.publish(entry) })
  }
  // M2.35: 无管理员旁路——仅目录创建者可管理该目录的授权
  if (directory.created_by === me.id) {
    items.push({
      key: 'grants',
      label: '权限管理',
      onClick: () => a.grants(directory),
    })
  }
  if (hasPerm(perms, PERM.DELETE_RESTORE)) {
    items.push(
      { key: 'divider-del', label: '', divider: true },
      { key: 'delete', label: '删除', danger: true, onClick: () => a.deleteEntry(entry) },
    )
  }
  return items
}

/** 目录条目行操作：所有变更均走后端，成功后刷新列表。 */
export function useEntryActions(
  perms: number,
  me: AuthUser,
  onReload: () => void,
) {
  const [modal, setModal] = useState<ModalTarget>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const close = () => setModal(null)

  const openRename = (entry: Entry) => {
    const name = entry.kind === 'file' ? entry.file.name : entry.directory.name
    setRenameValue(name)
    setModal({ type: 'rename', entry })
  }

  const doRename = async (name: string) => {
    if (modal?.type !== 'rename') return
    const entry = modal.entry
    setRenaming(true)
    if (entry.kind === 'file') {
      const { error } = await client.post('/api/v1/files/{id}/rename', {
        params: { id: entry.file.id },
        body: { new_name: name },
      })
      if (error) {
        setRenaming(false)
        return
      }
    } else {
      const { error } = await client.post('/api/v1/directories/{id}/rename', {
        params: { id: entry.directory.id },
        body: { name },
      })
      if (error) {
        setRenaming(false)
        return
      }
    }
    setRenaming(false)
    setModal(null)
    msg.success('已重命名')
    onReload()
  }

  const doMove = async (targetDirId: string) => {
    if (modal?.type !== 'move') return
    const entry = modal.entry
    if (entry.kind === 'file') {
      const { error } = await client.post('/api/v1/files/{id}/move', {
        params: { id: entry.file.id },
        body: { target_directory_id: targetDirId },
      })
      if (error) return
    } else {
      const { error } = await client.post('/api/v1/directories/{id}/move', {
        params: { id: entry.directory.id },
        body: { target_parent_id: targetDirId },
      })
      if (error) return
    }
    setModal(null)
    msg.success('已移动')
    onReload()
  }

  const doCopy = async (targetDirId: string, newName?: string) => {
    if (modal?.type !== 'copy') return
    const entry = modal.entry
    if (entry.kind !== 'file') return
    const body: { target_directory_id: string; new_name?: string } = {
      target_directory_id: targetDirId,
    }
    if (newName) body.new_name = newName
    const { error } = await client.post('/api/v1/files/{id}/copy', {
      params: { id: entry.file.id },
      body,
    })
    if (error) return
    setModal(null)
    msg.success('已复制')
    onReload()
  }

  const doDelete = async (entry: Entry) => {
    if (entry.kind === 'file') {
      const { error } = await client.delete('/api/v1/files/{id}', {
        params: { id: entry.file.id },
      })
      if (error) return
    } else {
      const { error } = await client.delete('/api/v1/directories/{id}', {
        params: { id: entry.directory.id },
      })
      if (error) return
    }
    msg.success('已移至回收站')
    onReload()
  }

  const confirmDelete = (entry: Entry) => {
    setModal({ type: 'delete', entry })
  }

  /** Cmd/Ctrl 多选后右键「删除所选 N 项」。 */
  const confirmDeleteMany = (entries: Entry[]) => {
    setModal({ type: 'delete-many', entries })
  }

  const doConfirmDeleteMany = async () => {
    if (modal?.type !== 'delete-many') return
    const entries = modal.entries
    setDeleting(true)
    for (const entry of entries) {
      await doDelete(entry)
    }
    setDeleting(false)
    setModal(null)
  }

  const doConfirmDelete = async () => {
    if (modal?.type !== 'delete') return
    const entry = modal.entry
    setDeleting(true)
    await doDelete(entry)
    setDeleting(false)
    setModal(null)
  }

  const doDownload = async (file: FileMeta) => {
    try {
      const resp = await fetchFileContent(file.id)
      const blob = await resp.blob()
      saveAs(blob, file.name)
    } catch {
      // fetchFileContent 内部已提示错误
    }
  }

  const doLock = async (file: FileMeta) => {
    const { error } = await client.post('/api/v1/files/{id}/lock', {
      params: { id: file.id },
    })
    if (error) return
    msg.success('已锁定')
    onReload()
  }

  const doUnlock = async (file: FileMeta, force = false) => {
    const { error } = await client.post('/api/v1/files/{id}/unlock', {
      params: { id: file.id },
      query: { force },
    })
    if (error) return
    msg.success('已解锁')
    onReload()
  }

  // M2.18: 从文件菜单打开权限管理——只有 directory_id，先取目录再校验管理者身份。
  // M2.23: ref.file 存在时打开文件级权限管理（file-grants）。
  const openGrants = async (ref: Directory | { id: string; file?: FileMeta }) => {
    let dir: Directory
    if ('name' in ref) {
      dir = ref
    } else {
      const { data, error } = await client.get('/api/v1/directories/{id}', { params: { id: ref.id } })
      if (error || !data) return
      dir = data.directory
    }
    // M2.35: 无管理员旁路——仅目录创建者可管理授权
    if (dir.created_by !== me.id) {
      msg.error('仅目录创建者可管理该目录的授权')
      return
    }
    if (ref.file) setModal({ type: 'file-grants', file: ref.file, dir })
    else setModal({ type: 'grants', dir })
  }

  const menuActions: EntryMenuActions = {
    download: (file) => void doDownload(file),
    share: (entry) => setModal({ type: 'share', entry }),
    rename: (entry) => openRename(entry),
    move: (entry) => setModal({ type: 'move', entry }),
    copy: (entry) => setModal({ type: 'copy', entry }),
    versions: (file) => setModal({ type: 'versions', file }),
    lock: (file) => void doLock(file),
    unlock: (file, lock, force) => {
      if (force) setModal({ type: 'unlock', file, lock })
      else void doUnlock(file, false)
    },
    deleteEntry: (entry) => confirmDelete(entry),
    grants: (dir) => void openGrants(dir),
    publish: (entry) => setModal({ type: 'publish', entry }),
  }

  const buildFileMenu = (entry: FileEntry): DropItem[] => fileMenuItems(perms, me, entry, menuActions)
  const buildDirMenu = (entry: DirEntry): DropItem[] => dirMenuItems(perms, me, entry, menuActions)

  return {
    modal,
    close,
    renameValue,
    renaming,
    deleting,
    doRename,
    doMove,
    doCopy,
    doUnlock,
    confirmDelete,
    confirmDeleteMany,
    doConfirmDelete,
    doConfirmDeleteMany,
    buildFileMenu,
    buildDirMenu,
    menuActions,
    openModal: setModal,
  }
}
