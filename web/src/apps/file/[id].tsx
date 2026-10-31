import { useRequest } from 'ahooks'
import { Lock, PenLine, Save, X } from 'lucide-react'
import { useContext, useEffect, useRef, useState } from 'react'
import { client } from '@/api'
import { EDITOR_EDITABLE_EXT, EDITOR_READONLY_EXT } from '@/components/DocEditor'
import FileIcon from '@/components/FileIcon'
import StateView from '@/components/StateView'
import { IconBtn } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { formatBytes, formatDateTime } from '@/lib/format'
import { hasPerm, PERM } from '@/lib/perm'
import { parseZipFileId } from '@/lib/zipEntry'
import { useAuth } from '@/store/useAuth'
import { TitleActionContext } from '@/shell/Window'
import FilePreview from './components/FilePreview'
import { classifyFile, isTextFamily, MAX_TEXT_BYTES } from './components/FileViewer'
import ZipView from './components/ZipView'

type Props = {
  /** 窗口模式：由窗口状态（appState）传入 */
  fileId: string
  onTitleChange?: (name: string) => void
}

/**
 * 文件详情页（M2.7：VentoOS 同款弱化布局）：
 * 无顶部工具栏行 —— 编辑入口/保存/退出编辑/编辑状态全部上移到窗口标题栏右侧
 * （TitleActionContext）；内容区按类型自适应内边距；底部页脚弱化为一行小字
 * （大小 · v版本 · 更新时间）。下载/分享/版本历史/锁定等管理操作保留在
 * 文件管理器的右键菜单中。
 */
const FileDetailPage = ({ fileId, onTitleChange }: Props) => {
  const id = fileId
  /** M2.15：`zip:<zipFileId>@<条目路径>` 虚拟 id → 压缩包内文件只读预览。 */
  const zipRef = parseZipFileId(id)
  const { user } = useAuth()
  const me = user!
  const [editing, setEditing] = useState(false)
  const [entering, setEntering] = useState(false)
  /** 保存中（office 由 DocEditor.onSavingChange 驱动；文本由 textSaveRef 保存函数驱动）。 */
  const [saving, setSaving] = useState(false)
  /** 文本编辑态时由 FilePreview 注入保存函数（标题栏「保存」按钮调用）。 */
  const textSaveRef = useRef<(() => void) | null>(null)
  const setTitleAction = useContext(TitleActionContext)

  const { data, loading, error, refresh } = useRequest(
    async () => {
      if (zipRef) {
        // M2.15：zip 虚拟 id → 从压缩包条目列表合成只读 FileMeta（perms=0 无任何编辑入口）
        const { error: err, data: d } = await client.get('/api/v1/files/{id}/zip', {
          params: { id: zipRef.zipFileId }
        })
        if (err || !d) throw new Error('压缩包不存在或已被删除')
        const entry = d.entries.find((e) => e.name === zipRef.entryPath && !e.is_dir)
        if (!entry) throw new Error('压缩包内不存在该文件')
        return {
          file: {
            id,
            directory_id: 'zip',
            name: entry.name.slice(entry.name.lastIndexOf('/') + 1),
            size: entry.size,
            mime: '',
            current_version: 0,
            created_by: null,
            created_at: entry.modified ?? '',
            updated_at: entry.modified ?? ''
          },
          lock: null,
          my_perms: 0,
          granted_perms: 0
        }
      }
      const {
        error: err,
        data: d,
        response
      } = await client.get('/api/v1/files/{id}', {
        params: { id }
      })
      if (err || !d) {
        if (response?.status === 403) throw new Error('no-perm')
        throw new Error('文件不存在或已被删除')
      }
      return d
    },
    { refreshDeps: [id] }
  )

  const file = data?.file ?? null
  const lock = data?.lock ?? null

  // 窗口模式：把文件名同步到窗口标题栏
  useEffect(() => {
    if (file?.name) onTitleChange?.(file.name)
  }, [file?.name])
  // M2.36：UI 显隐按授权权限位（不含管理员旁路；后端对创建者恒返回 1023）
  const perms = data?.granted_perms ?? 0
  const isLockOwner = !!lock && lock.locked_by === me.id

  const ext = file?.name.includes('.') ? ((file.name.split('.').pop() ?? '').toLowerCase() as string) : ''
  const isOffice = !!file && (EDITOR_EDITABLE_EXT.has(ext) || EDITOR_READONLY_EXT.has(ext))
  const viewerKind = file ? classifyFile(file.name) : null
  /** M2.15：真实 .zip 文件 → 包内列表（ZipView）；虚拟 id → zip 内条目只读预览。 */
  const isZipReal = ext === 'zip'
  /** Office 在线编辑入口。 */
  const canOfficeEdit = hasPerm(perms, PERM.MODIFY_RENAME) && EDITOR_EDITABLE_EXT.has(ext)
  /** 文本族（txt/md/代码等）内联编辑入口：非 Office、≤4MB、有修改权限。 */
  const canTextEdit =
    !!file &&
    !isOffice &&
    isTextFamily(viewerKind!) &&
    hasPerm(perms, PERM.MODIFY_RENAME) &&
    file.size <= MAX_TEXT_BYTES
  /** 编辑入口：有修改权限且文件未被他人锁定。 */
  const canEnterEdit = (canOfficeEdit || canTextEdit) && (!lock || isLockOwner)

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
        params: { id: file.id }
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

  /** 退出编辑：仅退出编辑模式，不释放锁（窗口关闭时自动释放）。 */
  const doExitEdit = () => {
    setEditing(false)
  }

  // 窗口关闭/离开详情页时，若仍持有自己加的编辑锁则释放，避免遗留锁。
  // 注意：不要求 editing===true —— 保存成功后用户仍处于编辑模式之外但锁
  // 仍在自己手里（保存不释放锁），若以 editing 为条件会在「保存→关窗」
  // 路径漏解锁（e2e 实测 sample.docx 遗留锁即此原因）。
  const lockStateRef = useRef<{ fileId: string | null; isLockOwner: boolean }>({
    fileId: null,
    isLockOwner: false
  })
  lockStateRef.current = { fileId: file?.id ?? null, isLockOwner }
  useEffect(() => {
    return () => {
      const s = lockStateRef.current
      if (s.fileId && s.isLockOwner) {
        void client.post('/api/v1/files/{id}/unlock', { params: { id: s.fileId } })
      }
    }
  }, [])

  const state: 'loading' | 'error' | 'empty' | 'noPerm' | 'ready' =
    loading || !file ? 'loading' : error?.message === 'no-perm' ? 'noPerm' : error ? 'error' : 'ready'

  // ── 标题栏右侧动作区（M2.7：替代原工具栏行）────────────────────
  const titleActionNode = (() => {
    if (!file || state !== 'ready') return null
    if (!editing && (canOfficeEdit || canTextEdit)) {
      // M2.8：纯图标 + tooltip（title 承载动作名；被他人锁定时 tooltip 说明原因）
      return (
        <IconBtn
          disabled={!canEnterEdit || entering}
          title={canEnterEdit ? (isOffice ? '进入编辑' : '编辑') : `文件正由 ${lock?.locked_by_name ?? '他人'} 锁定`}
          onClick={doEnterEdit}
        >
          <PenLine size={15} />
        </IconBtn>
      )
    }
    if (editing) {
      return (
        <>
          <span className="vd-titlebar-status">
            {saving ? '正在保存…' : `正在编辑 v${file.current_version}`}
          </span>
          {canTextEdit && (
            <IconBtn
              disabled={saving}
              title={saving ? '正在保存…' : '保存'}
              onClick={() => textSaveRef.current?.()}
            >
              <Save size={15} />
            </IconBtn>
          )}
          <IconBtn disabled={saving} title="退出编辑" onClick={doExitEdit}>
            <X size={15} />
          </IconBtn>
        </>
      )
    }
    return null
  })()
  useEffect(() => {
    if (!setTitleAction) return
    setTitleAction(titleActionNode)
    return () => setTitleAction(null)
  })

  // 内容区内边距按查看器类型自适应（M2.7：无统一 padding）；zip 列表自管理布局
  const contentExtra =
    isZipReal
      ? ''
      : viewerKind && isTextFamily(viewerKind)
        ? ' vd-file-content--text'
        : viewerKind === 'binary'
          ? ' vd-file-content--hex'
          : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StateView
        state={state}
        retry={refresh}
        errorText={error && error.message !== 'no-perm' ? error.message : undefined}
      >
        {file && (
          <div className="flex min-h-0 flex-1 flex-col">
            {lock && (
              <div
                className="vd-panel"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  fontSize: 12.5,
                  color: 'var(--vd-accent-warning)'
                }}
              >
                <Lock size={14} style={{ flexShrink: 0 }} />
                <span>
                  文件正由 {lock.locked_by_name} 锁定（{formatDateTime(lock.locked_at)}），锁定期间仅管理员可强制解除
                </span>
              </div>
            )}
            <div className={`vd-file-content${contentExtra}`}>
              {isZipReal ? (
                <ZipView zipFileId={file.id} zipName={file.name} />
              ) : zipRef && isOffice ? (
                <div className="flex flex-col items-center gap-12px py-80px">
                  <FileIcon name={file.name} size={48} />
                  <div style={{ fontSize: 14, color: 'var(--vd-text-secondary)' }}>
                    压缩包内的 Office 文件暂不支持在线预览，请下载压缩包后本地打开
                  </div>
                </div>
              ) : (
                <FilePreview
                  file={file}
                  editable={editing && (canOfficeEdit || canTextEdit)}
                  onExitEdit={doExitEdit}
                  onSaved={() => {
                    setEditing(false)
                    refresh()
                  }}
                  onReload={refresh}
                  textSaveRef={textSaveRef}
                  onSavingChange={setSaving}
                />
              )}
            </div>
            <div className="vd-viewer-footer">
              <span>
                {zipRef || isZipReal
                  ? `压缩包${zipRef ? '条目' : ''} · ${formatBytes(file.size)}`
                  : `${formatBytes(file.size)} · v${file.current_version} · ${formatDateTime(file.updated_at)}`}
              </span>
            </div>
          </div>
        )}
      </StateView>
    </div>
  )
}

export default FileDetailPage
