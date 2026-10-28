/**
 * 启动台（M5）：全屏模糊遮罩 + 搜索 + 应用网格；Esc / 点击遮罩关闭；带 framer 入场动画。
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search } from 'lucide-react'
import { useAuth } from '@/store/useAuth'
import { tokens } from '@/theme'
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

  const kw = q.trim().toLowerCase()
  const apps = APPS.filter(
    (a) => a.launchable && (!a.adminOnly || isAdmin) && (!kw || a.name.toLowerCase().includes(kw) || a.id.includes(kw)),
  )

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="vd-launchpad"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: tokens.animation.launchpad.duration, ease: tokens.animation.launchpad.ease }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
          <div className="vd-lp-search">
            <Search size={15} />
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
              <motion.button
                key={a.id}
                type="button"
                className="vd-lp-item"
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                onClick={() => { onClose(); onLaunch(a.id) }}
                title={a.desc}
              >
                <span className="vd-lp-icon">{a.icon}</span>
                <span className="vd-lp-label">{a.name}</span>
              </motion.button>
            ))}
            {apps.length === 0 && <div className="vd-lp-empty">未找到匹配的应用</div>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
