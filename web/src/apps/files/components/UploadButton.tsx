import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { CheckCircle2, CloudUpload, XCircle } from 'lucide-react'
import { Btn } from '@/components/ui/kit'
import { uploadFile } from '@/lib/upload'

export type UploadButtonHandle = {
  /** 编程式打开文件选择框（供目录空白处右键菜单「上传文件」调用） */
  open: () => void
}

type Task = {
  id: string
  name: string
  percent: number
  status: 'uploading' | 'done' | 'error'
  message?: string
}

type UploadButtonProps = {
  dirId: string
  disabled?: boolean
  onFinished?: () => void
}

/** 上传按钮 + 任务进度列表（支持多文件并发）。 */
const UploadButton = forwardRef<UploadButtonHandle, UploadButtonProps>(
  ({ dirId, disabled, onFinished }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null)
    const [tasks, setTasks] = useState<Task[]>([])

    useImperativeHandle(ref, () => ({ open: () => inputRef.current?.click() }), [])

    const patchTask = (id: string, patch: Partial<Task>) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    }

    const start = (files: FileList | null) => {
      if (!files || files.length === 0) return
      Array.from(files).forEach((file) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        setTasks((prev) => [...prev, { id, name: file.name, percent: 0, status: 'uploading' }])
        uploadFile(dirId, file, (pct) => patchTask(id, { percent: pct })).then((res) => {
          if (res.ok) {
            patchTask(id, { percent: 100, status: 'done' })
            onFinished?.()
          } else {
            patchTask(id, { status: 'error', message: res.message ?? '上传失败' })
          }
        })
      })
      if (inputRef.current) inputRef.current.value = ''
    }

    const hasFinished = tasks.some((t) => t.status !== 'uploading')

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <Btn disabled={disabled} onClick={() => inputRef.current?.click()}>
          <CloudUpload size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          上传文件
        </Btn>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => start(e.target.files)}
        />
        {tasks.length > 0 ? (
          <div
            className="vd-panel"
            style={{
              marginTop: 8,
              width: 300,
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="vd-faint" style={{ fontSize: 12 }}>上传进度</span>
              {hasFinished ? (
                <Btn size="xs" variant="ghost" onClick={() => setTasks((prev) => prev.filter((t) => t.status === 'uploading'))}>
                  清除已完成
                </Btn>
              ) : null}
            </div>
            {tasks.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                {t.status === 'done' ? (
                  <CheckCircle2 size={15} style={{ color: 'var(--vd-accent-success)', flexShrink: 0 }} />
                ) : t.status === 'error' ? (
                  <XCircle size={15} style={{ color: 'var(--vd-accent-danger)', flexShrink: 0 }} />
                ) : (
                  <span className="vd-spin" style={{ width: 14, height: 14, flexShrink: 0 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>
                    {t.name}
                  </div>
                  {t.status === 'error' ? (
                    <div style={{ fontSize: 11, color: 'var(--vd-accent-danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.message}>
                      {t.message}
                    </div>
                  ) : null}
                </div>
                {t.status === 'uploading' ? (
                  <span className="vd-faint" style={{ fontSize: 12, width: 36, textAlign: 'right' }}>{t.percent}%</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  },
)

UploadButton.displayName = 'UploadButton'

export default UploadButton
