import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useRequest } from 'ahooks'
import { Breadcrumb, Button } from 'antd'
import { FolderAddOutlined, ReloadOutlined } from '@ant-design/icons'
import { client } from '@/api'
import { msg } from '@/components/GlobalMessage'
import StateView from '@/components/StateView'
import { useDirChain } from '@/hooks/useDirChain'
import { ROOT_DIR_ID } from '@/lib/constants'
import { hasPerm, PERM } from '@/lib/perm'
import { useAuth } from '@/store/useAuth'
import EntryTable from './EntryTable'
import NewDirModal from './NewDirModal'
import UploadButton from './UploadButton'

type DirectoryViewProps = {
  dirId: string | null
}

/** 目录浏览视图：面包屑 + 工具栏 + 条目表格。dirId 为 null 时展示根目录。 */
const DirectoryView = ({ dirId }: DirectoryViewProps) => {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [newDirOpen, setNewDirOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  const { data: page, loading, error, refresh } = useRequest(
    async () => {
      const req = dirId
        ? client.get('/api/v1/directories/{id}', { params: { id: dirId } })
        : client.get('/api/v1/directories/root')
      const { error: err, data, response } = await req
      if (err || !data) {
        if (response?.status === 403) throw new Error('no-perm')
        throw new Error('加载失败')
      }
      return data
    },
    { refreshDeps: [dirId] },
  )

  const chain = useDirChain(dirId)

  const canUpload = page ? hasPerm(page.my_perms, PERM.CREATE_UPLOAD) : false
  const canCreateDir = page ? hasPerm(page.my_perms, PERM.CREATE_UPLOAD) : false

  const createDir = async (name: string) => {
    setCreating(true)
    const { error: err } = await client.post('/api/v1/directories', {
      body: { parent_id: dirId ?? ROOT_DIR_ID, name },
    })
    setCreating(false)
    if (err) return
    setNewDirOpen(false)
    msg.success('目录已创建')
    refresh()
  }

  const state: 'loading' | 'error' | 'empty' | 'noPerm' | 'ready' =
    loading || !page ? 'loading'
    : error?.message === 'no-perm' ? 'noPerm'
    : error ? 'error'
    : page.children.length === 0 ? 'empty'
    : 'ready'

  const crumbs = [
    ...chain.chain.map((c) => ({
      title:
        c.id === dirId ? (
          <span>{c.name}</span>
        ) : (
          <a
            className="!text-#1F2937 hover:!text-#2563EB"
            onClick={() => navigate(c.id === ROOT_DIR_ID ? '/app/files' : `/app/files/${c.id}`)}
          >
            {c.name}
          </a>
        ),
    })),
  ]

  return (
    <div className="flex flex-col gap-12px">
      <div className="flex items-center justify-between gap-12px">
        <Breadcrumb items={crumbs.length > 0 ? crumbs : [{ title: <span>根目录</span> }]} />
        <div className="flex items-center gap-8px">
          <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
            刷新
          </Button>
          {canCreateDir && (
            <Button icon={<FolderAddOutlined />} onClick={() => setNewDirOpen(true)}>
              新建目录
            </Button>
          )}
          {page && (
            <UploadButton dirId={page.directory.id} disabled={!canUpload} onFinished={() => refresh()} />
          )}
        </div>
      </div>

      <StateView
        state={state}
        retry={() => refresh()}
        emptyText="当前目录为空，点击右上角「上传文件」或「新建目录」开始"
      >
        {page && <EntryTable page={page} me={user!} onReload={() => refresh()} />}
      </StateView>

      <NewDirModal open={newDirOpen} submitting={creating} onSubmit={createDir} />
    </div>
  )
}

export default DirectoryView
