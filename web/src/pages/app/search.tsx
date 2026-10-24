import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useDebounce, useRequest } from 'ahooks'
import { Input, Table } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { client } from '@/api'
import type { SearchHit } from '@/api/schema'
import FileIcon from '@/components/FileIcon'
import StateView from '@/components/StateView'
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'
import { useUrlQuery } from '@/hooks/useUrlQuery'

/** 文件名全局搜索页（PG 前缀 + pg_trgm 相似度）。结果点击跳转文件详情。 */
const SearchPage = () => {
  const navigate = useNavigate()
  const { query } = useUrlQuery<{ q?: string }>()
  const initialQ = (query.q ?? '').trim()
  const [input, setInput] = useState(initialQ)
  const debounced = useDebounce(input.trim(), { wait: 350 })
  const q = debounced

  // 深链 /app/search?q=xxx：URL 带 q 时同步输入框
  useEffect(() => {
    if (query.q) setInput(query.q)
  }, [query.q])

  const {
    data: hits,
    loading,
    error,
    refresh,
  } = useRequest(
    async () => {
      const { error: err, data } = await client.get('/api/v1/search', {
        query: { q, limit: 100 },
      })
      if (err || !data) throw new Error('搜索失败')
      return data as unknown as SearchHit[]
    },
    { refreshDeps: [q], ready: q.length > 0 },
  )

  const state = loading ? 'loading' : error ? 'error' : q ? 'ready' : 'empty'

  return (
    <div className="flex flex-col gap-12px">
      <div className="text-16px font-600">搜索</div>

      <div className="max-w-560px">
        <Input.Search
          placeholder="输入文件名关键词…"
          allowClear
          size="large"
          prefix={<SearchOutlined className="text-#9CA3AF" />}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSearch={() => refresh()}
        />
      </div>

      {state !== 'empty' ? (
        <StateView state={state} errorText="搜索失败，请重试" retry={refresh}>
          <div className="rounded-8px border-1px border-#E5E7EB bg-white">
            <Table<SearchHit>
              rowKey="id"
              size="small"
              dataSource={hits ?? []}
              pagination={false}
              locale={{ emptyText: `未找到与「${q}」相关的文件` }}
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
      ) : (
        <div className="rounded-8px border-1px border-#E5E7EB bg-white py-48px text-center text-13px text-#9CA3AF">
          输入关键词搜索文件名，支持模糊匹配
        </div>
      )}
    </div>
  )
}

export default SearchPage
