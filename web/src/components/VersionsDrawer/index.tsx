import { useState } from 'react'
import { useRequest } from 'ahooks'
import { History } from 'lucide-react'
import type { VersionInfo } from '@/api/schema'
import { client } from '@/api'
import { Btn, Drawer, Modal, Spin, Tag } from '@/components/ui/kit'
import { msg } from '@/components/ui/toast'
import { formatBytes, formatDateTime } from '@/lib/format'

type VersionsDrawerProps = {
  open: boolean
  fileId: string | null
  fileName?: string
  onClose: () => void
}

/** 版本历史抽屉：列出全部版本，支持「恢复为当前版本」（生成新版本，不覆盖）。 */
const VersionsDrawer = ({ open, fileId, fileName, onClose }: VersionsDrawerProps) => {
  const { data, loading, run } = useRequest(
    async () => {
      const { error, data: d } = await client.get('/api/v1/files/{id}/versions', {
        params: { id: fileId! },
      })
      if (error || !d) throw new Error('加载版本历史失败')
      return d as unknown as VersionInfo[]
    },
    {
      ready: open && !!fileId,
      refreshDeps: [fileId, open],
    },
  )

  const [restoring, setRestoring] = useState<VersionInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const currentVersion = data?.[0]?.version ?? -1

  const doRestore = async (v: VersionInfo) => {
    if (!fileId) return
    setBusy(true)
    try {
      const { error } = await client.post('/api/v1/files/{id}/versions/{version}/restore', {
        params: { id: fileId, version: v.version },
      })
      if (error) return
      msg.success(`已恢复 v${v.version}（生成新版本）`)
      setRestoring(null)
      run()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={
          <>
            <History size={15} style={{ color: 'var(--vd-accent)' }} />
            版本历史{fileName ? ` · ${fileName}` : ''}
          </>
        }
      >
        {loading ? (
          <div className="vd-flex-center" style={{ height: 240 }}>
            <Spin />
          </div>
        ) : (
          <div className="vd-table-wrap" style={{ border: '1px solid var(--vd-border-subtle)', borderRadius: 8 }}>
            <table className="vd-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>版本</th>
                  <th className="num" style={{ width: 90 }}>大小</th>
                  <th style={{ width: 80 }}>来源</th>
                  <th>说明</th>
                  <th style={{ width: 110 }}>操作人</th>
                  <th style={{ width: 150 }}>时间</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((v) => (
                  <tr key={v.id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        v{v.version}
                        {v.version === currentVersion ? <Tag color="blue">当前</Tag> : null}
                      </span>
                    </td>
                    <td className="num">{formatBytes(v.size)}</td>
                    <td>{v.encoding === 'univer' ? <Tag color="gray">在线</Tag> : '—'}</td>
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.note || '—'}</td>
                    <td>{v.created_by_name}</td>
                    <td>{formatDateTime(v.created_at)}</td>
                    <td>
                      {v.version === currentVersion ? (
                        <span className="vd-faint" style={{ fontSize: 12 }}>当前版本</span>
                      ) : (
                        <Btn size="xs" onClick={() => setRestoring(v)}>恢复</Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Drawer>

      <Modal
        open={!!restoring}
        title={`恢复到版本 v${restoring?.version ?? ''}`}
        onClose={() => setRestoring(null)}
        footer={
          <>
            <Btn onClick={() => setRestoring(null)}>取消</Btn>
            <Btn variant="primary" loading={busy} onClick={() => restoring && void doRestore(restoring)}>恢复</Btn>
          </>
        }
      >
        <p className="m-0">恢复不会覆盖现有版本，而是以旧版本内容创建一个新的当前版本。</p>
      </Modal>
    </>
  )
}

export default VersionsDrawer
