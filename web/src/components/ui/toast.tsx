/**
 * 轻提示（替换 antd message）。
 * 模块级 `msg` 保持与原 GlobalMessage 相同的调用 API（error/success/warning/info），
 * 供 api 层等非 React 代码使用；ToastHost 挂在应用根部负责渲染。
 */
import { CircleCheck, CircleAlert, TriangleAlert, Info } from 'lucide-react'
import { useEffect, useState } from 'react'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: number
  type: ToastType
  text: string
}

type Listener = (t: Toast) => void

let seq = 1
const listeners = new Set<Listener>()

function push(type: ToastType, text: string) {
  const t: Toast = { id: seq++, type, text }
  listeners.forEach((l) => l(t))
}

/** 与 antd message 实例 API 兼容的子集 */
export const msg = {
  success: (text: string) => push('success', text),
  error: (text: string) => push('error', text),
  warning: (text: string) => push('warning', text),
  info: (text: string) => push('info', text),
}

const ICONS: Record<ToastType, typeof CircleCheck> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
}

const DEFAULT_MS = 2600

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const onToast = (t: Toast) => {
      setToasts((prev) => [...prev.slice(-3), t])
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id))
      }, DEFAULT_MS)
    }
    listeners.add(onToast)
    return () => {
      listeners.delete(onToast)
    }
  }, [])

  if (toasts.length === 0) return null
  return (
    <div className="vd-toast-root">
      {toasts.map((t) => {
        const Icon = ICONS[t.type]
        return (
          <div key={t.id} className={`vd-toast ${t.type}`}>
            <Icon size={15} />
            <span>{t.text}</span>
          </div>
        )
      })}
    </div>
  )
}
