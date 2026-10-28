import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, CloudUpload, FolderPlus, RefreshCw, Search } from 'lucide-react'
import { client } from '@/api'
import type { Entry } from '@/api/schema'
import { msg } from '@/components/ui/toast'
import { Btn, Input, Modal, Spin, type DropItem } from '@/components/ui/kit'
import FileIcon, { FolderIcon } from '@/components/FileIcon'
import VersionsDrawer from '@/components/VersionsDrawer'
import { useContextMenu, type CtxItem } from '@/shell/ContextMenu'
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
  loading: boolean
  error?: string
  selected?: string
}

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
  /** 最后一列变化时回传（null = 根），用于窗口状态持久化。 */
  onNavigateDir: (dirId: string | null) => void
  /** 打开文件详情窗口。 */
  onOpenFile: (fileId: string) => void
}

const DRAG_MIME = 'application/x-vento-entry'

const entryName = (r: Entry) => (r.kind === 'file' ? r.file.name : r.directory.name)
const entryId = (r: Entry) => (r.kind === 'file' ? r.file.id : r.directory.id)

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
const ColumnView = ({ dirId, onNavigateDir, onOpenFile }: ColumnViewProps) => {
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
  const [band, setBand] = useState<{ col: number; top: number; height: number } | null>(null)
  const [q, setQ] = useState('')

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

  const searching = q.trim().length > 0
  const activeCol = cols[active]

  const refreshAll = useCallback(async () => {
    const cur = colsRef.current
    if (cur.length === 0) return
    const results = await Promise.all(
      cur.map((c) =>
        loadDir(c.dirId).then(
          (page) => ({ entries: sortEntries(page.children), myPerms: page.my_perms, name: page.directory.name, error: null as string | null }),
          (e: Error) => ({ entries: [] as Entry[], myPerms: c.myPerms, name: c.name, error: e.message }),
        ),
      ),
    )
    setCols((prev) =>
      prev.map((c, i) => {
        const r = results[i]
        const selected = r.entries.some((e) => entryName(e) === c.selected) ? c.selected : undefined
        return { ...c, entries: r.entries, myPerms: r.myPerms, name: r.name, selected, loading: false, error: r.error ?? undefined }
      }),
    )
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

  useEffect(() => {
    const target = dirId ?? ROOT_DIR_ID
    const cur = colsRef.current
    if (cur.length > 0 && cur[cur.length - 1].dirId === target) return
    let cancelled = false
    const build = async () => {
      const chain: string[] = [ROOT_DIR_ID]
      if (dirId && dirId !== ROOT_DIR_ID) {
        let curId: string | null = dirId
        let guard = 0
        while (curId && curId !== ROOT_DIR_ID && guard < 64) {
          chain.unshift(curId)
          try {
            const page = await loadDir(curId)
            curId = page.directory.parent_id
          } catch {
            return
          }
          guard++
        }
      }
      if (cancelled) return
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
            loading: false,
          })
        } catch (e) {
          if (cancelled) return
          loaded.push({ dirId: id, name: '…', path: '/', entries: [], myPerms: 0, loading: false, error: (e as Error).message })
          return
        }
      }
      setCols(loaded)
      setActive(loaded.length - 1)
      setPreviewEntry(null)
      setMultiSel(new Map())
      setAnchor(null)
    }
    void build()
    return () => {
      cancelled = true
    }
  }, [dirId])

  // ── 最后一列变化 → 回传窗口状态 ─────────────────────────────

  const lastDirId = cols.length > 0 ? cols[cols.length - 1].dirId : ROOT_DIR_ID
  useEffect(() => {
    onNavigateDir(lastDirId === ROOT_DIR_ID ? null : lastDirId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDirId])

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
      return [...updated, { dirId: target.id, name: target.name, path: target.path, entries: [], myPerms: 0, loading: true }]
    })
    setActive(colIdx + 1)
    loadDir(target.id)
      .then((page) => {
        setCols((prev) => {
          const idx = colIdx + 1
          if (idx >= prev.length) return prev
          const updated = [...prev]
          updated[idx] = { ...updated[idx], entries: sortEntries(page.children), myPerms: page.my_perms, name: page.directory.name, path: page.directory.path, loading: false }
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
    const names = multiSelRef.current.get(colIdx)
    if (names && names.size > 1 && names.has(entryName(entry))) {
      // 多选：仅批量删除（与 M2.6 表格版一致）
      const targets = col.entries.filter((x) => names.has(entryName(x)))
      const items: CtxItem[] = hasPerm(col.myPerms, PERM.DELETE_RESTORE) && targets.length > 0
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
        ? toCtx(fileMenuItems(col.myPerms, me!, entry, actions))
        : toCtx(dirMenuItems(col.myPerms, me!, entry, actions))
    show(e.clientX, e.clientY, items)
  }

  const onColumnContextMenu = (colIdx: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setActive(colIdx)
    const col = colsRef.current[colIdx]
    if (!col) return
    const canWrite = hasPerm(col.myPerms, PERM.CREATE_UPLOAD)
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
      dirId: col?.dirId ?? '',
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
    await refreshAll()
  }

  const onItemDragOver = (e: React.DragEvent, entry: Entry) => {
    if (entry.kind !== 'directory') return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(entry.directory.id)
  }

  const onItemDrop = (e: React.DragEvent, entry: Entry) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
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
      const col: FmCol = { dirId: targetDir.id, name: targetDir.name, path: targetDir.path, entries: [], myPerms: 0, loading: false }
      void doMoveDirect(src, col)
    } catch {
      // 非本应用拖拽，忽略
    }
  }

  const onColumnDrop = (e: React.DragEvent, col: FmCol) => {
    e.preventDefault()
    setDropTarget(null)
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
        if (entries.length === 1) openModal({ type: 'delete', entry: entries[0] })
        else confirmDeleteMany(entries)
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        const entries = selectedEntries()
        if (entries.length === 1) startRename(colIdx, entries[0])
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

  // 路径段取自列栈名称（Directory.path 是 ID 物化路径，不能直接展示）
  const segments = cols.slice(1).map((c) => c.name)

  const pathClick = (segIdx: number) => {
    const targetCol = segIdx + 1
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
    loadDir(last.dirId)
      .then((page) => {
        setCols((prev) => {
          const updated = [...prev]
          const i = updated.length - 1
          if (i < 0) return prev
          updated[i] = { ...updated[i], entries: sortEntries(page.children), myPerms: page.my_perms, name: page.directory.name, path: page.directory.path, loading: false, error: undefined }
          return updated
        })
      })
      .catch(() => void refreshAll())
  }

  // ── 新建目录 ─────────────────────────────────────────────────

  const createDir = async (name: string) => {
    setCreating(true)
    const parent = activeCol?.dirId ?? ROOT_DIR_ID
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
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0">
        {searching ? (
          <div className="flex-1 min-w-0 overflow-auto">
            <SearchResults q={q.trim()} onOpenFile={onOpenFile} />
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="vd-fm-cols">
              {cols.map((col, colIdx) => (
                <div
                  key={col.dirId}
                  className="vd-fm-col"
                  role="listbox"
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => onColumnDrop(e, col)}
                  onContextMenu={(e) => {
                    if ((e.target as HTMLElement).closest('[data-fm-entry]')) return
                    onColumnContextMenu(colIdx, e)
                  }}
                >
                  {col.loading ? (
                    <div className="vd-fm-col-center">
                      <Spin />
                    </div>
                  ) : col.error ? (
                    <div className="vd-fm-col-center vd-faint" style={{ fontSize: 11, padding: '16px 8px', textAlign: 'center' }}>{col.error}</div>
                  ) : col.entries.length === 0 ? (
                    <div className="vd-fm-col-center vd-faint" style={{ fontSize: 12 }}>空目录</div>
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
                              <span className="truncate" title={name}>{name}</span>
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
            {previewEntry && <FileInfoPanel entry={previewEntry} onClose={() => setPreviewEntry(null)} />}
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
        <GrantsModal open dirId={modal.dir.id} dirName={modal.dir.name} onClose={close} />
      )}
      {modal?.type === 'share' && (
        <ShareModal
          open
          resourceType={modal.entry.kind === 'file' ? 'file' : 'directory'}
          resourceId={modal.entry.kind === 'file' ? modal.entry.file.id : modal.entry.directory.id}
          resourceName={entryName(modal.entry)}
          onClose={close}
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
