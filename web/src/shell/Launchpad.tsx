/**
 * 启动台（M2）：全屏模糊遮罩 + 搜索 + 应用网格；Esc / 点击遮罩关闭。
 */
import { useEffect, useState } from 'react'
import { SearchOutlined } from '@ant-design/icons'
import { useAuth } from '@/store/useAuth'
import { APPS } from './apps/registry'

type Props = {
  open: boolean
  onClose: () => void
  onLaunch: (appId: string) => void
}

export default function Launchpad({ open, onClose, onLaunch }: Props) {
  const [q, setQ] = useState('')
  const isAdmin = useAuth((s) => s.user?.role === 'admin')

  useEffect(() => {
    if (!open) return
    setQ('')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const kw = q.trim().toLowerCase()
  const apps = APPS.filter(
    (a) => a.launchable && (!a.adminOnly || isAdmin) && (!kw || a.name.toLowerCase().includes(kw) || a.id.includes(kw)),
  )

  return (
    <div className="vd-launchpad" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="vd-lp-search">
        <SearchOutlined />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索应用"
          autoFocus
          spellCheck={false}
        />
      </div>
      <div className="vd-lp-grid">
        {apps.map((a) => (
          <button key={a.id} type="button" className="vd-lp-item" onClick={() => { onClose(); onLaunch(a.id) }} title={a.desc}>
            <span className="vd-lp-icon">{a.icon}</span>
            <span className="vd-lp-label">{a.name}</span>
          </button>
        ))}
        {apps.length === 0 && <div className="vd-lp-empty">未找到匹配的应用</div>}
      </div>
    </div>
  )
}
