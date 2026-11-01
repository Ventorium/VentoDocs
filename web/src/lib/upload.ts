import { getAccessToken } from '@/store/token'
import { useAuth } from '@/store/useAuth'
import { formatBytes } from '@/lib/format'

export type UploadProgress = (percent: number) => void

export type UploadResult = {
  ok: boolean
  fileName?: string
  message?: string
  /** 后端 NameConflict 时返回 409 与 detail。 */
  conflict?: boolean
}

/**
 * 单文件 XHR 上传到 `POST /api/v1/directories/{dirId}/files`，
 * 支持进度回调（fetch 无法读取上传进度）。
 */
export function uploadFile(
  dirId: string,
  file: File,
  onProgress?: UploadProgress,
): Promise<UploadResult> {
  // 配额预检（M2.43）：超配额时不必把整个文件传上去再被服务端拒绝。
  // `used_bytes` 是登录时/最近一次刷新的快照，服务端仍是最终裁决方。
  const me = useAuth.getState().user
  if (me?.quota_bytes != null && typeof me.used_bytes === 'number') {
    const remaining = me.quota_bytes - me.used_bytes
    if (file.size > remaining) {
      return Promise.resolve({
        ok: false,
        fileName: file.name,
        message: `已超出个人存储配额（剩余 ${formatBytes(Math.max(remaining, 0))}，文件 ${formatBytes(file.size)}）`,
      })
    }
  }

  return new Promise((resolve) => {
    const form = new FormData()
    form.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/v1/directories/${dirId}/files`)
    const token = getAccessToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true, fileName: file.name })
        return
      }
      if (xhr.status === 409) {
        resolve({ ok: false, fileName: file.name, conflict: true, message: `「${file.name}」已存在` })
        return
      }
      let message = `上传失败（HTTP ${xhr.status}）`
      try {
        const body = JSON.parse(xhr.responseText)
        if (body?.error?.message) message = body.error.message
      } catch {
        // 保留默认提示
      }
      resolve({ ok: false, fileName: file.name, message })
    }
    xhr.onerror = () =>
      resolve({
        ok: false,
        fileName: file.name,
        message: '上传中断：可能已超出个人存储配额或单文件大小上限',
      })
    xhr.send(form)
  })
}
