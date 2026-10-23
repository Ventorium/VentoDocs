import { useRef, useState } from 'react'
import { Button, Progress } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, CloudUploadOutlined } from '@ant-design/icons'
import { uploadFile } from '@/lib/upload'

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
const UploadButton = ({ dirId, disabled, onFinished }: UploadButtonProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [tasks, setTasks] = useState<Task[]>([])

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
    <div className="flex flex-col items-end">
      <Button
        icon={<CloudUploadOutlined />}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        上传文件
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => start(e.target.files)}
      />
      {tasks.length > 0 && (
        <div className="mt-8px w-300px rounded-6px bg-#F7F8FA p-8px flex flex-col gap-4px shadow-1px-2px-8px-rgba(0,0,0,0.06)">
          <div className="flex items-center justify-between">
            <span className="text-12px text-#6B7280">上传进度</span>
            {hasFinished && (
              <Button
                type="link"
                size="small"
                className="!px-0"
                onClick={() => setTasks((prev) => prev.filter((t) => t.status === 'uploading'))}
              >
                清除已完成
              </Button>
            )}
          </div>
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-6px min-w-0">
              {t.status === 'done' ? (
                <CheckCircleFilled className="text-#16A34A flex-shrink-0" />
              ) : t.status === 'error' ? (
                <CloseCircleFilled className="text-#DC2626 flex-shrink-0" />
              ) : (
                <Progress
                  type="circle"
                  size={16}
                  percent={t.percent}
                  showInfo={false}
                  strokeWidth={6}
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-12px truncate" title={t.name}>
                  {t.name}
                </div>
                {t.status === 'error' && (
                  <div className="text-11px text-#DC2626 truncate" title={t.message}>
                    {t.message}
                  </div>
                )}
              </div>
              {t.status === 'uploading' && (
                <span className="text-12px text-#6B7280 w-36px text-right">{t.percent}%</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default UploadButton
