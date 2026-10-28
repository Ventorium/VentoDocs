import { useRequest } from 'ahooks'
import { ChevronRight, FileArchive, Folder, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { client } from '@/api'
import FileIcon from '@/components/FileIcon'
import { Spin } from '@/components/ui/kit'
import { useWindows } from '@/kernel/window/store'
import { formatBytes } from '@/lib/format'
import { encodeZipFileId } from '@/lib/zipEntry'

/** 服务端 /files/{id}/zip 返回的条目（扁平相对路径）。 */
type ZipEntry = {
  name: string
  size: number
  is_dir: boolean
  modified: string | null
}

type Props = {
  zipFileId: string
  zipName: string
}

/**
 * M2.15：zip 压缩包内容预览（Windows 资源管理器体验）。
 * 一次请求拉全量扁平条目，前端按当前目录分组；
 * 双击目录钻取、双击文件用虚拟 id（zip:<zipId>@<路径>）打开新文件窗口。
 */
const ZipView = ({ zipFileId, zipName }: Props) => {
  const [dirPath, setDirPath] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const { data, loading, error, refresh } = useRequest(
    async () => {
      const { error: err, data: d } = await client.get('/api/v1/files/{id}/zip', {
        params: { id: zipFileId }
      })
      if (err || !d) throw new Error(err?.message ?? '读取压缩包内容失败')
      return d
    },
    { refreshDeps: [zipFileId] }
  )

  const allEntries = useMemo(() => data?.entries ?? [], [data])

  /** 当前目录直属条目（名称均为相对 zip 根的完整路径）；zip 未含显式目录条目时合成父目录行。 */
  const children = useMemo(() => {
    const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
    const direct = allEntries.filter((e) => parentOf(e.name) === dirPath)
    const rows: ZipEntry[] = [...direct]
    const existing = new Set(direct.filter((e) => e.is_dir).map((e) => e.name))
    const implied = new Set<string>()
    for (const e of allEntries) {
      if (e.is_dir) continue
      const parts = e.name.split('/')
      for (let i = 1; i < parts.length; i++) implied.add(parts.slice(0, i).join('/'))
    }
    for (const d of implied) {
      if (existing.has(d)) continue
      if (parentOf(d) === dirPath) rows.push({ name: d, size: 0, is_dir: true, modified: null })
    }
    return rows.sort((a, b) =>
      a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN')
    )
  }, [allEntries, dirPath])

  /** 各目录直属条目数（行尾展示，同资源管理器）。 */
  const dirCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of allEntries) {
      if (e.is_dir) continue
      const parent = e.name.includes('/') ? e.name.slice(0, e.name.lastIndexOf('/')) : ''
      m.set(parent, (m.get(parent) ?? 0) + 1)
    }
    return m
  }, [allEntries])

  const segs = dirPath ? dirPath.split('/') : []

  const openEntry = (e: ZipEntry) => {
    if (e.is_dir) {
      // e.name 为相对 zip 根的完整路径，直接作为当前目录
      setDirPath(e.name)
      setSelected(null)
    } else {
      useWindows.getState().open('file', { fileId: encodeZipFileId(zipFileId, e.name) })
    }
  }

  return (
    <div className="vd-zip">
      {/* 面包屑 */}
      <div className="vd-zip-crumbs">
        <FileArchive size={13} style={{ color: 'var(--vd-accent)', flexShrink: 0 }} />
        <button
          type="button"
          className={`vd-zip-crumb${segs.length === 0 ? ' is-last' : ''}`}
          title="压缩包根目录"
          onClick={() => {
            setDirPath('')
            setSelected(null)
          }}
        >
          {zipName}
        </button>
        {segs.map((seg, i) => {
          const isLast = i === segs.length - 1
          return (
            <span key={`${seg}-${i}`} className="inline-flex items-center">
              <ChevronRight size={10} className="vd-faint" style={{ opacity: 0.4 }} />
              <button
                type="button"
                className={`vd-zip-crumb${isLast ? ' is-last' : ''}`}
                disabled={isLast}
                title={isLast ? seg : `前往 /${segs.slice(0, i + 1).join('/')}`}
                onClick={() => {
                  if (!isLast) {
                    setDirPath(segs.slice(0, i + 1).join('/'))
                    setSelected(null)
                  }
                }}
              >
                {seg}
              </button>
            </span>
          )
        })}
        <div style={{ flex: 1 }} />
        <button type="button" className="vd-fm-path-refresh" onClick={refresh} title="刷新">
          <RefreshCw size={12} />
        </button>
      </div>

      {loading ? (
        <div className="vd-zip-center">
          <Spin />
        </div>
      ) : error ? (
        <div
          className="vd-zip-center vd-faint"
          style={{ fontSize: 11, padding: '16px 8px', textAlign: 'center' }}
        >
          {error?.message ?? '读取压缩包内容失败'}
        </div>
      ) : children.length === 0 ? (
        <div className="vd-zip-center vd-faint" style={{ fontSize: 12 }}>
          空目录
        </div>
      ) : (
        <div
          className="vd-zip-rows"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !selected) return
            const cur = children.find((c) => c.name === selected)
            if (cur) openEntry(cur)
          }}
        >
          {children.map((e) => (
            <div
              key={e.name}
              className={`vd-zip-row${selected === e.name ? ' is-current' : ''}`}
              onClick={() => setSelected(e.name)}
              onDoubleClick={() => openEntry(e)}
              title={e.name}
            >
              {e.is_dir ? (
                <Folder size={13} style={{ flexShrink: 0, color: 'var(--vd-warning, #d97706)' }} />
              ) : (
                <FileIcon name={e.name} size={13} style={{ flexShrink: 0 }} />
              )}
              {/* Windows 体验：行内显示 basename，完整路径放 title 提示 */}
              <span className="truncate">{e.name.slice(e.name.lastIndexOf('/') + 1)}</span>
              <span className="vd-zip-row-meta">
                {e.is_dir ? `${dirCounts.get(e.name) ?? 0} 项` : formatBytes(e.size)}
              </span>
              {e.is_dir && <ChevronRight size={11} style={{ opacity: 0.5, marginLeft: 'auto' }} />}
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="vd-zip-foot">{data.entry_count} 个项目</div>
      )}
    </div>
  )
}

export default ZipView
