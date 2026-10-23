import { useState } from 'react'
import { Modal } from 'antd'
import type { MenuProps } from 'antd'
import { saveAs } from 'file-saver'
import { client, fetchFileContent } from '@/api'
import type { Directory, Entry, FileLock, FileMeta } from '@/api/schema'
import { msg } from '@/components/GlobalMessage'
import { hasPerm, PERM } from '@/lib/perm'
import type { AuthUser } from '@/store/useAuth'

export type ModalTarget =
  | { type: 'rename'; entry: Entry }
  | { type: 'move'; entry: Entry }
  | { type: 'copy'; entry: Entry }
  | { type: 'unlock'; file: FileMeta; lock: FileLock }
  | { type: 'versions'; file: FileMeta }
  | { type: 'grants'; dir: Directory }
  | null

type FileEntry = Extract<Entry, { kind: 'file' }>

/** 目录条目行操作：所有变更均走后端，成功后刷新列表。 */
export function useEntryActions(
  perms: number,
  me: AuthUser,
  onReload: () => void,
) {
  const [modal, setModal] = useState<ModalTarget>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)

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
    msg.success('已移入回收站')
    onReload()
  }

  const doLock = async (file: FileMeta) => {
    const { error } = await client.post('/api/v1/files/{id}/lock', {
      params: { id: file.id },
    })
    if (error) return
    msg.success('已锁定')
    onReload()
  }

  const doUnlock = async (file: FileMeta, force: boolean) => {
    const { error } = await client.post('/api/v1/files/{id}/unlock', {
      params: { id: file.id },
      body: force ? { force: true } : {},
    })
    if (error) return
    msg.success('已解锁')
    setModal(null)
    onReload()
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

  const confirmDelete = (entry: Entry) => {
    const name = entry.kind === 'file' ? entry.file.name : entry.directory.name
    Modal.confirm({
      title: `删除「${name}」`,
      content: '删除后移入回收站，保留 180 天后自动清理。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: () => doDelete(entry),
    })
  }

  const confirmUnlock = (entry: FileEntry) => {
    const { file, lock } = entry
    if (!lock) return
    if (lock.locked_by === me.id) {
      void doUnlock(file, false)
    } else {
      setModal({ type: 'unlock', file, lock })
    }
  }

  const buildFileMenu = (entry: FileEntry): MenuProps['items'] => {
    const { file, lock } = entry
    const items: NonNullable<MenuProps['items']> = []
    if (hasPerm(perms, PERM.DOWNLOAD)) {
      items.push({ key: 'download', label: '下载', onClick: () => void doDownload(file) })
    }
    if (hasPerm(perms, PERM.MODIFY_RENAME)) {
      items.push({ key: 'rename', label: '重命名', onClick: () => openRename(entry) })
    }
    if (hasPerm(perms, PERM.MOVE_COPY)) {
      items.push({ key: 'move', label: '移动', onClick: () => setModal({ type: 'move', entry }) })
      items.push({ key: 'copy', label: '复制', onClick: () => setModal({ type: 'copy', entry }) })
    }
    if (hasPerm(perms, PERM.READ_PREVIEW)) {
      items.push({
        key: 'versions',
        label: '版本历史',
        onClick: () => setModal({ type: 'versions', file }),
      })
      if (!lock) {
        items.push({ key: 'lock', label: '锁定', onClick: () => void doLock(file) })
      } else if (lock.locked_by === me.id || me.role === 'admin') {
        items.push({
          key: 'unlock',
          label: me.role === 'admin' && lock.locked_by !== me.id ? '强制解锁' : '解锁',
          onClick: () => confirmUnlock(entry),
        })
      }
    }
    if (hasPerm(perms, PERM.DELETE_RESTORE)) {
      items.push(
        { type: 'divider' },
        { key: 'delete', label: '删除', danger: true, onClick: () => confirmDelete(entry) },
      )
    }
    return items
  }

  const buildDirMenu = (entry: Extract<Entry, { kind: 'directory' }>): MenuProps['items'] => {
    const { directory } = entry
    const items: NonNullable<MenuProps['items']> = []
    if (hasPerm(perms, PERM.MODIFY_RENAME)) {
      items.push({ key: 'rename', label: '重命名', onClick: () => openRename(entry) })
    }
    if (hasPerm(perms, PERM.MOVE_COPY)) {
      items.push({ key: 'move', label: '移动', onClick: () => setModal({ type: 'move', entry }) })
    }
    if (me.role === 'admin' || directory.created_by === me.id) {
      items.push({
        key: 'grants',
        label: '权限管理',
        onClick: () => setModal({ type: 'grants', dir: directory }),
      })
    }
    if (hasPerm(perms, PERM.DELETE_RESTORE)) {
      items.push(
        { type: 'divider' },
        { key: 'delete', label: '删除', danger: true, onClick: () => confirmDelete(entry) },
      )
    }
    return items
  }

  return {
    modal,
    close,
    renameValue,
    renaming,
    doRename,
    doMove,
    doCopy,
    doLock,
    doUnlock,
    buildFileMenu,
    buildDirMenu,
  }
}
