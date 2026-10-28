import { useState } from 'react'
import { useRequest } from 'ahooks'
import { ChevronRight } from 'lucide-react'
import type { FileMeta, PublicEntry } from '@/api/schema'
import { formatBytes, formatTime } from '@/lib/format'
import { fileTypeInfo } from '@/lib/fileType'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import StateView from '@/components/StateView'
import { Spin } from '@/components/ui/kit'
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

  if (selected) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <button
          type="button"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--vd-accent)',
            cursor: 'pointer',
            fontSize: 13,
            padding: 0,
          }}
          onClick={back}
        >
          ← 返回目录
        </button>
        <PublicFilePreview file={selected} source={source} canDownload={canDownload} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 面包屑 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 13 }}>
        {stack.map((seg, i) => {
          const last = i === stack.length - 1
          return (
            <span key={seg.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {i > 0 ? (
                <ChevronRight
                  size={13}
                  style={{ color: 'var(--vd-text-tertiary)', flexShrink: 0 }}
                />
              ) : null}
              <span
                style={{
                  color: last ? 'var(--vd-text-primary)' : 'var(--vd-accent)',
                  fontWeight: last ? 600 : 400,
                  cursor: last ? 'default' : 'pointer',
                }}
                onClick={() => jumpTo(i)}
              >
                {seg.name}
              </span>
            </span>
          )
        })}
      </div>

      <StateView state={loading ? 'loading' : error ? 'error' : 'ready'} errorText="加载失败，请重试" retry={refresh}>
        <div className="vd-panel" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : (entries ?? []).length === 0 ? (
            <div className="vd-empty">该目录为空</div>
          ) : (
            <div className="vd-table-wrap">
              <table className="vd-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th style={{ width: 110 }}>类型</th>
                    <th style={{ width: 100 }}>大小</th>
                    <th style={{ width: 160 }}>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {entries?.map((r) => {
                    const key = r.kind === 'directory' ? `d:${r.directory.id}` : `f:${r.file.id}`
                    return (
                      <tr
                        key={key}
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          if (r.kind === 'directory') goDir(r.directory.id, r.directory.name)
                          else setSelected(r.file)
                        }}
                      >
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            {r.kind === 'directory' ? (
                              <FolderIcon size={16} />
                            ) : (
                              <FileIcon name={r.file.name} size={16} />
                            )}
                            <span className="vd-truncate">{r.kind === 'directory' ? r.directory.name : r.file.name}</span>
                          </span>
                        </td>
                        <td>
                          {r.kind === 'directory' ? '文件夹' : fileTypeInfo(r.file.name).label}
                        </td>
                        <td>{r.kind === 'directory' ? '-' : formatBytes(r.file.size)}</td>
                        <td>{r.kind === 'directory' ? '-' : formatTime(r.file.updated_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </StateView>
    </div>
  )
}

export default PublicBrowse
