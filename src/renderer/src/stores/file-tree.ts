import { defineStore } from 'pinia'
import { reactive, ref, shallowReactive, shallowRef, watch } from 'vue'
import type { FileListing, FileSearchList, FileTouch, FileTouchKind, FileTreeWatch, GitTreeStatus, TerminalInfo } from '@shared/types'
import { sameData } from '@shared/utils'
import { errorMessage } from '@/lib/errors'
import { absolutePath, ancestors, treePathOf } from '@/lib/file-tree'
import type { DiffFile } from '@/lib/workspace'
import { useAppStore } from './app'
import { useTerminalsStore, type GroupView } from './terminals'

/** Width of the tree (px) before it is dragged, and the bounds it is dragged within. */
export const DEFAULT_TREE_WIDTH = 280
export const MIN_TREE_WIDTH = 180
export const MAX_TREE_WIDTH = 640
/** The tree takes at most this share of its area; the terminal keeps the rest. */
export const MAX_TREE_SHARE = 0.6

const STORAGE_KEY = 'claude-manager.file-tree'
/** Folders whose open subfolders are remembered, the most recently shown ones. */
const MAX_REMEMBERED_ROOTS = 40
/** Trees kept in memory while no tab shows them, so they come back at once. */
const MAX_IDLE_MODELS = 12
/** Git's status is asked again at most this often while files keep changing (ms). */
const STATUS_DELAY_MS = 400
/** How long a file Claude touched stays lit after the touch (ms). */
const TOUCH_MS = 5000
/** A folder opened to show what Claude touches closes again this long after its last touch (ms). */
const CLAUDE_FOLDER_MS = 10_000
/**
 * Of the files one report brings, the first so many open their folders, by kind: a commit, a search or
 * a shell command can bring many, and would unfold the whole tree.
 */
const REVEAL_LIMIT: Record<FileTouchKind, number> = { read: 30, write: 30, commit: 30, search: 10 }
/** The share of a tab the changes of a file take beside its terminal, and its bounds. */
const DEFAULT_DIFF_SHARE = 0.5
const MIN_DIFF_SHARE = 0.2
const MAX_DIFF_SHARE = 0.8

export const SEPARATOR = window.api.platform === 'win32' ? '\\' : '/'

interface Saved {
  width: number
  /** Terminals (by id) whose tree is open. */
  open: string[]
  /** Open folders by the tree's folder, the least recently used first. */
  expanded: Record<string, string[]>
  showIgnored: boolean
  diffShare: number
}

/** A tree of a folder, shared by every tab that works in it. */
export interface TreeModel {
  root: string
  /** The entries of the folders loaded so far, by path ('' is the folder itself). */
  listings: Map<string, FileListing>
  /** Folders that could not be read, with the reason. */
  errors: Map<string, string>
  expanded: Set<string>
  /** Git's view of the folder; null outside a repository (and until it is known). */
  git: GitTreeStatus | null
  /** The files for the search; null until it was searched once. */
  search: FileSearchList | null
  searchLoading: boolean
  /** Files changed since the search list was made. */
  searchStale: boolean
  /** What is typed into the tree's search. */
  query: string
  /** The selected entry, also the one the keyboard moves from. */
  selected: string | null
  scrollTop: number
}

/** What a tab's tree is about: the tab (its id keeps the tree open), its folder and the session working there. */
export interface TreeTarget {
  id: string
  root: string
  /** The session or shell the tree's actions go to; for a browser the session it belongs to. */
  session: TerminalInfo
}

function readSaved(): Partial<Saved> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown
    return value && typeof value === 'object' ? (value as Partial<Saved>) : {}
  } catch {
    return {}
  }
}

const clampWidth = (width: number) => Math.round(Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, width)))
const clampShare = (share: number) => Math.min(MAX_DIFF_SHARE, Math.max(MIN_DIFF_SHARE, share))

/** A file Claude touched lately, and until when it stays lit. */
export interface Touch {
  kind: FileTouchKind
  until: number
}

/**
 * The file trees of the tabs. Whether a tree is open belongs to the tab (a session, a shell or, with
 * the tabs in groups, a browser for its session's folder), so every tab keeps its own; the tree itself
 * belongs to the folder: tabs in the same folder share its open folders, which are also remembered
 * for the next time. Folders on screen are watched, so the tree follows what Claude changes.
 */
export const useFileTreeStore = defineStore('file-tree', () => {
  const terminals = useTerminalsStore()
  const app = useAppStore()
  const saved = readSaved()

  const width = ref(clampWidth(typeof saved.width === 'number' ? saved.width : DEFAULT_TREE_WIDTH))
  const showIgnored = ref(saved.showIgnored !== false)
  const diffShare = ref(clampShare(typeof saved.diffShare === 'number' ? saved.diffShare : DEFAULT_DIFF_SHARE))
  /**
   * With the tabs in one tab bar: the file whose changes a tab shows beside its terminal, by the tab
   * whose tree it came from. With the tabs in groups a file gets a tab of its own instead.
   */
  const splitDiffs = reactive(new Map<string, DiffFile>())
  /** Tabs whose tree is open; filled once the terminals are known (their ids may be new after a restart). */
  const open = reactive(new Set<string>())
  const remembered: Record<string, string[]> =
    saved.expanded && typeof saved.expanded === 'object' ? { ...saved.expanded } : {}
  /** The open tabs of the last run are only taken over once the terminals are loaded. */
  let ready = false

  watch(
    () => terminals.restoredIds,
    (ids) => {
      if (!ids || ready) return
      ready = true
      const current = new Set(terminals.terminals.map((t) => t.id))
      for (const id of Array.isArray(saved.open) ? saved.open : []) {
        const next = typeof id === 'string' ? (ids.get(id) ?? id) : null
        if (next && current.has(next)) open.add(next)
      }
    },
    { immediate: true },
  )

  // A closed tab's tree is forgotten; one that takes another's place (account switch, restart) keeps it.
  watch(
    () => terminals.terminals,
    (list) => {
      if (!ready) return
      const ids = new Set(list.map((t) => t.id))
      for (const id of open) if (!ids.has(id)) open.delete(id)
      for (const id of splitDiffs.keys()) if (!ids.has(id)) splitDiffs.delete(id)
    },
  )
  terminals.onReplaced((oldId, newId) => {
    if (open.delete(oldId)) open.add(newId)
    const diff = splitDiffs.get(oldId)
    if (diff) {
      splitDiffs.delete(oldId)
      splitDiffs.set(newId, diff)
    }
  })

  function save(): void {
    if (!ready) return
    try {
      const data: Saved = { width: width.value, open: [...open], expanded: remembered, showIgnored: showIgnored.value, diffShare: diffShare.value }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // Storage full or blocked: the trees are just not remembered.
    }
  }
  watch([width, showIgnored, diffShare, () => [...open].join('\n')], save)

  /**
   * The tree of a tab: its folder is the one its session works in (a worktree's folder for a session in
   * one). Null for a tab without a folder, e.g. a browser on its own.
   */
  function targetOf(terminal: TerminalInfo | null | undefined): TreeTarget | null {
    if (!terminal) return null
    const session = terminals.workingTerminalOf(terminal)
    const root = session?.worktree?.path || session?.cwd || ''
    return session && root ? { id: terminal.id, root, session } : null
  }

  /**
   * The tree a group shows with its tab: a terminal's, or for a file's tab the tree of a tab working in
   * that folder (of its group first, one whose tree is open first), so the tree stays beside the file.
   */
  function targetOfGroup(group: GroupView | null | undefined): TreeTarget | null {
    const item = group?.tabs.find((t) => t.id === group.active)
    if (!group || !item) return null
    if (item.terminal) return targetOf(item.terminal)
    if (!item.diff) return null
    const root = item.diff.root
    const candidates = [...group.tabs.flatMap((t) => (t.terminal ? [t.terminal] : [])), ...terminals.terminals]
      .map(targetOf)
      .filter((target): target is TreeTarget => target?.root === root)
    return candidates.find((target) => open.has(target.id)) ?? candidates[0] ?? null
  }

  const isOpen = (id: string | null | undefined) => !!id && open.has(id)

  function setOpen(id: string, value: boolean): void {
    if (value) open.add(id)
    else open.delete(id)
  }

  function toggle(id: string): void {
    setOpen(id, !open.has(id))
  }

  function setWidth(next: number): void {
    width.value = clampWidth(next)
  }

  function setDiffShare(next: number): void {
    diffShare.value = clampShare(next)
  }

  // ── A file's changes ──

  /**
   * Shows the changes of a file of a tab's tree: with the tabs in groups as a tab of the group
   * (`groupId`; `keep`: one that stays, else one that previews), otherwise beside the tab's terminal.
   */
  function showDiff(target: TreeTarget, path: string, options: { groupId?: string | null; keep?: boolean } = {}): void {
    const file = { root: target.root, path }
    if (terminals.grouped) {
      if (options.groupId) terminals.openDiff(file, options.groupId, options.keep ?? false)
    } else if (!sameData(splitDiffs.get(target.id), file)) {
      splitDiffs.set(target.id, file)
    }
  }

  const splitDiffOf = (id: string | null | undefined) => (id ? (splitDiffs.get(id) ?? null) : null)

  function closeSplitDiff(id: string): void {
    splitDiffs.delete(id)
  }

  // ── Trees by folder ──

  /** The trees by folder, the least recently shown first. */
  const models = new Map<string, TreeModel>()
  /** How many trees on screen show each folder; the folders with none are idle and not watched. */
  const holders = new Map<string, number>()
  /** The latest load of each folder of each tree; an older answer is dropped. */
  const loads = new Map<string, number>()
  let loadCount = 0
  const statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Folders whose status is being asked for, and those to ask again once the answer is there. */
  const statusBusy = new Set<string>()
  const statusAgain = new Set<string>()
  /** Folders watched besides the open ones, e.g. the folder of a file whose changes are shown (Linux needs them). */
  const pinned = new Map<string, Map<string, number>>()

  function createModel(root: string): TreeModel {
    return shallowReactive({
      root,
      listings: shallowReactive(new Map()),
      errors: shallowReactive(new Map()),
      expanded: reactive(new Set(remembered[root] ?? [])),
      git: null,
      search: null,
      searchLoading: false,
      searchStale: false,
      query: '',
      selected: null,
      scrollTop: 0,
    }) as TreeModel
  }

  /** A tree on screen holds its folder: it is loaded (again) and watched until it lets go. */
  function hold(root: string): TreeModel {
    let model = models.get(root)
    if (!model) {
      model = createModel(root)
      void loadDir(model, '')
      for (const dir of model.expanded) if (isShownDir(model, dir)) void loadDir(model, dir)
    } else if (!holders.has(root)) {
      // Shown again: what it shows may have changed meanwhile.
      reloadAll(model)
    }
    models.delete(root)
    models.set(root, model)
    holders.set(root, (holders.get(root) ?? 0) + 1)
    void loadStatus(model)
    queueWatch()
    return model
  }

  /** Watches a folder of a held tree besides its open ones, until the returned function is called. */
  function pinDir(root: string, dir: string): () => void {
    const dirs = pinned.get(root) ?? new Map<string, number>()
    pinned.set(root, dirs)
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
    queueWatch()
    return () => {
      const count = (dirs.get(dir) ?? 0) - 1
      if (count > 0) dirs.set(dir, count)
      else dirs.delete(dir)
      if (dirs.size === 0 && pinned.get(root) === dirs) pinned.delete(root)
      queueWatch()
    }
  }

  function release(root: string): void {
    const count = (holders.get(root) ?? 0) - 1
    if (count > 0) holders.set(root, count)
    else holders.delete(root)
    queueWatch()
    // Idle trees beyond the limit go, the longest unused first (a Map keeps the order of insertion).
    const idle = [...models.keys()].filter((r) => !holders.has(r))
    for (const r of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_MODELS))) models.delete(r)
  }

  function key(model: TreeModel, dir: string): string {
    return `${model.root}\n${dir}`
  }

  async function loadDir(model: TreeModel, dir: string): Promise<void> {
    const id = ++loadCount
    loads.set(key(model, dir), id)
    try {
      const listing = await window.api.files.list(absolutePath(model.root, dir, SEPARATOR))
      if (loads.get(key(model, dir)) !== id) return
      const old = model.listings.get(dir)
      // Unchanged: the rows aren't computed again.
      if (!old || !sameData(old, listing)) model.listings.set(dir, Object.freeze(listing))
      model.errors.delete(dir)
    } catch (error) {
      if (loads.get(key(model, dir)) !== id) return
      model.listings.delete(dir)
      model.errors.set(dir, readError(error))
    } finally {
      if (loads.get(key(model, dir)) === id) loads.delete(key(model, dir))
    }
  }

  /** The reason a folder can't be shown, in words. */
  function readError(error: unknown): string {
    const message = errorMessage(error)
    if (/ENOENT/.test(message)) return 'Ordner nicht gefunden'
    if (/EACCES|EPERM/.test(message)) return 'Zugriff verweigert'
    if (/ENOTDIR/.test(message)) return 'Kein Ordner'
    return message
  }

  function reloadAll(model: TreeModel): void {
    for (const dir of new Set(['', ...model.listings.keys(), ...model.errors.keys()])) {
      if (dir === '' || isShownDir(model, dir)) void loadDir(model, dir)
      else {
        // A folder closed meanwhile is loaded again when it is opened.
        model.listings.delete(dir)
        model.errors.delete(dir)
      }
    }
    model.searchStale = true
  }

  /** Open, and every folder it lies in too. */
  function isShownDir(model: TreeModel, dir: string): boolean {
    return model.expanded.has(dir) && ancestors(dir).every((a) => model.expanded.has(a))
  }

  async function loadStatus(model: TreeModel): Promise<void> {
    const root = model.root
    if (statusBusy.has(root)) {
      statusAgain.add(root)
      return
    }
    statusBusy.add(root)
    try {
      const status = await window.api.files.status(root).catch(() => null)
      if (models.get(root) === model && !sameData(model.git, status)) model.git = status ? Object.freeze(status) : null
    } finally {
      statusBusy.delete(root)
      if (statusAgain.delete(root)) scheduleStatus(model)
    }
  }

  function scheduleStatus(model: TreeModel): void {
    if (statusTimers.has(model.root)) return
    statusTimers.set(
      model.root,
      setTimeout(() => {
        statusTimers.delete(model.root)
        if (models.get(model.root) === model) void loadStatus(model)
      }, STATUS_DELAY_MS),
    )
  }

  // The folders on screen are watched; main reports their changes together.
  let watchQueued = false
  let watching = ''
  function queueWatch(): void {
    if (watchQueued) return
    watchQueued = true
    queueMicrotask(() => {
      watchQueued = false
      const trees: FileTreeWatch[] = [...holders.keys()].flatMap((root) => {
        const model = models.get(root)
        if (!model) return []
        const dirs = new Set([...model.expanded].filter((dir) => model.listings.has(dir)))
        for (const dir of pinned.get(root)?.keys() ?? []) dirs.add(dir)
        return [{ root, dirs: [...dirs] }]
      })
      const next = JSON.stringify(trees)
      if (next === watching) return
      watching = next
      void window.api.files.watch(trees).catch(() => {})
    })
  }

  window.api.files.onChanged((root, dirs, git) => {
    const model = models.get(root)
    if (!model) return
    for (const dir of dirs) {
      if (model.listings.has(dir) || model.errors.has(dir)) void loadDir(model, dir)
    }
    if (dirs.length > 0) model.searchStale = true
    if (dirs.length > 0 || git) scheduleStatus(model)
  })

  // Back in the window: git may have run elsewhere, a folder outside the watched ones changed.
  watch(
    () => app.windowState.focused,
    (focused) => {
      if (!focused) return
      for (const root of holders.keys()) {
        const model = models.get(root)
        if (model) scheduleStatus(model)
      }
    },
  )

  function remember(model: TreeModel): void {
    delete remembered[model.root]
    // Folders opened only to show what Claude touches aren't the user's to remember.
    const claude = claudeFolders.get(model.root)
    const dirs = [...model.expanded].filter((dir) => !claude?.has(dir))
    if (dirs.length > 0) remembered[model.root] = dirs
    const roots = Object.keys(remembered)
    for (const root of roots.slice(0, Math.max(0, roots.length - MAX_REMEMBERED_ROOTS))) delete remembered[root]
    save()
  }

  function setExpanded(model: TreeModel, dir: string, value: boolean): void {
    // Opened or closed by hand: no longer Claude's to close.
    claudeFolders.get(model.root)?.delete(dir)
    if (value === model.expanded.has(dir)) return
    if (value) {
      model.expanded.add(dir)
      if (!model.listings.has(dir)) void loadDir(model, dir)
    } else {
      model.expanded.delete(dir)
    }
    remember(model)
    queueWatch()
  }

  /** Opens the folders a path lies in, so it shows in the tree. */
  function reveal(model: TreeModel, path: string): void {
    for (const dir of ancestors(path)) setExpanded(model, dir, true)
  }

  function collapseAll(model: TreeModel): void {
    claudeFolders.delete(model.root)
    model.expanded.clear()
    remember(model)
    queueWatch()
  }

  function refresh(model: TreeModel): void {
    reloadAll(model)
    void loadStatus(model)
    if (model.query) void loadSearch(model, true)
  }

  /** The files for the search, made again once files changed. */
  async function loadSearch(model: TreeModel, force = false): Promise<void> {
    if (model.searchLoading || (model.search && !model.searchStale && !force)) return
    model.searchLoading = true
    model.searchStale = false
    try {
      const list = await window.api.files.searchList(model.root)
      model.search = Object.freeze({ paths: Object.freeze(list.paths) as string[], truncated: list.truncated })
    } catch {
      model.search = { paths: [], truncated: false }
    } finally {
      model.searchLoading = false
    }
  }

  // ── What Claude touches ──

  /** Files Claude touched lately, by session (terminal id) and absolute path. */
  const touches = shallowRef(new Map<string, ReadonlyMap<string, Touch>>())
  let touchTimer: ReturnType<typeof setTimeout> | null = null
  /** Folders opened to show what Claude touched, by tree and folder, with the time of the last touch in them. */
  const claudeFolders = new Map<string, Map<string, number>>()
  let folderTimer: ReturnType<typeof setTimeout> | null = null

  window.api.files.onTouched((terminalId, list) => {
    const now = Date.now()
    const next = new Map(touches.value)
    const mine = new Map(next.get(terminalId))
    for (const touch of list) mine.set(touch.path, { kind: touch.kind, until: now + TOUCH_MS })
    next.set(terminalId, mine)
    touches.value = next
    scheduleTouchExpiry()
    // A commit opens folders too: its files were mostly written a while ago, their folders closed since.
    const revealed: Partial<Record<FileTouchKind, number>> = {}
    for (const touch of list) {
      const count = (revealed[touch.kind] ?? 0) + 1
      revealed[touch.kind] = count
      if (count <= REVEAL_LIMIT[touch.kind]) revealForClaude(touch, now)
    }
  })

  /** The touches that ran out go, all at once at the next one to run out. */
  function scheduleTouchExpiry(): void {
    if (touchTimer) clearTimeout(touchTimer)
    let next = Infinity
    for (const map of touches.value.values()) for (const touch of map.values()) next = Math.min(next, touch.until)
    if (next === Infinity) return
    touchTimer = setTimeout(
      () => {
        touchTimer = null
        const now = Date.now()
        const kept = new Map<string, ReadonlyMap<string, Touch>>()
        for (const [id, map] of touches.value) {
          const live = new Map([...map].filter(([, touch]) => touch.until > now))
          if (live.size > 0) kept.set(id, live)
        }
        touches.value = kept
        scheduleTouchExpiry()
      },
      Math.max(0, next - Date.now()) + 20,
    )
  }

  const touchesOf = (id: string | null | undefined): ReadonlyMap<string, Touch> | null => (id ? (touches.value.get(id) ?? null) : null)

  /** The trees on screen open the folders a file Claude touches lies in, as the plugin does. */
  function revealForClaude(touch: FileTouch, now: number): void {
    for (const root of holders.keys()) {
      const model = models.get(root)
      const path = model ? treePathOf(root, touch.path, window.api.platform === 'win32') : null
      if (!model || !path) continue
      const marks = claudeFolders.get(root) ?? new Map<string, number>()
      for (const dir of ancestors(path)) {
        if (!model.expanded.has(dir)) {
          model.expanded.add(dir)
          if (!model.listings.has(dir)) void loadDir(model, dir)
          marks.set(dir, now)
        } else if (marks.has(dir)) {
          marks.set(dir, now)
        }
      }
      if (marks.size > 0) claudeFolders.set(root, marks)
      queueWatch()
    }
    scheduleFolderClose()
  }

  /** Folders opened for Claude close once it left them alone for a while; one with the selection stays. */
  function scheduleFolderClose(): void {
    if (folderTimer) return
    folderTimer = setTimeout(() => {
      folderTimer = null
      const now = Date.now()
      let more = false
      for (const [root, marks] of claudeFolders) {
        const model = models.get(root)
        for (const [dir, at] of marks) {
          if (now - at < CLAUDE_FOLDER_MS) {
            more = true
            continue
          }
          marks.delete(dir)
          if (model && !model.selected?.startsWith(`${dir}/`)) model.expanded.delete(dir)
        }
        if (marks.size === 0) claudeFolders.delete(root)
        if (model) queueWatch()
      }
      if (more) scheduleFolderClose()
    }, 1000)
  }

  return {
    width,
    showIgnored,
    diffShare,
    targetOf,
    targetOfGroup,
    isOpen,
    setOpen,
    toggle,
    setWidth,
    setDiffShare,
    showDiff,
    splitDiffOf,
    closeSplitDiff,
    touchesOf,
    hold,
    pinDir,
    release,
    setExpanded,
    reveal,
    collapseAll,
    refresh,
    loadSearch,
  }
})
