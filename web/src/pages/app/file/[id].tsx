import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useRequest } from 'ahooks'
import { Alert, Button, Modal, Space, Tooltip } from 'antd'
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  LockOutlined,
  UnlockOutlined,
} from '@ant-design/icons'
import { saveAs } from 'file-saver'
import { client, fetchFileContent } from '@/api'
import { msg } from '@/components/GlobalMessage'
import FileIcon from '@/components/FileIcon'
import StateView from '@/components/StateView'
import VersionsDrawer from '@/components/VersionsDrawer'
import { formatBytes, formatDateTime } from '@/lib/format'
import { hasPerm, PERM } from '@/lib/perm'
import { useAuth } from '@/store/useAuth'
import FilePreview from './components/FilePreview'

/** 支持在线编辑的扩展名（其余类型只读预览）。 */
const EDITABLE_EXT = new Set(['xlsx', 'docx'])

/** 文件详情页：元数据 + 锁定状态 + 预览 + 在线编辑 + 下载 + 版本历史。 */
const FileDetailPage = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user!
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [entering, setEntering] = useState(false)

  const { data, loading, error, refresh } = useRequest(
    async () => {
      const { error: err, data: d, response } = await client.get('/api/v1/files/{id}', {
        params: { id: id! },
      })
      if (err || !d) {
        if (response?.status === 403) throw new Error('no-perm')
        throw new Error('文件不存在或已被删除')
      }
      return d
    },
    { refreshDeps: [id] },
  )

  const file = data?.file ?? null
  const lock = data?.lock ?? null
  const perms = data?.my_perms ?? 0

  const canDownload = hasPerm(perms, PERM.DOWNLOAD)
  const canManageLock = hasPerm(perms, PERM.READ_PREVIEW)
  const isLockOwner = !!lock && lock.locked_by === me.id
  const isAdmin = me.role === 'admin'
  const ext = file?.name.includes('.')
    ? ((file.name.split('.').pop() ?? '').toLowerCase() as string)
    : ''
  const canEdit = hasPerm(perms, PERM.MODIFY_RENAME) && EDITABLE_EXT.has(ext)
  /** 编辑入口：有修改权限且文件未被他人锁定。 */
  const canEnterEdit = canEdit && (!lock || isLockOwner)

  const doDownload = async () => {
    if (!file) return
    try {
      const res = await fetchFileContent(file.id)
      saveAs(await res.blob(), file.name)
    } catch {
      msg.error('下载失败')
    }
  }

  const doLock = async () => {
    if (!file) return
    const { error: err, response } = await client.post('/api/v1/files/{id}/lock', {
      params: { id: file.id },
    })
    if (err) {
      if (response?.status === 409) msg.warning('文件已被锁定，无法重复锁定')
      return
    }
    msg.success('文件已锁定')
    refresh()
  }

  const runUnlock = async (force: boolean) => {
    if (!file) return
    const { error: err } = await client.post('/api/v1/files/{id}/unlock', {
      params: { id: file.id },
      body: force ? { force: true } : {},
    })
    if (err) return
    msg.success('文件已解锁')
    refresh()
  }

  /** 进入编辑：自己已锁直接编辑；未锁则自动加锁后编辑。 */
  const doEnterEdit = async () => {
    if (!file || editing || !canEnterEdit) return
    if (isLockOwner) {
      setEditing(true)
      return
    }
    setEntering(true)
    try {
      const { error: err, response } = await client.post('/api/v1/files/{id}/lock', {
        params: { id: file.id },
      })
      if (err) {
        if (response?.status === 409) msg.warning('文件已被他人锁定，无法进入编辑')
        return
      }
      setEditing(true)
      refresh()
    } finally {
      setEntering(false)
    }
  }

  /** 退出编辑：仅退出编辑模式，不释放锁（手动解锁/管理员强制解锁）。 */
  const doExitEdit = () => {
    setEditing(false)
  }

  const doUnlock = (force: boolean) => {
    if (!file) return
    if (force) {
      Modal.confirm({
        title: '管理员强制解锁',
        content: `该文件正由 ${lock?.locked_by_name ?? '其他用户'} 锁定，确定强制解锁吗？`,
        okText: '强制解锁',
        onOk: () => runUnlock(true),
      })
      return
    }
    void runUnlock(false)
  }

  const state: 'loading' | 'error' | 'empty' | 'noPerm' | 'ready' =
    loading || !file
      ? 'loading'
      : error?.message === 'no-perm'
        ? 'noPerm'
        : error
          ? 'error'
          : 'ready'

  return (
    <div className="flex flex-col gap-12px">
      <div className="flex items-center justify-between gap-12px">
        <div className="flex min-w-0 items-center gap-8px">
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/app/files')}
          >
            返回
          </Button>
          <FileIcon name={file?.name ?? ''} size={20} />
          <span className="truncate text-16px font-600">{file?.name ?? '文件详情'}</span>
        </div>
        {file && (
          <Space>
            {canDownload && (
              <Button icon={<DownloadOutlined />} onClick={doDownload}>
                下载
              </Button>
            )}
            {canEdit && !editing && (
              <Tooltip
                title={canEnterEdit ? undefined : `文件正由 ${lock?.locked_by_name ?? '他人'} 锁定`}
              >
                <Button
                  type="primary"
                  icon={<EditOutlined />}
                  loading={entering}
                  disabled={!canEnterEdit}
                  onClick={doEnterEdit}
                >
                  进入编辑
                </Button>
              </Tooltip>
            )}
            {canManageLock && !lock && (
              <Button icon={<LockOutlined />} onClick={doLock}>
                锁定
              </Button>
            )}
            {canManageLock && lock && isLockOwner && (
              <Button icon={<UnlockOutlined />} onClick={() => doUnlock(false)}>
                解锁
              </Button>
            )}
            {canManageLock && lock && !isLockOwner && isAdmin && (
              <Button icon={<UnlockOutlined />} onClick={() => doUnlock(true)}>
                强制解锁
              </Button>
            )}
            {canManageLock && (
              <Button icon={<HistoryOutlined />} onClick={() => setVersionsOpen(true)}>
                版本历史
              </Button>
            )}
          </Space>
        )}
      </div>

      <StateView
        state={state}
        retry={refresh}
        errorText={error && error.message !== 'no-perm' ? error.message : undefined}
      >
        {file && (
          <div className="flex flex-col gap-12px">
            {lock && (
              <Alert
                type="warning"
                showIcon
                message={`文件正由 ${lock.locked_by_name} 锁定（${formatDateTime(lock.locked_at)}），锁定期间仅管理员可强制解除`}
              />
            )}
            <div className="flex flex-wrap items-center gap-24px rounded-8px border-1px border-#E5E7EB bg-white px-16px py-8px text-13px text-rgba(0,0,0,0.65)">
              <span>大小：{formatBytes(file.size)}</span>
              <span>当前版本：v{file.current_version}</span>
              <span>创建时间：{formatDateTime(file.created_at)}</span>
              <span>更新时间：{formatDateTime(file.updated_at)}</span>
            </div>
            <div className="rounded-8px border-1px border-#E5E7EB bg-white p-16px">
              <FilePreview
                file={file}
                onDownload={doDownload}
                editable={editing && canEdit}
                onExitEdit={doExitEdit}
                onSaved={() => {
                  setEditing(false)
                  refresh()
                }}
              />
            </div>
          </div>
        )}
      </StateView>

      <VersionsDrawer
        open={versionsOpen}
        fileId={file?.id ?? null}
        fileName={file?.name}
        onClose={() => setVersionsOpen(false)}
      />
    </div>
  )
}

export default FileDetailPage
