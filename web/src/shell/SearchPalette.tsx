/**
 * 全局搜索面板（M4）：Spotlight 风格，TopBar 搜索按钮或 Ctrl/Cmd+K 唤起。
 * 全库文件搜索（复用 /api/v1/search）；↑↓ 选择、Enter 打开文件窗口、Esc 关闭。
 * z 序 8900：位于启动台(8000)之上、顶栏(9000)之下。
 */
import { useEffect, useRef, useState } from 'react'
import { useDebounce, useRequest } from 'ahooks'
import { Search } from 'lucide-react'
import { client } from '@/api'
import type { SearchHit } from '@/api/schema'
import FileIcon from '@/components/FileIcon'
import { formatBytes, formatTime } from '@/lib/format'

type Props = {
  open: boolean
  onClose: () => void
  onOpenFile: (fileId: string) => void
}

export default function SearchPalette({ open, onClose, onOpenFile }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const dq = useDebounce(q, { wait: 300 })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const { data, loading } = useRequest(
    async () => {
      const res = await client.get('/api/v1/search', { query: { q: dq, limit: 30 } })
      if (res.error || !res.data) return []
      return res.data as unknown as SearchHit[]
    },
    {
      ready: dq.length > 0,
      refreshDeps: [dq],
      // 查询串变化即重查；面板关闭重开时输入已重置
    },
  )

  const hits = data ?? []

  // 打开时聚焦并重置
  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
      // 等 overlay 挂载后聚焦
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // 窗口级 Esc：输入框未获得焦点时（焦点竞态）也能关闭
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 高亮项滚入可视区
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, hits.length])

  if (!open) return null

  const openHit = (hit: SearchHit) => {
    onOpenFile(hit.id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (hits.length ? (a + 1) % hits.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (hits.length ? (a - 1 + hits.length) % hits.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[active]
      if (hit) openHit(hit)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="vd-search-veil" onMouseDown={onClose}>
      <div className="vd-search-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vd-search-inputrow">
          <Search size={16} className="vd-search-inputicon" />
          <input
            ref={inputRef}
            className="vd-search-input"
            placeholder="搜索文件…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          <kbd className="vd-search-kbd">Esc</kbd>
        </div>

        <div className="vd-search-list" ref={listRef}>
          {dq.length === 0 ? (
            <div className="vd-search-empty">
              输入关键词，跨全库搜索文件名
              <br />
              <span className="vd-search-empty-sub">Ctrl+K 在任意界面唤起 · Enter 打开</span>
            </div>
          ) : loading ? (
            <div className="vd-search-empty">搜索中…</div>
          ) : hits.length === 0 ? (
            <div className="vd-search-empty">未找到与「{dq}」相关的文件</div>
          ) : (
            hits.map((hit, i) => (
              <div
                key={hit.id}
                className={`vd-search-hit${i === active ? ' on' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => openHit(hit)}
              >
                <FileIcon name={hit.name} size={22} />
                <div className="vd-search-hit-main">
                  <div className="vd-search-hit-name">{hit.name}</div>
                  <div className="vd-search-hit-meta">
                    {hit.directoryPath} · {formatBytes(hit.size)} · {formatTime(hit.updatedAt)}
                  </div>
                </div>
                {hit.isPrefixMatch && <span className="vd-search-hit-tag">前缀</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
