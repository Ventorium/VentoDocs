import { useState } from 'react'
import { useDebounce, useRequest } from 'ahooks'
import { client } from '@/api'
import type { SearchHit } from '@/api/schema'
import FileIcon from '@/components/FileIcon'
import StateView from '@/components/StateView'
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'

type SearchResultsProps = {
  /** 当前关键词（已 trim）。内部再做 350ms 防抖后请求。 */
  q: string
  onOpenFile: (fileId: string) => void
}

/**
 * 全库搜索结果表（内嵌在文件管理器主区域，取代独立搜索页）。
 * 行单击仅选中，双击打开文件详情窗口；清空工具栏搜索框即回到目录浏览。
 */
const SearchResults = ({ q, onOpenFile }: SearchResultsProps) => {
  const dq = useDebounce(q, { wait: 350 })
  /** 选中行 id 集合：单击选中、Cmd/Ctrl+单击 切换多选、Shift+单击 连选；双击打开 */
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [anchorId, setAnchorId] = useState<string | null>(null)

  const { data: hits, loading, error, refresh } = useRequest(
    async () => {
      const { error: err, data } = await client.get('/api/v1/search', {
        query: { q: dq, limit: 100 },
      })
      if (err || !data) throw new Error('搜索失败')
      return data as unknown as SearchHit[]
    },
    { refreshDeps: [dq], ready: dq.length > 0 },
  )

  const state = loading ? 'loading' : error ? 'error' : 'ready'

  return (
    <StateView state={state} errorText="搜索失败，请重试" retry={refresh}>
      {state === 'ready' && !hits?.length ? (
        <div className="vd-empty">
          <div>未找到与「{dq}」相关的文件</div>
        </div>
      ) : (
        <div
          className="vd-table-wrap"
          style={{ border: '1px solid var(--vd-border-subtle)', borderRadius: 8 }}
          onClick={(e) => {
            if (!(e.target instanceof Element) || !e.target.closest('tr')) {
              setSelectedIds([])
              setAnchorId(null)
            }
          }}
        >
          <table className="vd-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>所在目录</th>
                <th style={{ width: 100 }}>类型</th>
                <th className="num" style={{ width: 100 }}>大小</th>
                <th style={{ width: 160 }}>更新时间</th>
                <th style={{ width: 90 }}>匹配度</th>
              </tr>
            </thead>
            <tbody>
              {(hits ?? []).map((r) => (
                <tr
                  key={r.id}
                  className={`clickable${selectedIds.includes(r.id) ? ' sel' : ''}`}
                  onClick={(e) => {
                    const id = r.id
                    if (e.shiftKey && anchorId) {
                      const ids = (hits ?? []).map((h) => h.id)
                      const a = ids.indexOf(anchorId)
                      const b = ids.indexOf(id)
                      if (a !== -1 && b !== -1) {
                        const [lo, hi] = a < b ? [a, b] : [b, a]
                        setSelectedIds(ids.slice(lo, hi + 1))
                        return
                      }
                    }
                    if (e.metaKey || e.ctrlKey) {
                      setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                      setAnchorId(id)
                      return
                    }
                    setSelectedIds([id])
                    setAnchorId(id)
                  }}
                  onDoubleClick={() => onOpenFile(r.id)}
                >
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <FileIcon name={r.name} size={16} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    </span>
                  </td>
                  <td>{r.directoryPath}</td>
                  <td>{fileTypeInfo(r.name).label}</td>
                  <td className="num">{formatBytes(r.size)}</td>
                  <td>{formatTime(r.updatedAt)}</td>
                  <td className="vd-faint" style={{ fontSize: 12 }}>
                    {r.isPrefixMatch ? '前缀' : `${Math.round(r.similarity * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StateView>
  )
}

export default SearchResults
