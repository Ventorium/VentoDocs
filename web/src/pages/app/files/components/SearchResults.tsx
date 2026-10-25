import { useNavigate } from 'react-router'
import { useDebounce, useRequest } from 'ahooks'
import { Table } from 'antd'
import { client } from '@/api'
import type { SearchHit } from '@/api/schema'
import FileIcon from '@/components/FileIcon'
import StateView from '@/components/StateView'
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'

type SearchResultsProps = {
  /** 当前关键词（已 trim）。内部再做 350ms 防抖后请求。 */
  q: string
}

/**
 * 全库搜索结果表（内嵌在文件管理器主区域，取代独立搜索页）。
 * 行点击跳转文件详情；清空工具栏搜索框即回到目录浏览。
 */
const SearchResults = ({ q }: SearchResultsProps) => {
  const navigate = useNavigate()
  const dq = useDebounce(q, { wait: 350 })

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
      <div className="rounded-8px border-1px border-#E5E7EB bg-white overflow-hidden">
        <Table<SearchHit>
          rowKey="id"
          size="small"
          dataSource={hits ?? []}
          pagination={false}
          locale={{ emptyText: `未找到与「${dq}」相关的文件` }}
          onRow={(r) => ({
            onClick: () => navigate(`/app/file/${r.id}`),
            style: { cursor: 'pointer' },
          })}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (_: string, r: SearchHit) => (
                <span className="flex items-center gap-8px min-w-0">
                  <FileIcon name={r.name} size={16} />
                  <span className="truncate">{r.name}</span>
                </span>
              ),
            },
            {
              title: '所在目录',
              dataIndex: 'directoryPath',
              ellipsis: true,
            },
            {
              title: '类型',
              dataIndex: 'name',
              width: 100,
              render: (_: string, r: SearchHit) => fileTypeInfo(r.name).label,
            },
            {
              title: '大小',
              dataIndex: 'size',
              width: 100,
              render: (s: number) => formatBytes(s),
            },
            {
              title: '更新时间',
              dataIndex: 'updatedAt',
              width: 160,
              render: (t: string) => formatTime(t),
            },
            {
              title: '匹配度',
              dataIndex: 'similarity',
              width: 90,
              render: (sim: number, r: SearchHit) => (
                <span className="text-12px text-#9CA3AF">
                  {r.isPrefixMatch ? '前缀' : `${Math.round(sim * 100)}%`}
                </span>
              ),
            },
          ]}
        />
      </div>
    </StateView>
  )
}

export default SearchResults
