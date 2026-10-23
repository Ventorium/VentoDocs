import { useEffect, useState } from 'react'
import { client } from '@/api'
import type { DirectoryPage } from '@/api/schema'

export type DirChainItem = {
  id: string
  name: string
}

/**
 * 从根目录开始，沿 parent_id 逐级上溯，得到当前目录的面包屑链（含自身，根在前）。
 * 注意：Directory.path 是 id 物化路径，展示必须沿 parent_id 逐级取真实目录。
 */
export function useDirChain(dirId: string | null) {
  const [chain, setChain] = useState<DirChainItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)

    if (!dirId) {
      setChain([])
      return
    }

    const walk = async () => {
      setLoading(true)
      const stack: DirChainItem[] = []
      let currentId: string | null = dirId
      while (currentId) {
        const resp: { error: boolean; data: DirectoryPage | null } = await client.get(
          `/api/v1/directories/{id}`,
          { params: { id: currentId } },
        )
        const err = resp.error
        const data = resp.data
        if (cancelled) return
        if (err || !data) {
          setError('无法加载目录信息')
          setLoading(false)
          return
        }
        stack.unshift({ id: data.directory.id, name: data.directory.name })
        currentId = data.directory.parent_id
      }
      setChain(stack)
      setLoading(false)
    }

    void walk().catch(() => {
      if (!cancelled) {
        setError('网络错误')
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [dirId])

  return { chain, loading, error }
}
