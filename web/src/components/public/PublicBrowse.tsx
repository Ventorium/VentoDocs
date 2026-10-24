import { useMemo, useState } from 'react'
import { useRequest } from 'ahooks'
import { Breadcrumb, Empty, Table } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import type { FileMeta, PublicEntry } from '@/api/schema'
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import StateView from '@/components/StateView'
import PublicFilePreview, { type PublicSource } from './PublicFilePreview'

type PublicBrowseProps = {
  rootName: string
  rootId: string
  source: PublicSource
  canDownload: boolean
  getEntries: (dirId: string) => Promise<PublicEntry[]>
}

/** 公开站点目录浏览：面包屑下钻 + 文件预览。 */
const PublicBrowse = ({ rootName, rootId, source, canDownload, getEntries }: PublicBrowseProps) => {
  const [stack, setStack] = useState<{ id: string; name: string }[]>([{ id: rootId, name: rootName }])
  const [selected, setSelected] = useState<FileMeta | null>(null)

  const current = stack[stack.length - 1]
  // source 在浏览视图生命周期内稳定（密码/登录在视图出现前完成），用键做刷新依据
  const sourceKey =
    source.kind === 'share'
      ? `share:${source.token}:${source.password ? 'pwd' : ''}`
      : `publish:${source.publishId}:${source.bearerToken ? 'tok' : ''}`

  const {
    data: entries,
    loading,
    error,
    refresh,
  } = useRequest(() => getEntries(current.id), {
    refreshDeps: [current.id, sourceKey],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  const goDir = (dirId: string, name: string) => {
    setSelected(null)
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s).concat({ id: dirId, name }))
  }

  const jumpTo = (idx: number) => {
    if (idx >= stack.length) return
    setSelected(null)
    setStack((s) => s.slice(0, idx + 1))
  }

  const back = () => {
    if (selected) {
      setSelected(null)
    } else if (stack.length > 1) {
      setStack((s) => s.slice(0, -1))
    }
  }

  const crumbs = useMemo(
    () =>
      stack.map((seg, i) => ({
        title: (
          <span className={i === stack.length - 1 ? 'font-600' : 'cursor-pointer'}>
            {seg.name}
          </span>
        ),
        key: seg.id,
        onClick: i < stack.length - 1 ? () => jumpTo(i) : undefined,
      })),
    [stack],
  )

  if (selected) {
    return (
      <div className="flex flex-col gap-12px">
        <div className="flex items-center gap-8px">
          <button
            type="button"
            className="text-13px text-#2563EB cursor-pointer bg-transparent border-0 p-0"
            onClick={back}
          >
            ← 返回目录
          </button>
        </div>
        <PublicFilePreview file={selected} source={source} canDownload={canDownload} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-12px">
      <Breadcrumb
        items={crumbs.map((c) => ({ title: c.title, key: c.key, onClick: c.onClick }))}
        separator={<RightOutlined className="text-12px text-#9CA3AF" />}
      />
      <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} errorText="加载失败，请重试" retry={refresh}>
        <div className="rounded-8px border-1px border-#E5E7EB bg-white">
          <Table<PublicEntry>
            rowKey={(e) => (e.kind === 'directory' ? e.directory.id : e.file.id)}
            size="small"
            dataSource={entries ?? []}
            pagination={false}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该目录为空" />,
            }}
            onRow={(r) => ({
              onClick: () => {
                if (r.kind === 'directory') goDir(r.directory.id, r.directory.name)
                else setSelected(r.file)
              },
              style: { cursor: 'pointer' },
            })}
            columns={[
              {
                title: '名称',
                render: (_: unknown, r: PublicEntry) =>
                  r.kind === 'directory' ? (
                    <span className="flex items-center gap-8px min-w-0">
                      <FolderIcon size={16} />
                      <span className="truncate">{r.directory.name}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-8px min-w-0">
                      <FileIcon name={r.file.name} size={16} />
                      <span className="truncate">{r.file.name}</span>
                    </span>
                  ),
              },
              {
                title: '类型',
                width: 110,
                render: (_: unknown, r: PublicEntry) =>
                  r.kind === 'directory' ? '文件夹' : fileTypeInfo(r.file.name).label,
              },
              {
                title: '大小',
                width: 100,
                render: (_: unknown, r: PublicEntry) =>
                  r.kind === 'directory' ? '-' : formatBytes(r.file.size),
              },
              {
                title: '更新时间',
                width: 160,
                render: (_: unknown, r: PublicEntry) =>
                  r.kind === 'directory' ? '-' : formatTime(r.file.updated_at),
              },
            ]}
          />
        </div>
      </StateView>
    </div>
  )
}

export default PublicBrowse
