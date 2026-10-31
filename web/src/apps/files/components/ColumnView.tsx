import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, CloudUpload, Folder, FolderPlus, Lock, RefreshCw, Search, Share2, SquarePlus, Users } from 'lucide-react'
import { client } from '@/api'
import type { Entry, SharedDirOut } from '@/api/schema'
import { msg } from '@/components/ui/toast'
import { Btn, Input, Modal, Spin, type DropItem } from '@/components/ui/kit'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import VersionsDrawer from '@/components/VersionsDrawer'
import { useContextMenu, type CtxItem } from '@/shell/ContextMenu'
import { useWindows } from '@/kernel/window/store'
import { uploadFile } from '@/lib/upload'
import { ROOT_DIR_ID } from '@/lib/constants'
import { hasPerm, PERM } from '@/lib/perm'
import { useAuth, type AuthUser } from '@/store/useAuth'
import MoveCopyModal from './MoveCopyModal'
import NewDirModal from './NewDirModal'
import GrantsModal from './GrantsModal'
import ShareModal from './ShareModal'
import PublishModal from './PublishModal'
import SearchResults from './SearchResults'
import FileInfoPanel from './FileInfoPanel'
import {
  type EntryMenuActions,
  dirMenuItems,
  fileMenuItems,
  useEntryActions,
} from './useEntryActions'

/** 单列数据：目录 id + 名称 + 物化路径 + 条目 + 权限位 + 选中条目名。 */
type FmCol = {
  dirId: string
  name: string
  path: string
  entries: Entry[]
  myPerms: number
  /** M2.36：当前目录的授权权限位（不含管理员旁路）——控制「新建目录 / 上传文件」等列级操作显隐 */
  grantPerms: number
  loading: boolean
  error?: string
  selected?: string
  /** M2.18b：shared = 共享作用域虚拟首列（dirId 为哨兵值，不是真实目录，绝不发给 API） */
  kind?: 'dir' | 'shared'
  sharedScope?: 'team' | 'me'
  /** 共享列专用：目录 id → 共享条目元数据（owner / 团队 / 权限位） */
  sharedMeta?: Record<string, SharedDirOut>
}

/** M2.18 左栏作用域：personal 个人文件 / team 团队共享 / me 分享给我 */
type FmScope = 'personal' | 'team' | 'me'

/** 拖拽条目载荷（应用内移动）。 */
type DragEntry = {
  kind: 'file' | 'directory'
  id: string
  name: string
  dirId: string
  path: string
}

type ColumnViewProps = {
  /** 深链种子：从该目录开始构建列栈（null = 根）。仅当与当前末列不一致时重建。 */
  dirId: string | null
  /** M2.19：刷新恢复的初始共享作用域（team/me），null = 个人作用域 */
  initialScope?: 'team' | 'me' | null
  /** 最后一列/作用域变化时回传（dirId null = 根或共享列表），用于窗口状态持久化。 */
  onNavigateDir: (dirId: string | null, scope?: FmScope) => void
  /** 打开文件详情窗口。 */
  onOpenFile: (fileId: string) => void
  /** M2.20：多窗口友好——当前作用域/路径变化时回传窗口标题（区分多个 FM 窗口） */
  onTitleChange?: (title: string) => void
}

const DRAG_MIME = 'application/x-vento-entry'

/**
 * M2.18b 共享作用域虚拟列的哨兵 dirId。
 * 只在前端用作列标识 / React key，绝不发给后端 API。
 */
const SHARED_DIR_ID: Record<'team' | 'me', string> = {
  team: 'shared:team',
  me: 'shared:me',
}

const entryName = (r: Entry) => (r.kind === 'file' ? r.file.name : r.directory.name)
const entryId = (r: Entry) => (r.kind === 'file' ? r.file.id : r.directory.id)

/**
 * M2.18b：把共享目录列表（SharedDirOut[]）转成「目录条目」形式，
 * 让共享列表能直接渲染在文件列（主区域）里，而不是侧栏里的小列表。
 * SharedDirOut 的 id/name/path/parent_id/created_by 直接映射为目录；
 * 同时返回 meta 映射（目录 id → SharedDirOut），供菜单权限判断和 meta 行展示。
 */
function sharedToEntries(list: SharedDirOut[]): {
  entries: Entry[]
  meta: Record<string, SharedDirOut>
} {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const now = new Date().toISOString()
  const entries: Entry[] = sorted.map((d) => ({
    kind: 'directory',
    directory: {
      id: d.id,
      parent_id: d.parent_id,
      name: d.name,
      path: d.path,
      is_trash: false,
      deleted_at: null,
      created_by: d.created_by ?? null,
      created_at: now,
    },
    // M2.36：共享条目携带各自授权位，菜单按实际授权显隐
    my_perms: d.perms,
  }))
  const meta: Record<string, SharedDirOut> = {}
  for (const d of sorted) meta[d.id] = d
  return { entries, meta }
}

/** M2.19：构造共享作用域虚拟首列（dirId 为哨兵值，绝不发给 API）。 */
function sharedSentinelCol(
  s: 'team' | 'me',
  view: { entries: Entry[]; meta: Record<string, SharedDirOut> },
  loading: boolean,
): FmCol {
  return {
    dirId: SHARED_DIR_ID[s],
    name: s === 'team' ? '团队共享' : '分享给我',
    path: '/',
    kind: 'shared',
    sharedScope: s,
    myPerms: 0,
    grantPerms: 0,
    loading,
    entries: view.entries,
    sharedMeta: view.meta,
  }
}

async function fetchSharedList(s: 'team' | 'me'): Promise<SharedDirOut[]> {
  const { data, error } = await client.get('/api/v1/directories/shared', { query: { scope: s } })
  if (error) throw new Error('加载共享目录失败')
  return data ?? []
}

function sortEntries(children: Entry[]): Entry[] {
  return [...children].sort((a, b) => {
    const ad = a.kind === 'directory' ? 0 : 1
    const bd = b.kind === 'directory' ? 0 : 1
    if (ad !== bd) return ad - bd
    return entryName(a).localeCompare(entryName(b), 'zh-Hans-CN')
  })
}

async function loadDir(id: string) {
  const req =
    id === ROOT_DIR_ID
      ? client.get('/api/v1/directories/root')
      : client.get('/api/v1/directories/{id}', { params: { id } })
  const { error, data, response } = await req
  if (error || !data) {
    if (response?.status === 403) throw new Error('无权限访问')
    throw new Error('加载失败')
  }
  return data
}

/** DropItem → 全局右键菜单 CtxItem。 */
function toCtx(items: DropItem[]): CtxItem[] {
  return items.map((it) =>
    it.divider
      ? { key: it.key, divider: true }
      : { key: it.key, label: it.label, icon: it.icon, danger: it.danger, onClick: () => it.onClick?.() },
  )
}

/**
 * 多列目录导航（完整复刻 VentoOS 资源管理器交互，条目 id 化适配单服务 API）：
 *  - Finder 风格多列：点击目录右侧展开新列，路径栏/「/」回退，自动滚到最右列；
 *  - 单击文件 → 高亮该文件 + 列栈截断至该文件所在列 + 右侧预览面板（FileInfoPanel）；双击打开文件窗口；
 *  - Ctrl/Cmd 多选（始终保留主选）、Shift 连选、空白处框选（rubber band）；
 *  - 条目拖入目录/列 = 直接移动（无确认弹窗，同级/拖入自身子树自动忽略），
 *    外部文件拖入 = 上传；
 *  - 内联重命名（F2 / 右键「重命名」）、键盘 ↑↓←→/Enter/Delete/F2/Ctrl+A；
 *  - 列空白右键：新建目录 / 上传文件 / 刷新；多选右键：批量删除。
 */
const ColumnView = ({ dirId, initialScope = null, onNavigateDir, onOpenFile, onTitleChange }: ColumnViewProps) => {
  const { user: me } = useAuth()
  const { show } = useContextMenu()

  const [cols, setCols] = useState<FmCol[]>([])
  const [active, setActive] = useState(0)
  const [multiSel, setMultiSel] = useState<Map<number, Set<string>>>(new Map())
  const [anchor, setAnchor] = useState<{ col: number; name: string } | null>(null)
  const [previewEntry, setPreviewEntry] = useState<Entry | null>(null)
  const [renaming, setRenaming] = useState<{ col: number; name: string; value: string } | null>(null)
  const [renamingBusy, setRenamingBusy] = useState(false)
  const [newDirOpen, setNewDirOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // M2.21：整列拖入高亮（键=列 dirId），内部移动/本地上传拖动悬停时显示
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const [band, setBand] = useState<{ col: number; top: number; height: number } | null>(null)
  const [q, setQ] = useState('')

  // ── M2.18 左栏：个人 / 团队共享 / 分享给我 ─────────────────────
  // M2.19：初始作用域从 appState 恢复（刷新后回到团队共享/分享给我）
  const [scope, setScope] = useState<FmScope>(
    initialScope === 'team' || initialScope === 'me' ? initialScope : 'personal',
  )
  const [shared, setShared] = useState<{ team: SharedDirOut[]; me: SharedDirOut[]; loading: boolean }>({
    team: [],
    me: [],
    loading: false,
  })

  const navRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const colScrollRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const colsRef = useRef(cols)
  colsRef.current = cols
  const activeRef = useRef(active)
  activeRef.current = active
  const multiSelRef = useRef(multiSel)
  multiSelRef.current = multiSel
  const bandRef = useRef(band)
  bandRef.current = band
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const previewRef = useRef(previewEntry)
  previewRef.current = previewEntry
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const sharedRef = useRef(shared)
  sharedRef.current = shared
  /** M2.18b：作用域切换序号——防止离开的 openScope 竞态覆盖新视图 */
  const scopeSeq = useRef(0)

  const searching = q.trim().length > 0
  const activeCol = cols[active]

  const refreshAll = useCallback(async () => {
    const cur = colsRef.current
    if (cur.length === 0) return
    const results = await Promise.all(
      cur.map((c) =>
        c.kind === 'shared'
          ? fetchSharedList(c.sharedScope!).then(
              (list) => {
                const { entries, meta } = sharedToEntries(list)
                return { entries, myPerms: 0, grantPerms: 0, name: c.name, error: null as string | null, meta: meta as Record<string, SharedDirOut> | undefined }
              },
              (e: Error) => ({ entries: [] as Entry[], myPerms: 0, grantPerms: 0, name: c.name, error: e.message, meta: undefined as Record<string, SharedDirOut> | undefined }),
            )
          : loadDir(c.dirId).then(
              (page) => ({ entries: sortEntries(page.children), myPerms: page.my_perms, grantPerms: page.granted_perms, name: page.directory.name, error: null as string | null, meta: undefined as Record<string, SharedDirOut> | undefined }),
              (e: Error) => ({ entries: [] as Entry[], myPerms: c.myPerms, grantPerms: c.grantPerms, name: c.name, error: e.message, meta: undefined as Record<string, SharedDirOut> | undefined }),
            ),
      ),
    )
    setCols((prev) =>
      prev.map((c, i) => {
        const r = results[i]
        const selected = r.entries.some((e) => entryName(e) === c.selected) ? c.selected : undefined
        return { ...c, entries: r.entries, myPerms: r.myPerms, grantPerms: r.grantPerms, name: r.name, sharedMeta: r.meta ?? c.sharedMeta, selected, loading: false, error: r.error ?? undefined }
      }),
    )
    // M2.23：预览面板打开时把 entry 同步为刷新后的新对象，触发授权列表/分享状态重新拉取。
    // M2.33：若预览条目刷新后不再出现（被删除、或移出当前已打开的列）且其可能所在的列均刷新成功，
    //        关闭预览面板——否则右侧属性面板会一直显示已删除的文件。可能所在列刷新失败则保守不清，避免误关。
    const pe = previewRef.current
    if (pe) {
      const nid = entryId(pe)
      const parentId = pe.kind === 'file' ? pe.file.directory_id : pe.directory.parent_id
      let found = false
      // 仅当「条目可能所在的列」刷新失败时才保守不清：普通列按父目录匹配，共享列无法判定归属，一律保守
      const anyRelevantError = results.some((r, i) => {
        const c = cur[i]
        return !!r.error && (c.kind === 'shared' || c.dirId === parentId)
      })
      for (const r of results) {
        const hit = r.entries.find((e) => entryId(e) === nid)
        if (hit) {
          found = true
          setPreviewEntry(hit)
          break
        }
      }
      if (!found && !anyRelevantError) setPreviewEntry(null)
    }
  }, [])

  const {
    modal,
    close,
    deleting,
    doMove,
    doCopy,
    doConfirmDelete,
    doConfirmDeleteMany,
    doUnlock,
    confirmDeleteMany,
    openModal,
    menuActions,
  } = useEntryActions(activeCol?.myPerms ?? 0, me ?? ({} as AuthUser), () => void refreshAll())

  // ── 初始/外部种子：沿 parent_id 链构建列栈；用户自己的导航不触发重建 ──

  const buildSeq = useRef(0)

  /** 构建指向 targetId 的列栈（null = 根）。竞态保护：只允许最新一次构建落地。 */
  const buildChainTo = useCallback(async (targetId: string | null) => {
    const target = targetId ?? ROOT_DIR_ID
    const cur = colsRef.current
    if (cur.length > 0 && cur[cur.length - 1].dirId === target) return
    const seq = ++buildSeq.current
    // 自目标向根收集祖先，反转后拼在根之后 → 列栈 [根, …, 目标]（左→右）
    const ancestors: string[] = []
    if (targetId && targetId !== ROOT_DIR_ID) {
      let curId: string | null = targetId
      let guard = 0
      while (curId && curId !== ROOT_DIR_ID && guard < 64) {
        ancestors.push(curId)
        try {
          const page = await loadDir(curId)
          curId = page.directory.parent_id
        } catch {
          return
        }
        guard++
      }
    }
    ancestors.reverse()
    const chain: string[] = [ROOT_DIR_ID, ...ancestors]
    if (seq !== buildSeq.current) return
    const loaded: FmCol[] = []
    for (const id of chain) {
      try {
        const page = await loadDir(id)
        loaded.push({
          dirId: id,
          name: page.directory.name,
          path: page.directory.path,
          entries: sortEntries(page.children),
          myPerms: page.my_perms,
          grantPerms: page.granted_perms,
          loading: false,
        })
      } catch (e) {
        if (seq !== buildSeq.current) return
        loaded.push({ dirId: id, name: '…', path: '/', entries: [], myPerms: 0, grantPerms: 0, loading: false, error: (e as Error).message })
        setCols(loaded)
        setActive(loaded.length - 1)
        return
      }
    }
    if (seq !== buildSeq.current) return
    setCols(loaded)
    setActive(loaded.length - 1)
    setPreviewEntry(null)
    setMultiSel(new Map())
    setAnchor(null)
  }, [])

  useEffect(() => {
    // M2.18b：共享视图下深链不应覆盖共享虚拟列（用 scopeRef 而非 scope 依赖，避免重复触发）
    if (scopeRef.current !== 'personal') return
    // M2.19：dirId 置空不触发重建——挂载时 lastDirId 回传会把 appState 的 dirId 清掉，
    // 若此时 rebuild(null) 会用 seq 把正在进行的刷新恢复构建冲掉（卡在根目录）
    if (!dirId) return
    void buildChainTo(dirId)
  }, [dirId, buildChainTo])

  // ── M2.18 左栏：团队共享 / 分享给我 目录列表 ───────────────────

  const fetchShared = useCallback(async (s: 'team' | 'me') => {
    setShared((p) => ({ ...p, loading: true }))
    try {
      const list = await fetchSharedList(s)
      setShared((p) => ({ ...p, [s]: list, loading: false }))
    } catch {
      setShared((p) => ({ ...p, loading: false }))
    }
  }, [])

  useEffect(() => {
    void fetchShared('team')
    void fetchShared('me')
  }, [fetchShared])

  /**
   * M2.18b：切换到共享作用域——主列区域展示共享目录列表（虚拟首列）。
   * 列表中的共享目录可像普通目录一样双击展开；无共享时显示「暂无共享目录」。
   */
  const openScope = useCallback(
    async (s: 'team' | 'me') => {
      const seq = ++scopeSeq.current
      const label = s === 'team' ? '团队共享' : '分享给我'
      const cached = sharedRef.current[s]
      const cachedView = sharedToEntries(cached)
      setScope(s)
      setCols([sharedSentinelCol(s, cachedView, cached.length === 0)])
      setActive(0)
      setPreviewEntry(null)
      setMultiSel(new Map())
      setAnchor(null)
      onNavigateDir(null, s)
      let list = cached
      try {
        list = await fetchSharedList(s)
        setShared((p) => ({ ...p, [s]: list, loading: false }))
      } catch {
        // 拉取失败时保留缓存（可能为空），由列内 error/空态呈现
      }
      if (seq !== scopeSeq.current) return
      const view = sharedToEntries(list)
      setCols((prev) =>
        prev.map((c, i) =>
          i === 0 && c.kind === 'shared'
            ? { ...c, name: label, entries: view.entries, sharedMeta: view.meta, loading: false }
            : c,
        ),
      )
    },
    [onNavigateDir],
  )

  /** M2.19：刷新恢复共享作用域的钻取位置——先展示共享列表（虚拟首列），
   *  再按目标目录物化路径定位顶层共享祖先，逐级向下构建列栈。
   *  目标目录已删除 / 已取消共享 / 失去访问权限时，停留在共享列表。 */
  const buildSharedChainTo = useCallback(async (s: 'team' | 'me', targetId: string) => {
    const seq = ++scopeSeq.current
    const cached = sharedRef.current[s]
    const cachedView = sharedToEntries(cached)
    setScope(s)
    setCols([sharedSentinelCol(s, cachedView, cached.length === 0)])
    setActive(0)
    setPreviewEntry(null)
    setMultiSel(new Map())
    setAnchor(null)
    let list = cached
    try {
      list = await fetchSharedList(s)
      setShared((p) => ({ ...p, [s]: list, loading: false }))
    } catch {
      // 拉取失败时保留缓存（可能为空），由列内 error/空态呈现
    }
    if (seq !== scopeSeq.current) return
    const view = sharedToEntries(list)
    setCols((prev) =>
      prev.map((c, i) =>
        i === 0 && c.kind === 'shared' ? sharedSentinelCol(s, view, false) : c,
      ),
    )
    // 物化路径是 id 路径，按 '/' 切分即可无歧义地定位共享顶层祖先
    let target: { id: string; path: string } | null = null
    try {
      const page = await loadDir(targetId)
      target = { id: page.directory.id, path: page.directory.path }
    } catch {
      return // 目标目录不存在或无权限 → 停留在共享列表
    }
    if (seq !== scopeSeq.current) return
    const root = list.find(
      (d) => target!.path === d.path || target!.path.startsWith(d.path + '/'),
    )
    if (!root) return
    const ids = target.path.split('/')
    const start = Math.max(0, ids.indexOf(root.id))
    const chainIds = ids.slice(start)
    const loaded: FmCol[] = []
    for (const id of chainIds) {
      if (seq !== scopeSeq.current) return
      try {
        const page = await loadDir(id)
        loaded.push({
          dirId: id,
          name: page.directory.name,
          path: page.directory.path,
          entries: sortEntries(page.children),
          myPerms: page.my_perms,
          grantPerms: page.granted_perms,
          loading: false,
        })
      } catch (e) {
        loaded.push({
          dirId: id,
          name: '…',
          path: '/',
          entries: [],
          myPerms: 0,
          grantPerms: 0,
          loading: false,
          error: (e as Error).message,
        })
        break
      }
    }
    if (seq !== scopeSeq.current) return
    setCols((prev) => {
      const first = prev.find((c) => c.kind === 'shared')
      return [
        first ?? sharedSentinelCol(s, sharedToEntries(sharedRef.current[s]), false),
        ...loaded,
      ]
    })
    setActive(loaded.length)
  }, [])

  // M2.19：挂载时一次性恢复刷新前的共享作用域（深链 dirId 为真实目录 id）
  const didInitRef = useRef(false)
  useEffect(() => {
    if (didInitRef.current) return
    didInitRef.current = true
    if (initialScope) {
      if (dirId && dirId !== ROOT_DIR_ID) void buildSharedChainTo(initialScope, dirId)
      else void openScope(initialScope)
    } else if (!dirId) {
      // M2.19：新窗口（无深链）挂载时加载根目录列。深链 effect 带 !dirId 守卫
      // （防挂载回传清 dirId 时 rebuild(null) 冲掉恢复构建），初始加载由此处发起；
      // 恢复场景（dirId 有值）由声明在前的深链 effect 构建，此处不覆盖。
      void buildChainTo(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 回到个人文件（根目录）。 */
  const goPersonal = useCallback(() => {
    scopeSeq.current++
    setScope('personal')
    onNavigateDir(null, 'personal')
    void buildChainTo(null)
  }, [buildChainTo, onNavigateDir])

  // ── 最后一列变化 → 回传窗口状态 ─────────────────────────────
  // M2.18b：共享虚拟列 id 绝不持久化（深链只认真实目录 id）；
  // M2.19：共享作用域下钻取到真实目录后回传该目录 id，配合 scope 恢复位置。

  const lastCol = cols.length > 0 ? cols[cols.length - 1] : null
  const lastDirId = lastCol && lastCol.kind !== 'shared' ? lastCol.dirId : ROOT_DIR_ID
  useEffect(() => {
    onNavigateDir(lastDirId === ROOT_DIR_ID ? null : lastDirId, scope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDirId, scope])

  // M2.20：多窗口友好——窗口标题跟随当前作用域/路径，便于区分多个 FM 窗口
  const lastTitleRef = useRef('')
  useEffect(() => {
    if (!onTitleChange) return
    let t = '文件管理器'
    if (scope === 'team') t = '文件管理器 · 团队共享'
    else if (scope === 'me') t = '文件管理器 · 分享给我'
    // M2.20 修：path 是服务端 ID 路径（/uuid），标题改用目录名，多窗口更易区分
    else if (lastCol && lastCol.kind !== 'shared' && lastCol.dirId !== ROOT_DIR_ID) t = `文件管理器 · ${lastCol.name}`
    if (t !== lastTitleRef.current) {
      lastTitleRef.current = t
      onTitleChange(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, lastCol])

  // M2.20：跨窗口拖拽移动——变更落在本窗口展示的列时刷新本窗口（每窗独立 ColumnView 实例）
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { src?: string; target?: string } | null
      if (!d) return
      if (colsRef.current.some((c) => c.dirId === d.src || c.dirId === d.target)) void refreshAll()
    }
    window.addEventListener('vk-fm-changed', h)
    return () => window.removeEventListener('vk-fm-changed', h)
  }, [refreshAll])

  // M2.21：拖拽取消（Esc）/落到 FM 外部时清除整列高亮
  useEffect(() => {
    const clear = () => {
      setDragOverCol(null)
      setDropTarget(null)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  // ── 挂载聚焦 + 列数变化 → 自动滚到最右列 ─────────────────────

  useEffect(() => {
    navRef.current?.focus()
  }, [])

  useEffect(() => {
    if (cols.length === 0) return
    const t = window.setTimeout(() => {
      const el = scrollRef.current
      if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'instant' })
    }, 50)
    return () => window.clearTimeout(t)
  }, [cols.length])

  // ── 选中项滚动可见 ───────────────────────────────────────────

  useEffect(() => {
    const colEl = colScrollRefs.current.get(active)
    if (!colEl) return
    const el = colEl.querySelector('[aria-selected="true"]')
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [active, cols])

  // ── 导航：目录 → 右侧展开新列；文件 → 高亮该文件 + 预览面板 ─────────────────

  const navigate = useCallback((colIdx: number, entry: Entry) => {
    setPreviewEntry(entry)
    if (entry.kind === 'file') {
      // M2.12: 对齐 VentoOS handleNavigate —— 单击文件同样高亮该文件并把列栈截断到该文件所在列，
      // 目录树/路径栏随之跟随所点文件的父级链（此前只更新预览面板，文件无高亮、深层列不收起）
      setCols((prev) => {
        const updated = prev.slice(0, colIdx + 1)
        if (colIdx < updated.length) updated[colIdx] = { ...updated[colIdx], selected: entryName(entry) }
        return updated
      })
      return
    }
    const target = entry.directory
    setCols((prev) => {
      const updated = prev.slice(0, colIdx + 1)
      updated[colIdx] = { ...updated[colIdx], selected: target.name }
      return [...updated, { dirId: target.id, name: target.name, path: target.path, entries: [], myPerms: 0, grantPerms: 0, loading: true }]
    })
    setActive(colIdx + 1)
    loadDir(target.id)
      .then((page) => {
        setCols((prev) => {
          const idx = colIdx + 1
          if (idx >= prev.length) return prev
          const updated = [...prev]
          updated[idx] = { ...updated[idx], entries: sortEntries(page.children), myPerms: page.my_perms, grantPerms: page.granted_perms, name: page.directory.name, path: page.directory.path, loading: false }
          return updated
        })
      })
      .catch((e: Error) => {
        setCols((prev) => {
          const idx = colIdx + 1
          if (idx >= prev.length) return prev
          const updated = [...prev]
          updated[idx] = { ...updated[idx], loading: false, error: e.message }
          return updated
        })
      })
  }, [])

  // ── 条目点击：单击（预览/选中）、Ctrl 多选、Shift 连选 ────────────

  const onItemClick = (colIdx: number, entry: Entry, e: React.MouseEvent) => {
    const modKey = e.metaKey || e.ctrlKey
    setActive(colIdx)
    if (modKey) {
      const name = entryName(entry)
      const curPrimary = colsRef.current[colIdx]?.selected
      const togglingOffPrimary = curPrimary === name
      setMultiSel((prev) => {
        const next = new Map(prev)
        const set = new Set(next.get(colIdx) ?? [])
        if (set.has(name) && curPrimary !== name) set.delete(name)
        else set.add(name)
        // 主选中项始终保留在多选中；主选中本身被 Ctrl 点掉时除外
        if (curPrimary && curPrimary !== name) set.add(curPrimary)
        next.set(colIdx, set)
        return next
      })
      setAnchor({ col: colIdx, name })
      setCols((prev) => prev.map((c, i) => (i === colIdx ? { ...c, selected: togglingOffPrimary ? undefined : name } : c)))
    } else if (e.shiftKey && anchorRef.current?.col === colIdx) {
      const col = colsRef.current[colIdx]
      if (col) {
        const names = col.entries.map(entryName)
        const aIdx = names.indexOf(anchorRef.current.name)
        const cIdx = names.indexOf(entryName(entry))
        if (aIdx >= 0 && cIdx >= 0) {
          const picked = new Set(names.slice(Math.min(aIdx, cIdx), Math.max(aIdx, cIdx) + 1))
          setMultiSel((prev) => {
            const next = new Map(prev)
            next.set(colIdx, picked)
            return next
          })
        }
      }
    } else {
      setMultiSel(new Map())
      setAnchor({ col: colIdx, name: entryName(entry) })
      // 普通单击清除该列陈旧选中（如橡皮筋锚点）；选中态随后由 navigate 统一设置（目录→高亮父项+展开右列；文件→高亮自身+截断列栈，M2.12）
      setCols((prev) => prev.map((c, i) => (i === colIdx ? { ...c, selected: undefined } : c)))
      navigate(colIdx, entry)
    }
  }

  const onItemDoubleClick = (colIdx: number, entry: Entry) => {
    if (entry.kind === 'file') onOpenFile(entry.file.id)
    else navigate(colIdx, entry)
  }

  // ── 内联重命名 ───────────────────────────────────────────────

  const startRename = (colIdx: number, entry: Entry) => {
    setMultiSel(new Map())
    setAnchor({ col: colIdx, name: entryName(entry) })
    setRenaming({ col: colIdx, name: entryName(entry), value: entryName(entry) })
  }

  const confirmRename = async () => {
    const r = renaming
    if (!r) return
    const value = r.value.trim()
    setRenaming(null)
    if (!value) return
    const col = colsRef.current[r.col]
    const entry = col?.entries.find((x) => entryName(x) === r.name)
    if (!col || !entry || value === entryName(entry)) return
    setRenamingBusy(true)
    if (entry.kind === 'file') {
      const { error } = await client.post('/api/v1/files/{id}/rename', { params: { id: entry.file.id }, body: { new_name: value } })
      setRenamingBusy(false)
      if (error) return
      msg.success('已重命名')
    } else {
      const { error } = await client.post('/api/v1/directories/{id}/rename', { params: { id: entry.directory.id }, body: { name: value } })
      setRenamingBusy(false)
      if (error) return
      msg.success('已重命名')
      // 目录改名：其后的列已过期，收起并刷新
      const idx = colsRef.current.findIndex((c) => c.dirId === entry.directory.id)
      if (idx >= 0) {
        setCols((prev) => prev.slice(0, idx + 1))
        setActive(Math.min(activeRef.current, idx))
      }
    }
    setMultiSel(new Map())
    setAnchor(null)
    if (previewRef.current && entryId(previewRef.current) === entryId(entry)) setPreviewEntry(null)
    await refreshAll()
  }

  // ── 右键菜单（条目 / 空白） ──────────────────────────────────

  const onItemContextMenu = (colIdx: number, entry: Entry, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setActive(colIdx)
    const col = colsRef.current[colIdx]
    if (!col || !me) return
    // M2.36：条目菜单按该条目自身的授权权限位（无管理员旁路；后端保证创建者恒为 ALL）。
    // 共享列条目来自 list_shared 的授权位（sharedToEntries 已写入 entry.my_perms）。
    const entryPerms = entry.my_perms ?? 0
    const names = multiSelRef.current.get(colIdx)
    if (names && names.size > 1 && names.has(entryName(entry))) {
      // 多选：仅批量删除（与 M2.6 表格版一致）
      const targets = col.entries.filter((x) => names.has(entryName(x)))
      const items: CtxItem[] = hasPerm(entryPerms, PERM.DELETE_RESTORE) && targets.length > 0
        ? [{ key: 'delete-many', label: `删除所选 ${targets.length} 项（移入回收站）`, danger: true, onClick: () => { setMultiSel(new Map()); setAnchor(null); confirmDeleteMany(targets) } }]
        : [{ key: 'none', label: '无可用操作', onClick: () => {} }]
      show(e.clientX, e.clientY, items)
      return
    }
    if (!names?.has(entryName(entry))) {
      setMultiSel(new Map())
      setCols((prev) => {
        const updated = [...prev]
        if (colIdx < updated.length) updated[colIdx] = { ...updated[colIdx], selected: entryName(entry) }
        return updated
      })
    }
    const actions: EntryMenuActions = { ...menuActions, rename: (en) => startRename(colIdx, en) }
    const items =
      entry.kind === 'file'
        ? toCtx(fileMenuItems(entryPerms, me!, entry, actions))
        : toCtx(dirMenuItems(entryPerms, me!, entry, actions))
    show(e.clientX, e.clientY, items)
  }

  const onColumnContextMenu = (colIdx: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setActive(colIdx)
    const col = colsRef.current[colIdx]
    if (!col) return
    // M2.36：按当前目录的实际授权位（不含管理员旁路）显隐新建/上传
    const canWrite = hasPerm(col.grantPerms, PERM.CREATE_UPLOAD)
    const items: CtxItem[] = [
      ...(canWrite ? [{ key: 'newdir', label: '新建目录', icon: <FolderPlus size={14} />, onClick: () => setNewDirOpen(true) }] : []),
      ...(canWrite ? [{ key: 'upload', label: '上传文件', icon: <CloudUpload size={14} />, onClick: () => pickFiles(col.dirId) }] : []),
      { key: 'refresh', label: '刷新', icon: <RefreshCw size={14} />, onClick: () => void refreshAll() },
    ]
    show(e.clientX, e.clientY, items)
  }

  // ── 上传（外部文件拖入 / 右键「上传文件」） ────────────────────

  const pickFiles = (dirId: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => {
      if (input.files && input.files.length > 0) void uploadExternal(input.files, dirId)
    }
    input.click()
  }

  const uploadExternal = async (files: FileList, dirId: string) => {
    const list = Array.from(files)
    if (list.length === 0) return
    let ok = 0
    for (const f of list) {
      const res = await uploadFile(dirId, f, () => {})
      if (res.ok) ok++
      else msg.error(`上传失败：${f.name}${res.message ? `（${res.message}）` : ''}`)
    }
    if (ok > 0) msg.success(`已上传 ${ok} 个文件`)
    await refreshAll()
  }

  // ── 拖拽移动（应用内直接移动，无确认弹窗） ────────────────────

  const onDragStart = (e: React.DragEvent, colIdx: number, entry: Entry) => {
    const col = colsRef.current[colIdx]
    const data: DragEntry = {
      kind: entry.kind,
      id: entryId(entry),
      name: entryName(entry),
      // M2.18b：目录条目拖拽时源 id 用条目自身（共享虚拟列里列 dirId 是哨兵值）
      dirId: entry.kind === 'directory' ? entry.directory.id : col?.dirId ?? '',
      path: entry.kind === 'directory' ? entry.directory.path : '',
    }
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(data))
    e.dataTransfer.setData('text/plain', entryName(entry))
    e.dataTransfer.effectAllowed = 'move'
  }

  const doMoveDirect = async (src: DragEntry, target: FmCol) => {
    if (src.dirId === target.dirId) return
    if (src.kind === 'directory' && src.path && (target.path === src.path || target.path.startsWith(src.path + '/'))) return
    if (src.kind === 'file') {
      const { error } = await client.post('/api/v1/files/{id}/move', { params: { id: src.id }, body: { target_directory_id: target.dirId } })
      if (error) return
    } else {
      const { error } = await client.post('/api/v1/directories/{id}/move', { params: { id: src.id }, body: { target_parent_id: target.dirId } })
      if (error) return
    }
    msg.success(`已移动「${src.name}」`)
    // 目录移动后其子树位置变化，预览可能失效
    if (src.kind === 'directory') setPreviewEntry(null)
    const idx = colsRef.current.findIndex((c) => c.dirId === src.id)
    if (idx >= 0) {
      setCols((prev) => prev.slice(0, idx + 1))
      setActive(Math.min(activeRef.current, idx))
    }
    setMultiSel(new Map())
    setAnchor(null)
    // M2.20：跨窗口拖拽——广播变更，让展示受影响列的 FM 窗口（含本窗）各自刷新
    window.dispatchEvent(new CustomEvent('vk-fm-changed', { detail: { src: src.dirId, target: target.dirId } }))
  }

  const onItemDragOver = (e: React.DragEvent, entry: Entry) => {
    if (entry.kind !== 'directory') return
    e.preventDefault()
    // M2.21：不再 stopPropagation——让事件冒泡到列级 onDragOver，整列高亮与条目高亮同时生效
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(entry.directory.id)
  }

  const onItemDrop = (e: React.DragEvent, entry: Entry) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    setDragOverCol(null)
    if (entry.kind !== 'directory') return
    // 目标目录即条目自身所在目录（该目录未必是已展开的列）
    const targetDir = entry.directory
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void uploadExternal(e.dataTransfer.files, targetDir.id)
      return
    }
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    try {
      const src = JSON.parse(raw) as DragEntry
      const col: FmCol = { dirId: targetDir.id, name: targetDir.name, path: targetDir.path, entries: [], myPerms: 0, grantPerms: 0, loading: false }
      void doMoveDirect(src, col)
    } catch {
      // 非本应用拖拽，忽略
    }
  }

  const onColumnDrop = (e: React.DragEvent, col: FmCol) => {
    e.preventDefault()
    setDropTarget(null)
    setDragOverCol(null)
    // M2.18b：共享虚拟列不是真实目录，不接受拖入（上传/移动）
    if (col.kind === 'shared') return
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void uploadExternal(e.dataTransfer.files, col.dirId)
      return
    }
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    try {
      void doMoveDirect(JSON.parse(raw) as DragEntry, col)
    } catch {
      // 非本应用拖拽，忽略
    }
  }

  // ── 框选（rubber band） ──────────────────────────────────────

  const onColumnItemsMouseDown = (colIdx: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-fm-entry]')) return
    const colEl = colScrollRefs.current.get(colIdx)
    if (!colEl) return
    const rect = colEl.getBoundingClientRect()
    const startY = e.clientY - rect.top + colEl.scrollTop
    setActive(colIdx)
    setBand({ col: colIdx, top: startY, height: 0 })
    const onMove = (ev: MouseEvent) => {
      const b = bandRef.current
      if (!b || b.col !== colIdx) return
      const curY = ev.clientY - rect.top + colEl.scrollTop
      setBand({ col: colIdx, top: Math.min(startY, curY), height: Math.abs(curY - startY) })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const b = bandRef.current
      setBand(null)
      if (!b || b.col !== colIdx || b.height < 4) return
      const col = colsRef.current[colIdx]
      if (!col) return
      const picked = new Set<string>()
      for (const it of Array.from(colEl.querySelectorAll<HTMLElement>('[data-fm-entry]'))) {
        const r = it.getBoundingClientRect()
        const itemTop = r.top - rect.top + colEl.scrollTop
        if (r.bottom - rect.top + colEl.scrollTop >= b.top && itemTop <= b.top + b.height) {
          const name = it.dataset.fmEntry
          if (name) picked.add(name)
        }
      }
      if (picked.size > 0) {
        const lastName = Array.from(picked).pop() ?? ''
        setMultiSel((prev) => {
          const next = new Map(prev)
          next.set(colIdx, picked)
          return next
        })
        setAnchor({ col: colIdx, name: lastName })
        setCols((prev) => {
          const updated = [...prev]
          if (colIdx < updated.length) updated[colIdx] = { ...updated[colIdx], selected: lastName }
          return updated
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── 键盘：↑↓←→ / Enter / Delete / F2 / Ctrl+A ───────────────────

  useEffect(() => {
    const el = navRef.current
    if (!el) return
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (modal || renaming || searching) return
      const modKey = e.metaKey || e.ctrlKey
      const colIdx = activeRef.current
      const col = colsRef.current[colIdx]
      if (!col) return
      const selectedEntries = (): Entry[] => {
        const names = multiSelRef.current.get(colIdx)
        if (names && names.size > 0) return col.entries.filter((r) => names.has(entryName(r)))
        if (col.selected) {
          const entry = col.entries.find((r) => entryName(r) === col.selected)
          if (entry) return [entry]
        }
        // 键盘光标锚点兜底：既无多选也无列选中态时（如 Shift 连选前的首次键盘导航）
        const a = anchorRef.current
        if (a && a.col === colIdx) {
          const entry = col.entries.find((r) => entryName(r) === a.name)
          if (entry) return [entry]
        }
        return []
      }
      if (modKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        const all = new Set(col.entries.map(entryName))
        setMultiSel((prev) => {
          const next = new Map(prev)
          next.set(colIdx, all)
          return next
        })
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const entries = selectedEntries()
        if (entries.length === 0) return
        // M2.38：Delete 键与右键菜单同口径——非创建者需持有 DELETE_RESTORE 位
        if (!entries.every((en) => hasPerm(en.my_perms ?? 0, PERM.DELETE_RESTORE))) return
        if (entries.length === 1) openModal({ type: 'delete', entry: entries[0] })
        else confirmDeleteMany(entries)
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        const entries = selectedEntries()
        if (entries.length === 1) {
          // M2.38：F2 内联重命名与右键菜单同口径——非创建者需持有 MODIFY_RENAME 位
          if (hasPerm(entries[0].my_perms ?? 0, PERM.MODIFY_RENAME)) startRename(colIdx, entries[0])
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const entries = selectedEntries()
        if (entries.length === 1) {
          if (entries[0].kind === 'file') onOpenFile(entries[0].file.id)
          else navigate(colIdx, entries[0])
        }
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const entries = col.entries
        if (entries.length === 0) return
        let idx = col.selected ? entries.findIndex((r) => entryName(r) === col.selected) : -1
        if (idx < 0) {
          const a = anchorRef.current
          if (a && a.col === colIdx) idx = entries.findIndex((r) => entryName(r) === a.name)
        }
        const nextIdx =
          e.key === 'ArrowUp'
            ? idx <= 0 ? entries.length - 1 : idx - 1
            : idx >= entries.length - 1 ? 0 : idx + 1
        const nextEntry = entries[nextIdx]
        setMultiSel(new Map())
        setAnchor({ col: colIdx, name: entryName(nextEntry) })
        setCols((prev) => {
          const updated = prev.slice(0, colIdx + 1)
          if (colIdx < updated.length) updated[colIdx] = { ...updated[colIdx], selected: entryName(nextEntry) }
          return updated
        })
        setPreviewEntry(nextEntry)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (activeRef.current > 0) {
          setActive(activeRef.current - 1)
          setMultiSel(new Map())
        }
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const entries = selectedEntries()
        if (entries.length === 1 && entries[0].kind === 'directory') navigate(colIdx, entries[0])
        return
      }
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [modal, renaming, searching, navigate, onOpenFile, confirmDeleteMany, openModal])

  // ── 路径栏 ───────────────────────────────────────────────────

  // 路径段取自列栈名称（Directory.path 是 ID 物化路径，不能直接展示）。
  // 首列即根（或 M2.18b 共享虚拟列）时跳过首列，路径段从第二个目录起展示。
  const firstIsRoot = cols.length > 0 && (cols[0].dirId === ROOT_DIR_ID || cols[0].kind === 'shared')
  const segments = firstIsRoot ? cols.slice(1).map((c) => c.name) : cols.map((c) => c.name)
  const segToCol = (segIdx: number) => segIdx + (firstIsRoot ? 1 : 0)

  const pathClick = (segIdx: number) => {
    const targetCol = segToCol(segIdx)
    if (targetCol >= colsRef.current.length) return
    setCols((prev) => {
      const sliced = prev.slice(0, targetCol + 1)
      const i = sliced.length - 1
      if (i >= 0) sliced[i] = { ...sliced[i], selected: undefined }
      return sliced
    })
    setActive(targetCol)
    setPreviewEntry(null)
    setMultiSel(new Map())
    setAnchor(null)
  }

  const refreshLast = () => {
    const last = colsRef.current[colsRef.current.length - 1]
    if (!last) return
    // M2.18b：末列是共享虚拟列时整体刷新（拉取共享列表）
    if (last.kind === 'shared') {
      void refreshAll()
      return
    }
    loadDir(last.dirId)
      .then((page) => {
        setCols((prev) => {
          const updated = [...prev]
          const i = updated.length - 1
          if (i < 0) return prev
          updated[i] = { ...updated[i], entries: sortEntries(page.children), myPerms: page.my_perms, grantPerms: page.granted_perms, name: page.directory.name, path: page.directory.path, loading: false, error: undefined }
          return updated
        })
      })
      .catch(() => void refreshAll())
  }

  // ── 新建目录 ─────────────────────────────────────────────────

  const createDir = async (name: string) => {
    setCreating(true)
    // M2.18b：共享虚拟列不能作为创建父目录，回退到根目录
    const parent = activeCol && activeCol.kind !== 'shared' ? activeCol.dirId : ROOT_DIR_ID
    const { error } = await client.post('/api/v1/directories', { body: { parent_id: parent, name } })
    setCreating(false)
    if (error) return
    setNewDirOpen(false)
    msg.success('目录已创建')
    await refreshAll()
  }

  // ── 渲染 ─────────────────────────────────────────────────────

  return (
    <div
      ref={navRef}
      className="vd-fm-nav"
      tabIndex={-1}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('input, textarea, [contenteditable]')) return
        ;(e.currentTarget as HTMLDivElement).focus()
      }}
    >
      {/* 路径栏 */}
      <div className="vd-fm-pathbar">
        <button
          type="button"
          className="vd-fm-path-seg"
          disabled={cols.length <= 1}
          title="返回根目录"
          onClick={() => {
            if (colsRef.current.length <= 1) return
            setCols((prev) => {
              const sliced = prev.slice(0, 1)
              sliced[0] = { ...sliced[0], selected: undefined }
              return sliced
            })
            setActive(0)
            setPreviewEntry(null)
            setMultiSel(new Map())
            setAnchor(null)
          }}
        >
          /
        </button>
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1
          return (
            <span key={`${seg}-${i}`} className="inline-flex items-center">
              <ChevronRight size={10} className="vd-faint" style={{ opacity: 0.4 }} />
              <button
                type="button"
                className={`vd-fm-path-seg${isLast ? ' is-last' : ''}`}
                onClick={() => { if (!isLast) pathClick(i) }}
                title={isLast ? seg : `前往 /${segments.slice(0, i + 1).join('/')}`}
              >
                {seg}
              </button>
            </span>
          )
        })}
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative', width: 170 }}>
          <Search size={13} className="vd-faint" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <Input
            size="sm"
            placeholder="搜索文件（全库）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('')
            }}
            style={{ paddingLeft: 26 }}
          />
        </div>
        <button type="button" className="vd-fm-path-refresh" onClick={refreshLast} title="刷新当前目录">
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          className="vd-fm-path-refresh"
          onClick={() => useWindows.getState().open('explorer')}
          title="新建文件管理器窗口"
        >
          <SquarePlus size={12} />
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0">
        {searching ? (
          <div className="flex-1 min-w-0 overflow-auto">
            <SearchResults q={q.trim()} onOpenFile={onOpenFile} />
          </div>
        ) : (
          <>
            <div className="vd-fm-sidebar">
              <div className="vd-fm-scope-group">
                <button
                  type="button"
                  className={`vd-fm-scope-btn${scope === 'personal' ? ' is-active' : ''}`}
                  onClick={goPersonal}
                >
                  <Folder size={13} />
                  <span>个人文件</span>
                </button>
                <button
                  type="button"
                  className={`vd-fm-scope-btn${scope === 'team' ? ' is-active' : ''}`}
                  onClick={() => void openScope('team')}
                >
                  <Users size={13} />
                  <span>团队共享</span>
                  {shared.team.length > 0 && <em className="vd-fm-badge">{shared.team.length}</em>}
                </button>
                <button
                  type="button"
                  className={`vd-fm-scope-btn${scope === 'me' ? ' is-active' : ''}`}
                  onClick={() => void openScope('me')}
                >
                  <Share2 size={13} />
                  <span>分享给我</span>
                  {shared.me.length > 0 && <em className="vd-fm-badge">{shared.me.length}</em>}
                </button>
              </div>
              <div className="vd-fm-sidebar-hint">
                {scope === 'personal'
                  ? '你创建的目录与上传的文件。他人共享的目录见「团队共享 / 分享给我」。'
                  : scope === 'team'
                    ? '共享给你所在团队的目录。'
                    : '分享给你个人的目录。'}
              </div>
            </div>
          <div ref={scrollRef} className="vd-fm-cols">
              {cols.map((col, colIdx) => (
                <div
                  key={col.dirId}
                  className={'vd-fm-col' + (col.kind !== 'shared' && dragOverCol === col.dirId ? ' is-drop-col' : '')}
                  role="listbox"
                  onDragOver={(e) => {
                    if (col.kind === 'shared') return
                    e.preventDefault()
                    // M2.21：整列高亮，提示“将移入/上传到此目录”
                    e.dataTransfer.dropEffect =
                      e.dataTransfer.types && e.dataTransfer.types.includes('Files') ? 'copy' : 'move'
                    setDragOverCol(col.dirId)
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null)
                  }}
                  onDrop={(e) => onColumnDrop(e, col)}
                  onContextMenu={(e) => {
                    if ((e.target as HTMLElement).closest('[data-fm-entry]')) return
                    onColumnContextMenu(colIdx, e)
                  }}
                >
                  {col.kind !== 'shared' && dragOverCol === col.dirId && (
                    <div className="vd-fm-col-drop-hint">松手放入此目录</div>
                  )}
                  {col.loading ? (
                    <div className="vd-fm-col-center">
                      <Spin />
                    </div>
                  ) : col.error ? (
                    <div className="vd-fm-col-center vd-faint" style={{ fontSize: 11, padding: '16px 8px', textAlign: 'center' }}>{col.error}</div>
                  ) : col.entries.length === 0 ? (
                    <div className="vd-fm-col-center vd-faint" style={{ fontSize: 12 }}>
                      {col.kind === 'shared' ? '暂无共享目录' : '空目录'}
                    </div>
                  ) : (
                    <div
                      className="vd-fm-col-items"
                      ref={(el) => {
                        if (el) colScrollRefs.current.set(colIdx, el)
                        else colScrollRefs.current.delete(colIdx)
                      }}
                      onMouseDown={(e) => onColumnItemsMouseDown(colIdx, e)}
                    >
                      {band?.col === colIdx && (
                        <div className="vd-fm-marquee" style={{ top: band.top, height: band.height }} />
                      )}
                      {col.entries.map((entry) => {
                        const name = entryName(entry)
                        const isPrimary = col.selected === name
                        const isLastCol = colIdx === cols.length - 1
                        const isAncestorSel = isPrimary && !isLastCol
                        const isCurrentSel = isPrimary && isLastCol
                        const isMulti = multiSel.get(colIdx)?.has(name) ?? false
                        const isDragTarget = entry.kind === 'directory' && dropTarget === entry.directory.id
                        const isRenaming = renaming?.col === colIdx && renaming.name === name
                        const highlighted = isPrimary || isMulti
                        // M2.18b：共享列条目显示分享来源副行（owner/团队 + 只读标记）
                        const sharedMeta =
                          col.kind === 'shared' && entry.kind === 'directory'
                            ? col.sharedMeta?.[entryId(entry)]
                            : undefined
                        const iconColor =
                          isCurrentSel || (isMulti && colIdx === active)
                            ? '#fff'
                            : isAncestorSel
                              ? 'var(--vd-accent)'
                              : undefined
                        const itemClass = [
                          'vd-fm-item',
                          isCurrentSel ? 'is-current' : '',
                          isAncestorSel ? 'is-ancestor' : '',
                          isMulti ? 'is-multi' : '',
                          isDragTarget ? 'is-drop' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')
                        return (
                          <div
                            key={name}
                            role="option"
                            aria-selected={highlighted || undefined}
                            data-fm-entry={name}
                            draggable={!isRenaming}
                            onDragStart={(e) => onDragStart(e, colIdx, entry)}
                            onDragOver={(e) => onItemDragOver(e, entry)}
                            onDragLeave={() => {
                              const k = entry.kind === 'directory' ? entry.directory.id : null
                              setDropTarget((d) => (d === k ? null : d))
                            }}
                            onDrop={(e) => onItemDrop(e, entry)}
                            className={itemClass}
                            onClick={(e) => onItemClick(colIdx, entry, e)}
                            onDoubleClick={() => onItemDoubleClick(colIdx, entry)}
                            onContextMenu={(e) => onItemContextMenu(colIdx, entry, e)}
                          >
                            {entry.kind === 'directory' ? (
                              <FolderIcon size={13} style={{ flexShrink: 0, color: iconColor ?? 'var(--vd-warning, #d97706)' }} />
                            ) : (
                              <FileIcon name={entry.file.name} mime={entry.file.mime} size={13} style={{ flexShrink: 0, ...(iconColor ? { color: iconColor } : {}) }} />
                            )}
                            {entry.kind === 'file' && entry.lock && (
                              <span
                                className="vd-fm-item-lock"
                                title={`已锁定：${entry.lock.locked_by_name}（${entry.lock.locked_at}）`}
                              >
                                <Lock size={11} />
                              </span>
                            )}
                            {isRenaming ? (
                              <input
                                className="vd-fm-rename"
                                autoFocus
                                value={renaming.value}
                                disabled={renamingBusy}
                                onChange={(e) => setRenaming((r) => (r ? { ...r, value: e.target.value } : r))}
                                onKeyDown={(e) => {
                                  e.stopPropagation()
                                  if (e.key === 'Enter') void confirmRename()
                                  if (e.key === 'Escape') setRenaming(null)
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onFocus={(e) => {
                                  const el = e.target
                                  const dot = el.value.lastIndexOf('.')
                                  if (dot > 0) el.setSelectionRange(0, dot)
                                  else el.select()
                                }}
                              />
                            ) : (
                              <span className="vd-fm-item-text" title={name}>
                                <span className="truncate">{name}</span>
                                {sharedMeta && (
                                  <span className="vd-fm-item-meta">
                                    {col.sharedScope === 'team'
                                      ? sharedMeta.team_name ?? '团队'
                                      : sharedMeta.owner_name ?? '用户'}
                                    {(sharedMeta.perms & 4) === 0 ? ' · 只读' : ''}
                                  </span>
                                )}
                              </span>
                            )}
                            {entry.kind === 'directory' && !isRenaming && (
                              <ChevronRight size={11} className="shrink-0" style={{ opacity: 0.5, marginLeft: 'auto' }} />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {previewEntry && (
              <FileInfoPanel
                entry={previewEntry}
                onClose={() => setPreviewEntry(null)}
                context={{
                  // M2.21：条目位于「团队共享/分享给我」虚拟列时携带共享元信息（来源、我的权限）
                  sharedMeta:
                    cols.find((c) => c.kind === 'shared')?.sharedMeta?.[entryId(previewEntry)] ?? undefined,
                  scope,
                }}
              />
            )}
          </>
        )}
      </div>

      {/* 弹窗（与 EntryTable 同款交互，重命名除外 → 列内内联） */}
      {modal?.type === 'move' && (
        <MoveCopyModal
          open
          mode="move"
          entryKind={modal.entry.kind}
          entryId={entryId(modal.entry)}
          entryName={entryName(modal.entry)}
          sourceDirId={
            modal.entry.kind === 'file'
              ? modal.entry.file.directory_id
              : modal.entry.directory.parent_id ?? ROOT_DIR_ID
          }
          onSubmit={(targetDirId) => doMove(targetDirId)}
        />
      )}
      {modal?.type === 'copy' && modal.entry.kind === 'file' && (
        <MoveCopyModal
          open
          mode="copy"
          entryKind="file"
          entryId={modal.entry.file.id}
          entryName={modal.entry.file.name}
          sourceDirId={modal.entry.file.directory_id}
          onSubmit={(targetDirId, newName) => doCopy(targetDirId, newName)}
        />
      )}
      {modal?.type === 'delete' && (
        <Modal
          open
          title={`删除「${entryName(modal.entry)}」`}
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>取消</Btn>
              <Btn variant="danger" loading={deleting} onClick={() => void doConfirmDelete()}>
                删除
              </Btn>
            </>
          }
        >
          <p className="m-0">
            删除后移入回收站，保留 180 天后自动清理。
            {modal.entry.kind === 'directory' ? '包含其中的所有文件与子目录。' : ''}
          </p>
        </Modal>
      )}
      {modal?.type === 'delete-many' && (
        <Modal
          open
          title={`删除 ${modal.entries.length} 项`}
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>取消</Btn>
              <Btn variant="danger" loading={deleting} onClick={() => void doConfirmDeleteMany()}>
                删除
              </Btn>
            </>
          }
        >
          <p className="m-0">删除后移入回收站，保留 180 天后自动清理。共 {modal.entries.length} 项。</p>
        </Modal>
      )}
      {modal?.type === 'unlock' && (
        <Modal
          open
          title="强制解锁"
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>取消</Btn>
              <Btn variant="danger" onClick={() => void doUnlock(modal.file, true)}>
                强制解锁
              </Btn>
            </>
          }
        >
          <p className="m-0">
            文件当前由 {modal.lock.locked_by_name} 锁定。强制解锁将直接释放锁，可能影响对方正在进行的编辑。
          </p>
        </Modal>
      )}
      {modal?.type === 'versions' && (
        <VersionsDrawer open fileId={modal.file.id} fileName={modal.file.name} onClose={close} />
      )}
      {modal?.type === 'grants' && (
        <GrantsModal
          open
          dirId={modal.dir.id}
          dirName={modal.dir.name}
          onClose={() => {
            close()
            // M2.23：目录/文件权限变更后始终刷新共享列与当前列（预览面板需同步授权与分享状态）
            void fetchShared('team')
            void fetchShared('me')
            void refreshAll()
          }}
        />
      )}
      {modal?.type === 'file-grants' && (
        <GrantsModal
          open
          dirId={modal.dir.id}
          dirName={modal.dir.name}
          file={{ id: modal.file.id, name: modal.file.name }}
          onClose={() => {
            close()
            // M2.23：文件级权限变更后同步刷新（预览面板授权行/分享状态）
            void fetchShared('team')
            void fetchShared('me')
            void refreshAll()
          }}
        />
      )}
      {modal?.type === 'share' && (
        <ShareModal
          open
          resourceType={modal.entry.kind === 'file' ? 'file' : 'directory'}
          resourceId={modal.entry.kind === 'file' ? modal.entry.file.id : modal.entry.directory.id}
          resourceName={entryName(modal.entry)}
          onClose={() => {
            close()
            // M2.23：分享链接可能变更，刷新后预览面板链接计数同步
            void fetchShared('team')
            void fetchShared('me')
            void refreshAll()
          }}
        />
      )}
      {modal?.type === 'publish' && (
        <PublishModal open dirId={modal.entry.directory.id} dirName={modal.entry.directory.name} onClose={close} />
      )}

      <NewDirModal open={newDirOpen} submitting={creating} onSubmit={createDir} />
    </div>
  )
}

export default ColumnView
