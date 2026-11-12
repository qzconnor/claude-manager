<script setup lang="ts">
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  AtSignIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  FilePlusIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderXIcon,
  GitCompareIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  ListFilterIcon,
  ListTreeIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareTerminalIcon,
  TextCursorInputIcon,
  TextSearchIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from '@lucide/vue'
import { useElementSize } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FileTouchKind, FileTreeSide, GitFileState, GitFileStatus } from '@shared/types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MIN_CONTENT_QUERY, useContentSearch } from '@/composables/useContentSearch'
import { useFileTreeModel } from '@/composables/useFileTreeModel'
import { useGitActions } from '@/composables/useGitActions'
import { useLauncher } from '@/composables/useLauncher'
import { useOpenFile } from '@/composables/useOpenFile'
import { attempt } from '@/lib/errors'
import { fileIcon, type FileIconInfo } from '@/lib/file-icons'
import {
  absolutePath,
  ancestors,
  changedFiles,
  FILE_TREE_DRAG_TYPE,
  filesTree,
  flattenTree,
  folderName,
  foldersOf,
  GIT_STATUSES,
  gitDecorations,
  parentPath,
  recordKind,
  searchTree,
  STATUS_CLASS,
  STATUS_LABEL,
  STATUS_LETTER,
  TOUCH_KINDS,
  TOUCH_RANK,
  treePathOf,
  untrackedFolders,
  type TouchRecord,
  type TreeRow,
} from '@/lib/file-tree'
import { TOUCH_ICON } from '@/lib/file-touch'
import { shellKind } from '@/lib/platform'
import { pastedPaths } from '@/lib/shell-quote'
import { terminalBus } from '@/lib/terminal-bus'
import { childPath, type NameKind, type NameRequest } from '@/lib/tree-names'
import { separatorValue } from '@/lib/separator-keys'
import { isMenuKey, openMenuBelow } from '@/lib/tab-keys'
import { cn } from '@/lib/utils'
import { DEFAULT_TREE_WIDTH, MAX_TREE_WIDTH, MIN_TREE_WIDTH, SEPARATOR, useFileTreeStore, type TreeTarget } from '@/stores/file-tree'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import FileContentResults from './FileContentResults.vue'
import FileNameDialog from './FileNameDialog.vue'
import FileTreeFilters from './FileTreeFilters.vue'

/**
 * The file tree of a tab, beside its terminal (not over it), in the spirit of the claude-code-filetree
 * plugin: the folder with its branch and changes on top, a search across all files, then the tree
 * with git's marks and the names of the files Claude reads, writes and commits lit up. A click on a file
 * shows its changes (with the tabs in groups as a tab of `groupId`, else beside the terminal). Entries
 * go to Claude by the context menu (`@` mention) or by dragging them into the terminal.
 */
const props = defineProps<{
  target: TreeTarget
  side: FileTreeSide
  /** The widest the tree may be dragged in its area (px). */
  maxWidth: number
  /** With the tabs in groups: the group whose tab the tree is beside, where a file's changes open. */
  groupId?: string | null
  /** The file whose changes are shown beside the tree, selected in it. */
  current?: string | null
}>()

const fileTree = useFileTreeStore()
const settings = useSettingsStore()
const ui = useUiStore()
const launcher = useLauncher()
const openPath = useOpenFile()
const model = useFileTreeModel(() => props.target.root)

const windows = window.api.platform === 'win32'
const explorer = windows ? 'Explorer' : 'Dateimanager'
const rootName = computed(() => folderName(props.target.root))

/** Rows follow the size of the interface's font (`text-sm`, like the session list). */
const rowHeight = computed(() => Math.round(settings.settings.appearance.uiFontSize * 1.86))
/**
 * A row is a rounded pill set in from the edges like the tabs in the sidebar (px): `INSET` from the
 * panel, `PAD` inside it, then `INDENT` per level and the chevron's `CHEVRON` wide slot.
 */
const INSET = 6
const PAD = 6
const INDENT = 14
const CHEVRON = 16
/** Where the guide down from a folder of `level` runs: below the middle of its chevron. */
const guideLeft = (level: number) => `${INSET + PAD + (level - 1) * INDENT + CHEVRON / 2 - 1}px`
/** Rows drawn beyond the visible ones, so scrolling doesn't show gaps. */
const OVERSCAN = 10

// ── Git ──

const git = computed(() => model.value.git)
const decorations = computed(() => gitDecorations(git.value))
const summary = computed(() =>
  GIT_STATUSES.flatMap((status) => {
    const count = decorations.value.counts[status] ?? 0
    return count ? [{ status, count }] : []
  }),
)
const branchLabel = computed(() => git.value?.branch ?? git.value?.commit ?? 'Noch kein Commit')
const branchTooltip = computed(() => {
  const g = git.value
  if (!g) return ''
  const lines = [g.branch ? `Branch ${g.branch}` : g.commit ? `Kein Branch ausgecheckt (Commit ${g.commit})` : 'Noch kein Commit']
  if (g.upstream) lines.push(`folgt ${g.upstream}`)
  if (g.ahead) lines.push(`${g.ahead} ${g.ahead === 1 ? 'Commit' : 'Commits'} noch nicht gepusht`)
  if (g.behind) lines.push(`${g.behind} ${g.behind === 1 ? 'Commit' : 'Commits'} noch nicht geholt`)
  return lines.join('\n')
})

// ── Filters ──

/** Which files the trees show: the changed ones, those Claude touched in the session, or both. */
const filters = fileTree.filters
const filtered = computed(() => filters.changes || filters.activity)
/** Files git ignores, while they are hidden. */
const hidden = computed(() => (fileTree.showIgnored ? undefined : (path: string) => decorations.value.ignored(path)))
/** Folders git reports as new as a whole (`dir/`); their files come from the search's list. */
const untrackedDirs = computed(() => untrackedFolders(git.value))
/** The files git sees changed, deleted ones too, and those in new folders once the list of files is there. */
const changedPaths = computed(() => changedFiles(git.value, model.value.search?.paths))
const changesTooltip = computed(() => summary.value.map((item) => `${STATUS_LABEL[item.status]}: ${item.count}`).join(' · '))

/** What Claude did in the tab's session with the files of the tree, by their path in the tree. */
const recorded = computed(() => {
  const files = new Map<string, TouchRecord>()
  for (const [absolute, record] of fileTree.activityOf(props.target.session.id) ?? []) {
    const path = treePathOf(props.target.root, absolute, windows)
    if (path) files.set(path, record)
  }
  return files
})
/** How many files of the tree Claude touched in each way; the ignored ones while they show. */
const kindCounts = computed(() => {
  const counts: Record<FileTouchKind, number> = { read: 0, search: 0, write: 0, commit: 0 }
  for (const [path, record] of recorded.value) {
    if (hidden.value?.(path)) continue
    for (const kind of TOUCH_KINDS) if (record[kind] !== undefined) counts[kind]++
  }
  return counts
})

/** The files the filters let through: the changes in the states shown, the files Claude touched in the kinds shown. */
const filteredPaths = computed(() => {
  const paths = new Set<string>()
  if (filters.changes) {
    const marks = decorations.value
    for (const path of changedPaths.value) {
      const status = marks.file(path)?.status
      if (!status || !fileTree.hiddenStatuses.has(status)) paths.add(path)
    }
  }
  if (filters.activity) {
    for (const [path, record] of recorded.value) {
      if (!hidden.value?.(path) && recordKind(record, fileTree.hiddenKinds)) paths.add(path)
    }
  }
  return [...paths]
})

const filterLabel = computed(() =>
  filters.changes && filters.activity ? 'Änderungen und Aktivität' : filters.changes ? 'Nur Änderungen' : 'Nur Aktivität',
)
/** Why a filtered tree is empty. */
const emptyText = computed(() => {
  const changes = filters.changes && changedPaths.value.length > 0
  const touched = filters.activity && TOUCH_KINDS.some((kind) => kindCounts.value[kind] > 0)
  if (changes || touched) return 'Keine Datei passt zu den gewählten Arten.'
  if (filters.changes && filters.activity) return 'Keine Änderungen und keine Aktivität von Claude.'
  if (filters.changes) return git.value ? 'Keine Änderungen seit dem letzten Commit.' : 'Kein Git-Repository.'
  return isSession.value ? 'Claude hat in dieser Session noch keine Datei hier angefasst.' : 'Aktivität von Claude gibt es nur in Sessions.'
})

function showAll() {
  filters.changes = false
  filters.activity = false
}

// A search goes on in the other list, which starts at its top, at the selected entry if it has it.
watch(
  () => [filters.changes, filters.activity],
  () => {
    if (scroller.value) scroller.value.scrollTop = 0
    void nextTick(() => {
      if (selected.value) revealRow(selected.value, true)
    })
  },
)

// ── Search ──

const query = computed({
  get: () => model.value.query,
  set: (value: string) => (model.value.query = value),
})
/** The tree is searched by name; a search of the files' content shows its hits instead of the tree. */
const searching = computed(() => query.value.trim().length > 0 && !model.value.searchContent)

// ── Searching the files' content ──

const content = useContentSearch(() => model.value)
/** Something is typed while the search looks into the files: its hits show, not the tree. */
const contentShown = computed(() => model.value.searchContent && query.value.trim().length > 0)
const contentResults = ref<InstanceType<typeof FileContentResults> | null>(null)
const searchPlaceholder = computed(() =>
  model.value.searchContent ? 'Im Inhalt suchen' : filtered.value ? 'Gefilterte Dateien suchen' : 'Dateien suchen',
)
const contentStatus = computed(() => {
  if (content.error.value) return content.error.value
  if (query.value.trim().length < MIN_CONTENT_QUERY) return 'Mindestens zwei Zeichen'
  const result = content.result.value
  if (!result) return null
  if (result.matches === 0) return 'Keine Treffer.'
  const files = result.files.length
  return `${result.matches} Treffer in ${files} ${files === 1 ? 'Datei' : 'Dateien'}${result.truncated ? ', nur die ersten' : ''}`
})

function toggleContent() {
  model.value.searchContent = !model.value.searchContent
  searchInput.value?.focus()
}

function openHit(path: string, line: number, keep: boolean) {
  fileTree.showDiff(props.target, path, { groupId: props.groupId, keep, line })
}

/** A letter typed in the hits goes on in the search. */
function typeInSearch(key: string) {
  query.value += key
  searchInput.value?.focus()
}

function refresh() {
  fileTree.refresh(model.value)
  content.refresh()
}
const searchInput = ref<HTMLInputElement | null>(null)

/** The list of all files is needed to search them, and for the files in new folders when the changes show. */
const listNeeded = computed(() => (filtered.value ? filters.changes && untrackedDirs.value.length > 0 : searching.value))
watch(
  () => listNeeded.value && !model.value.searchLoading && (!model.value.search || model.value.searchStale),
  (load) => {
    if (load) void fileTree.loadSearch(model.value)
  },
  { immediate: true },
)

/** Files git deleted are still known to it, but gone from the disk; a filtered tree searches the files it shows. */
const searchPaths = computed(() => {
  if (filtered.value) return filteredPaths.value
  const paths = model.value.search?.paths ?? []
  const deleted = Object.entries(git.value?.files ?? {}).filter(([, s]) => s.status === 'deleted')
  if (deleted.length === 0) return paths
  const gone = new Set(deleted.map(([path]) => path))
  return paths.filter((path) => !gone.has(path))
})
const searchResult = computed(() =>
  searching.value && (filtered.value || model.value.search) ? searchTree(searchPaths.value, query.value) : null,
)

// ── Rows ──

const rows = computed<TreeRow[]>(() => {
  if (searching.value) return searchResult.value?.rows ?? []
  const m = model.value
  if (filtered.value) return filesTree(filteredPaths.value, m.collapsedFiltered)
  return flattenTree({ listings: m.listings, errors: m.errors, expanded: m.expanded, hidden: hidden.value })
})
const entries = computed(() => rows.value.filter((row): row is Extract<TreeRow, { kind: 'entry' }> => row.kind === 'entry'))

const rootError = computed(() => model.value.errors.get('') ?? null)
const rootLoading = computed(() => !model.value.listings.has('') && !rootError.value)

// ── What Claude does ──

const TOUCH_INSIDE: Record<FileTouchKind, string> = {
  read: 'Claude liest eine Datei in diesem Ordner',
  search: 'Claude durchsucht Dateien in diesem Ordner',
  write: 'Claude schreibt eine Datei in diesem Ordner',
  commit: 'Claude hat Dateien in diesem Ordner committet',
}
const TOUCH_LABEL: Record<FileTouchKind, string> = {
  read: 'Claude liest die Datei',
  search: 'Claude durchsucht die Datei',
  write: 'Claude schreibt die Datei',
  commit: 'Claude hat die Datei committet',
}
/**
 * The files of the tree the tab's session touched lately (by their path in the tree), and the
 * folders they lie in with the strongest touch inside.
 */
const touched = computed(() => {
  const list = fileTree.touchesOf(props.target.session.id)
  if (!list) return null
  const files = new Map<string, FileTouchKind>()
  const folders = new Map<string, FileTouchKind>()
  for (const [absolute, touch] of list) {
    const path = treePathOf(props.target.root, absolute, windows)
    if (!path) continue
    files.set(path, touch.kind)
    for (const dir of ancestors(path)) {
      const before = folders.get(dir)
      if (!before || TOUCH_RANK[touch.kind] > TOUCH_RANK[before]) folders.set(dir, touch.kind)
    }
  }
  return files.size > 0 ? { files, folders } : null
})

// ── Drawing only the visible rows ──

const scroller = ref<HTMLElement | null>(null)
const { height: viewHeight } = useElementSize(scroller)
const scrollTop = ref(0)

onMounted(() => {
  if (scroller.value) scroller.value.scrollTop = model.value.scrollTop
  scrollTop.value = scroller.value?.scrollTop ?? 0
})

function onScroll() {
  scrollTop.value = scroller.value?.scrollTop ?? 0
  model.value.scrollTop = scrollTop.value
}

interface RowView {
  row: TreeRow
  index: number
  icon: FileIconInfo | null
  /** A file's own state in git. */
  state: GitFileState | null
  /** The strongest state of the files in a folder. */
  folderState: GitFileStatus | null
  ignored: boolean
  /** Claude read, wrote or committed this file a moment ago. */
  touch: FileTouchKind | null
  /** Claude touched a file inside this closed folder. */
  touchInside: FileTouchKind | null
}

const visibleRows = computed<RowView[]>(() => {
  const height = rowHeight.value
  const first = Math.max(0, Math.floor(scrollTop.value / height) - OVERSCAN)
  const last = Math.min(rows.value.length, Math.ceil((scrollTop.value + viewHeight.value) / height) + OVERSCAN)
  const marks = decorations.value
  const now = touched.value
  return rows.value.slice(first, last).map((row, i) => {
    if (row.kind !== 'entry') {
      return {
        row,
        index: first + i,
        icon: null,
        state: null,
        folderState: null,
        ignored: false,
        touch: null,
        touchInside: null,
      }
    }
    const dir = row.entry.dir
    return {
      row,
      index: first + i,
      icon: fileIcon(row.path, row.entry, row.expanded),
      state: dir ? null : marks.file(row.path),
      folderState: dir ? marks.folder(row.path) : null,
      ignored: marks.ignored(row.path),
      touch: (!dir && now?.files.get(row.path)) || null,
      touchInside: (dir && !row.expanded && now?.folders.get(row.path)) || null,
    }
  })
})

/** Scrolls the row of `path` into view; `ahead`: out of view it comes to the upper third, not the edge. */
function revealRow(path: string, ahead = false) {
  const el = scroller.value
  const index = rows.value.findIndex((row) => row.path === path)
  if (!el || index === -1) return
  const top = index * rowHeight.value
  const outside = top < el.scrollTop || top + rowHeight.value > el.scrollTop + el.clientHeight
  if (ahead && outside) el.scrollTop = top - Math.round(el.clientHeight / 3)
  else if (top < el.scrollTop) el.scrollTop = top
  else if (top + rowHeight.value > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight.value - el.clientHeight
}

// ── Selecting and opening ──

const listFocused = ref(false)
const selected = computed(() => model.value.selected)

function select(path: string | null, scroll = true) {
  model.value.selected = path
  if (path && scroll) void nextTick(() => revealRow(path))
}

const abs = (path: string) => absolutePath(props.target.root, path, SEPARATOR)

function toggleDir(path: string, open?: boolean) {
  const m = model.value
  if (filtered.value) {
    // Its folders are open unless closed here; the tree's own stay as they are.
    if ((open ?? m.collapsedFiltered.has(path)) === true) m.collapsedFiltered.delete(path)
    else m.collapsedFiltered.add(path)
  } else {
    fileTree.setExpanded(m, path, open ?? !m.expanded.has(path))
  }
}

const canCollapse = computed(() => {
  if (searching.value) return false
  if (filtered.value) return rows.value.some((row) => row.kind === 'entry' && row.expanded)
  return model.value.expanded.size > 0
})

function collapseAll() {
  const m = model.value
  if (filtered.value) for (const dir of foldersOf(filteredPaths.value)) m.collapsedFiltered.add(dir)
  else fileTree.collapseAll(m)
}

function openFile(path: string) {
  void openPath(abs(path))
}

/** Shows the file's changes; `keep`: with the tabs in groups as a tab that stays, not one that previews. */
function showDiff(path: string, keep = false) {
  fileTree.showDiff(props.target, path, { groupId: props.groupId, keep })
}

// The file whose changes are shown is the selected one.
watch(
  () => props.current,
  (path) => {
    if (path && path !== selected.value) select(path)
  },
  { immediate: true },
)

// A file Claude turns to scrolls into view, unless the tree is in use (focused or searched). Its folder
// may still be loading, so it waits for its row a moment.
let pendingReveal: string | null = null
let pendingTimer: ReturnType<typeof setTimeout> | undefined
function revealPending() {
  if (!pendingReveal || !rows.value.some((row) => row.path === pendingReveal)) return
  revealRow(pendingReveal, true)
  pendingReveal = null
}
watch(
  () => touched.value?.files,
  (files, before) => {
    if (!files || searching.value || listFocused.value) return
    const fresh = [...files].filter(([path, kind]) => before?.get(path) !== kind).map(([path]) => path)
    if (fresh.length === 0) return
    pendingReveal = fresh.at(-1)!
    clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => (pendingReveal = null), 3000)
    void nextTick(revealPending)
  },
)
watch(rows, () => {
  if (pendingReveal) void nextTick(revealPending)
})
onBeforeUnmount(() => clearTimeout(pendingTimer))

/** Leaves the search and shows the entry in the tree, its folders opened. */
function showInTree(path: string, dir: boolean) {
  query.value = ''
  const m = model.value
  if (filtered.value) for (const folder of ancestors(path)) m.collapsedFiltered.delete(folder)
  else fileTree.reveal(m, path)
  if (dir) toggleDir(path, true)
  select(path)
  scroller.value?.focus()
}

function onRowClick(row: TreeRow) {
  if (row.kind !== 'entry') return
  if (searching.value && row.entry.dir && !row.expanded) return showInTree(row.path, true)
  select(row.path, false)
  if (row.entry.dir && !searching.value) toggleDir(row.path)
  else if (!row.entry.dir) showDiff(row.path)
}

function onRowDoubleClick(row: TreeRow) {
  if (row.kind === 'entry' && !row.entry.dir) showDiff(row.path, true)
}

function onDragStart(event: DragEvent, row: TreeRow) {
  if (row.kind !== 'entry' || !event.dataTransfer) return
  const path = abs(row.path)
  event.dataTransfer.setData(FILE_TREE_DRAG_TYPE, path)
  event.dataTransfer.setData('text/plain', path)
  event.dataTransfer.effectAllowed = 'copy'
}

function onListKeydown(event: KeyboardEvent) {
  // The menu key and Shift+F10: the menu of the selected entry, below it. The key's own event goes to the
  // tree, and its menu would be the one of the folder.
  if (isMenuKey(event) && scroller.value) {
    event.preventDefault()
    const row = selected.value ? scroller.value.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected.value)}"]`) : null
    openMenuBelow(row ?? scroller.value)
    return
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const list = entries.value
  const index = list.findIndex((row) => row.path === selected.value)
  const current = index === -1 ? null : list[index]!
  const page = Math.max(1, Math.floor((scroller.value?.clientHeight ?? 0) / rowHeight.value) - 1)
  const moveTo = (i: number) => {
    const row = list[Math.max(0, Math.min(list.length - 1, i))]
    if (row) select(row.path)
  }
  switch (event.key) {
    case 'ArrowDown':
      moveTo(index + 1)
      break
    case 'ArrowUp':
      moveTo(index === -1 ? list.length - 1 : index - 1)
      break
    case 'PageDown':
      moveTo(index + page)
      break
    case 'PageUp':
      moveTo(index - page)
      break
    case 'Home':
      moveTo(0)
      break
    case 'End':
      moveTo(list.length - 1)
      break
    case 'ArrowRight':
      if (current?.entry.dir) {
        if (!current.expanded) {
          if (searching.value) showInTree(current.path, true)
          else toggleDir(current.path, true)
        } else moveTo(index + 1)
      }
      break
    case 'ArrowLeft':
      if (current?.entry.dir && current.expanded && !searching.value) toggleDir(current.path, false)
      else if (current && parentPath(current.path)) select(parentPath(current.path))
      break
    case 'Enter':
      if (!current) return
      if (current.entry.dir) {
        if (searching.value) showInTree(current.path, true)
        else toggleDir(current.path)
      } else showDiff(current.path, true)
      break
    case 'F2':
      if (!current || isGone(current.path)) return
      rename(current.path, current.entry.dir)
      break
    case 'Delete':
      if (!current || isGone(current.path)) return
      void trash(current.path, current.entry.dir)
      break
    case 'Escape':
      if (!searching.value) return
      query.value = ''
      break
    default:
      // Typing in the tree searches.
      if (event.key.length === 1 && event.key !== ' ') {
        query.value += event.key
        searchInput.value?.focus()
        break
      }
      return
  }
  event.preventDefault()
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && query.value) {
    query.value = ''
    event.preventDefault()
  } else if ((event.key === 'ArrowDown' || event.key === 'Enter') && contentShown.value) {
    event.preventDefault()
    contentResults.value?.focusFirst()
  } else if ((event.key === 'ArrowDown' || event.key === 'Enter') && entries.value.length) {
    event.preventDefault()
    // The first file that matched, else the first row.
    const first = entries.value.find((row) => row.match && !row.entry.dir) ?? entries.value[0]!
    select(first.path)
    scroller.value?.focus()
  }
}

// ── The context menu ──

/** The entry the context menu is for; the tree's folder itself on an empty spot. */
const menuTarget = ref<{ path: string; dir: boolean }>({ path: '', dir: true })
/** How git sees the file the context menu is for; null for a folder and an unchanged file. */
const menuState = computed(() => (menuTarget.value.dir ? null : decorations.value.file(menuTarget.value.path)))
const gitActions = useGitActions()

async function onGit(action: 'stage' | 'unstage' | 'discard', path: string) {
  const state = decorations.value.file(path)
  if (!state) return
  const root = props.target.root
  const done =
    action === 'stage'
      ? await gitActions.stage(root, path)
      : action === 'unstage'
        ? await gitActions.unstage(root, path)
        : await gitActions.discard(root, path, state.status)
  if (done) fileTree.refresh(model.value)
}

/** The folder new entries of the context menu go in: the entry's own, or the one a file lies in. */
const menuFolder = computed(() => (menuTarget.value.dir ? menuTarget.value.path : parentPath(menuTarget.value.path)))
const isSession = computed(() => props.target.session.mode === 'session')
const sessionRunning = computed(() => props.target.session.status === 'running')

function onContextMenu(event: MouseEvent) {
  const path = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-path]')?.dataset.path
  const row = path === undefined ? undefined : entries.value.find((r) => r.path === path)
  menuTarget.value = row ? { path: row.path, dir: row.entry.dir } : { path: '', dir: true }
  if (row) select(row.path, false)
}

/**
 * Hands the entry to the session: Claude gets an `@` mention (relative to the folder it works in), a
 * shell the path quoted so that it runs nothing in it.
 */
function mention(path: string, dir: boolean) {
  let text: string
  if (isSession.value) {
    const target = dir ? `${path}/` : path
    text = /\s/.test(target) ? `@"${target}" ` : `@${target} `
  } else {
    text = `${pastedPaths([abs(path)], props.target.session.mode, shellKind)} `
  }
  if (!terminalBus.paste(props.target.session.id, text)) void navigator.clipboard.writeText(text.trim())
}

function copy(text: string) {
  void attempt(() => navigator.clipboard.writeText(text), 'Konnte nicht kopiert werden')
}

function showItem(path: string) {
  void attempt(() => window.api.app.showItem(abs(path)), `Konnte nicht im ${explorer} gezeigt werden`)
}

function openFolder(path: string) {
  void attempt(() => window.api.app.openPath(abs(path)), 'Ordner konnte nicht geöffnet werden')
}

// ── Making, renaming and deleting entries ──

/** What the name dialog is open for. */
const nameRequest = ref<NameRequest | null>(null)

/** A file git deleted: it shows, but isn't on the disk any more. */
function isGone(path: string): boolean {
  return decorations.value.file(path)?.status === 'deleted'
}

function create(kind: NameKind, parent: string) {
  nameRequest.value = { kind, parent, name: '', dir: kind === 'folder' }
}

function rename(path: string, dir: boolean) {
  nameRequest.value = { kind: 'rename', parent: parentPath(path), name: path.slice(path.lastIndexOf('/') + 1), dir }
}

/**
 * Made or renamed: the tree shows the entry at once and selects it. A renamed folder stays open, and the
 * changes shown of a renamed file follow it.
 */
function onNamed(path: string, request: NameRequest) {
  nameRequest.value = null
  const m = model.value
  if (request.kind === 'rename') {
    const from = childPath(request.parent, request.name)
    if (request.dir && m.expanded.has(from)) fileTree.setExpanded(m, path, true)
    const current = props.current
    if (current && (current === from || current.startsWith(`${from}/`))) showDiff(path + current.slice(from.length))
  }
  query.value = ''
  if (filtered.value) for (const folder of ancestors(path)) m.collapsedFiltered.delete(folder)
  else fileTree.reveal(m, path)
  fileTree.refresh(m)
  selectWhenShown(path)
  scroller.value?.focus()
}

/** Selects the entry once its row is there: its folder is read again first. */
function selectWhenShown(path: string) {
  if (rows.value.some((row) => row.path === path)) return select(path)
  const stop = watch(rows, (list) => {
    if (!list.some((row) => row.path === path)) return
    stop()
    clearTimeout(timer)
    select(path)
  })
  const timer = setTimeout(stop, 3000)
}

/** Moves the entry to the recycle bin, once asked; the selection goes on to the next entry, like in Explorer. */
async function trash(path: string, dir: boolean) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const confirmed = await ui.confirm({
    title: `„${name}“ in den Papierkorb verschieben?`,
    description: dir
      ? 'Der Ordner kommt mit allem darin in den Papierkorb. Dort lässt er sich wiederherstellen.'
      : 'Aus dem Papierkorb lässt sich die Datei wiederherstellen.',
    confirmText: 'In den Papierkorb',
    destructive: true,
  })
  if (!confirmed) return
  const list = entries.value
  const index = list.findIndex((row) => row.path === path)
  const inside = (other: string) => other === path || other.startsWith(`${path}/`)
  const next = list.slice(index + 1).find((row) => !inside(row.path)) ?? list[index - 1]
  const done = await attempt(async () => {
    await window.api.files.trash(props.target.root, path)
    return true
  }, 'Nicht in den Papierkorb verschoben')
  if (!done) return
  fileTree.refresh(model.value)
  if (selected.value && inside(selected.value)) select(next?.path ?? null)
  scroller.value?.focus()
}

// ── Width ──

const panel = ref<HTMLElement | null>(null)
const resizing = ref(false)
let endResize: (() => void) | null = null

/** The tree's edge moved with the keyboard, 16 px a step; on the right its width grows to the left. */
function onResizeKey(event: KeyboardEvent) {
  const width = separatorValue(event, true, {
    value: fileTree.width,
    min: MIN_TREE_WIDTH,
    max: MAX_TREE_WIDTH,
    step: 16,
    initial: DEFAULT_TREE_WIDTH,
    reversed: props.side === 'right',
  })
  if (width === null) return
  event.preventDefault()
  fileTree.setWidth(width)
}

function onResizeStart(event: PointerEvent) {
  if (event.button !== 0 || !panel.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const bounds = panel.value.getBoundingClientRect()
  resizing.value = true
  // The pages of browsers would take the pointer as it passes over them.
  document.documentElement.dataset.resizing = 'col'
  const move = (e: PointerEvent) => {
    const width = props.side === 'left' ? e.clientX - bounds.left : bounds.right - e.clientX
    fileTree.setWidth(Math.min(width, props.maxWidth))
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    resizing.value = false
    delete document.documentElement.dataset.resizing
    endResize = null
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
  endResize = end
}
onBeforeUnmount(() => endResize?.())

const iconButton =
  'flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 aria-expanded:bg-accent aria-expanded:text-foreground'
</script>

<template>
  <aside
    ref="panel"
    data-slot="file-tree"
    aria-label="Dateibaum"
    class="flex min-w-0 flex-col overflow-visible text-foreground select-none"
  >
    <!-- The folder, like a section of VS Code's Explorer, with the tree's actions. -->
    <div class="flex h-[38px] shrink-0 items-center gap-0.5 pr-2 pl-3">
      <span class="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-muted-foreground uppercase" v-tooltip="target.root">
        {{ rootName }}
      </span>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" aria-label="Aktualisieren" :class="iconButton" @click="refresh">
            <RefreshCwIcon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Aktualisieren</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            aria-label="Alle Ordner zuklappen"
            :class="iconButton"
            :disabled="!canCollapse"
            @click="collapseAll"
          >
            <ChevronsDownUpIcon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Alle Ordner zuklappen</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" aria-label="Weitere Aktionen" :class="iconButton">
            <EllipsisIcon class="size-[16px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-60">
          <DropdownMenuItem @select="create('file', '')">
            <FilePlusIcon />
            Neue Datei…
          </DropdownMenuItem>
          <DropdownMenuItem @select="create('folder', '')">
            <FolderPlusIcon />
            Neuer Ordner…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="openFolder('')">
            <FolderOpenIcon />
            Im {{ explorer }} öffnen
          </DropdownMenuItem>
          <DropdownMenuItem @select="copy(target.root)">
            <CopyIcon />
            Pfad kopieren
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="fileTree.close(target, groupId)">
            <XIcon />
            Dateibaum schließen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- Branch with how far it is from its upstream, and the changes by kind, like the plugin's branch row;
         at its end the button for all changes one below the other, and the filters' one. Also without git,
         so the filters' button has its place. -->
    <div class="-mt-1 flex h-[24px] shrink-0 items-center gap-1.5 pr-2 pl-3 text-xs text-muted-foreground">
      <span v-if="git" class="flex min-w-0 items-center gap-2" v-tooltip="branchTooltip">
        <GitCommitHorizontalIcon v-if="!git.branch" class="size-3.5 shrink-0" />
        <GitBranchIcon v-else class="size-3.5 shrink-0" />
        <span :class="cn('truncate', !git.branch && 'font-mono')">{{ branchLabel }}</span>
        <span v-if="git.ahead" class="flex shrink-0 items-center tabular-nums"><ArrowUpIcon class="size-[12px]" />{{ git.ahead }}</span>
        <span v-if="git.behind" class="flex shrink-0 items-center tabular-nums"><ArrowDownIcon class="size-[12px]" />{{ git.behind }}</span>
      </span>
      <span class="flex-1" />
      <!-- The changes by kind. -->
      <span v-if="summary.length" class="mr-1 flex shrink-0 items-center gap-1.5" v-tooltip="changesTooltip">
        <span
          v-for="item in summary"
          :key="item.status"
          :class="cn('font-mono text-[11px] font-medium tabular-nums', STATUS_CLASS[item.status])"
        >
          {{ STATUS_LETTER[item.status] }}{{ item.count }}
        </span>
      </span>
      <!-- All changes one below the other, to review them like a pull request. -->
      <Tooltip v-if="summary.length">
        <TooltipTrigger as-child>
          <button type="button" aria-label="Alle Änderungen ansehen" :class="iconButton" @click="showDiff('', true)">
            <FileDiffIcon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Alle Änderungen untereinander ansehen</TooltipContent>
      </Tooltip>
      <!-- Unfolds the filters; while one holds, a dot on it says so. -->
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            aria-label="Filter"
            :aria-pressed="fileTree.filtersOpen"
            :class="cn(iconButton, 'relative aria-pressed:bg-accent aria-pressed:text-foreground')"
            @click="fileTree.filtersOpen = !fileTree.filtersOpen"
          >
            <ListFilterIcon class="size-[16px]" />
            <span v-if="filtered" class="absolute top-[3px] right-[3px] size-[6px] rounded-full bg-primary" />
          </button>
        </TooltipTrigger>
        <TooltipContent class="flex-col items-start gap-0.5">
          <span>{{ fileTree.filtersOpen ? 'Filter zuklappen' : 'Filter' }}</span>
          <span v-if="filtered" class="opacity-70">{{ filterLabel }}</span>
        </TooltipContent>
      </Tooltip>
    </div>

    <FileTreeFilters
      v-if="fileTree.filtersOpen"
      :statuses="summary"
      :kinds="kindCounts"
      :git="!!git"
      :session="isSession"
      :terminal-id="target.session.id"
    />

    <!-- Search by name across every folder, the open ones or not. -->
    <!-- Like the search in the title bar. -->
    <div class="shrink-0 px-[6px] pt-2 pb-1.5">
      <label
        class="flex h-7 items-center rounded-lg bg-foreground/5 text-xs ring-1 ring-foreground/10 transition-colors focus-within:ring-2 focus-within:ring-ring/50 hover:bg-foreground/8"
      >
        <SearchIcon class="ml-2.5 size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :aria-label="searchPlaceholder"
          :placeholder="searchPlaceholder"
          class="h-full min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-muted-foreground"
          @keydown="onSearchKeydown"
        />
        <Spinner
          v-if="(searching && model.searchLoading) || (contentShown && content.loading.value)"
          class="mr-1.5 size-[14px] text-muted-foreground"
        />
        <button
          v-if="query"
          type="button"
          aria-label="Suche leeren"
          class="mr-1 flex size-[20px] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          @click="query = ''"
        >
          <XIcon class="size-[12px]" />
        </button>
        <!-- Name or content, like the switches in VS Code's search. -->
        <button
          type="button"
          aria-label="Im Inhalt der Dateien suchen"
          :aria-pressed="model.searchContent"
          class="mr-1 flex size-[20px] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-primary/20 aria-pressed:text-foreground"
          v-tooltip="model.searchContent ? 'Sucht im Inhalt der Dateien, ein Klick sucht nach Namen' : 'Im Inhalt der Dateien suchen'"
          @click="toggleContent"
        >
          <TextSearchIcon class="size-[13px]" />
        </button>
      </label>
      <p
        v-if="contentShown && contentStatus"
        :class="cn('px-2.5 pt-1.5 text-[11px]', content.error.value ? 'text-destructive' : 'text-muted-foreground')"
      >
        {{ contentStatus }}
      </p>
      <p v-else-if="searching && searchResult" class="px-2.5 pt-1.5 text-[11px] text-muted-foreground">
        {{
          searchResult.matches === 0
            ? 'Keine Datei passt.'
            : searchResult.matches > 400
              ? `${searchResult.matches} Treffer, die besten 400`
              : `${searchResult.matches} ${searchResult.matches === 1 ? 'Treffer' : 'Treffer'}`
        }}
        <template v-if="model.search?.truncated && !filtered"> · nicht alle Dateien durchsucht</template>
      </p>
      <p v-else-if="filtered && filteredPaths.length && !contentShown" class="flex items-center gap-1 px-2.5 pt-1.5 text-[11px] text-muted-foreground">
        <span class="min-w-0 truncate">
          {{ filterLabel }}: {{ filteredPaths.length }} {{ filteredPaths.length === 1 ? 'Datei' : 'Dateien' }}
          <template v-if="filters.changes && git && (git.truncated || (untrackedDirs.length && model.search?.truncated))"> · nicht alle</template>
        </span>
        <button
          type="button"
          class="ml-auto shrink-0 cursor-pointer rounded px-1 text-foreground/80 hover:bg-accent hover:text-foreground"
          @click="showAll"
        >
          Alle zeigen
        </button>
      </p>
    </div>

    <div v-if="rootError" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
      <FolderXIcon class="size-[24px]" />
      <span class="font-medium text-foreground">{{ rootError }}</span>
      <span class="break-all">{{ target.root }}</span>
    </div>
    <div v-else-if="rootLoading" class="flex flex-1 justify-center pt-6">
      <Spinner class="size-[16px] text-muted-foreground" />
    </div>
    <template v-else-if="contentShown">
      <FileContentResults
        v-if="content.result.value?.files.length"
        ref="contentResults"
        :result="content.result.value"
        @open="openHit"
        @type="typeInSearch"
        @leave="searchInput?.focus()"
      />
      <div v-else class="flex-1" />
    </template>
    <ContextMenu v-else>
      <ContextMenuTrigger as-child>
        <div
          ref="scroller"
          role="tree"
          aria-label="Dateien"
          tabindex="0"
          class="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 text-sm outline-none"
          @scroll.passive="onScroll"
          @keydown="onListKeydown"
          @focus="listFocused = true"
          @blur="listFocused = false"
          @contextmenu="onContextMenu"
        >
          <div class="relative w-full" :style="{ height: `${rows.length * rowHeight}px` }">
            <template v-for="view in visibleRows" :key="view.row.path">
              <div
                v-if="view.row.kind === 'entry'"
                role="treeitem"
                :data-path="view.row.path"
                :aria-level="view.row.depth + 1"
                :aria-expanded="view.row.entry.dir ? view.row.expanded : undefined"
                :aria-selected="selected === view.row.path"
                draggable="true"
                class="group/row absolute inset-x-0 top-0 cursor-pointer"
                :style="{ transform: `translateY(${view.index * rowHeight}px)`, height: `${rowHeight}px` }"
                @click="onRowClick(view.row)"
                @dblclick="onRowDoubleClick(view.row)"
                @dragstart="onDragStart($event, view.row)"
              >
                <!-- Guides down from each folder the entry lies in, over the pill, so they run through a selected row. -->
                <span
                  v-for="level in view.row.depth"
                  :key="level"
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-y-0 z-[1] w-px bg-border"
                  :style="{ left: guideLeft(level) }"
                />
                <!-- The row: selected it stands out like the search above it, while Claude is at the file in its colour. -->
                <div
                  :data-touch="view.touch ?? view.touchInside ?? undefined"
                  :class="
                    cn(
                      'absolute inset-x-[6px] inset-y-px flex items-center rounded-md pr-1.5 transition-[background-color,box-shadow] duration-300',
                      selected === view.row.path
                        ? cn('bg-foreground/8 shadow-sm ring-1', listFocused ? 'ring-ring/60' : 'ring-foreground/12')
                        : 'group-hover/row:bg-foreground/5',
                      view.touch && 'file-tree-touch-row',
                    )
                  "
                  :style="{ paddingLeft: `${PAD + view.row.depth * INDENT}px` }"
                >
                  <span class="flex shrink-0 justify-center" :style="{ width: `${CHEVRON}px` }">
                    <ChevronRightIcon
                      v-if="view.row.entry.dir"
                      :class="cn('size-3.5 text-muted-foreground transition-transform duration-150', view.row.expanded && 'rotate-90')"
                    />
                  </span>
                  <component :is="view.icon!.icon" :class="cn('ml-1 size-[15px] shrink-0', view.icon!.class, view.ignored && 'opacity-50')" />
                  <span
                    :class="
                      cn(
                        'ml-2 min-w-0 flex-1 truncate',
                        view.state ? STATUS_CLASS[view.state.status] : view.folderState && STATUS_CLASS[view.folderState],
                        view.state?.status === 'deleted' && 'line-through',
                        view.ignored && !view.touch && 'opacity-50',
                        view.touch && 'file-tree-touch',
                        view.touchInside && 'file-tree-touch-folder',
                      )
                    "
                  >
                    <template v-if="view.row.match">
                      {{ view.row.name.slice(0, view.row.match[0])
                      }}<mark class="rounded-[3px] bg-primary/25 text-inherit">{{ view.row.name.slice(view.row.match[0], view.row.match[1]) }}</mark
                      >{{ view.row.name.slice(view.row.match[1]) }}
                    </template>
                    <template v-else>{{ view.row.name }}</template>
                  </span>
                  <ArrowUpRightIcon v-if="view.row.entry.link && !view.row.entry.broken" class="ml-1 size-3 shrink-0 text-muted-foreground" />
                  <span
                    v-if="view.state && (view.state.added || view.state.removed)"
                    class="ml-2 shrink-0 font-mono text-[0.75rem] tabular-nums"
                  >
                    <span v-if="view.state.added" class="text-success">+{{ view.state.added }}</span>
                    <span v-if="view.state.added && view.state.removed">&nbsp;</span>
                    <span v-if="view.state.removed" class="text-destructive">−{{ view.state.removed }}</span>
                  </span>
                  <!-- What Claude does with the file, in its colour. -->
                  <component
                    :is="TOUCH_ICON[view.touch]"
                    v-if="view.touch"
                    role="status"
                    :aria-label="TOUCH_LABEL[view.touch]"
                    class="file-tree-touch-icon ml-2 size-3.5 shrink-0"
                  />
                  <span
                    v-if="view.touchInside"
                    class="relative ml-2 flex w-[12px] shrink-0 items-center justify-center"
                    role="status"
                    :aria-label="TOUCH_INSIDE[view.touchInside]"
                    v-tooltip="TOUCH_INSIDE[view.touchInside]"
                  >
                    <span class="file-tree-touch-dot absolute size-[8px] animate-ping rounded-full opacity-70 motion-reduce:hidden" />
                    <span class="file-tree-touch-dot relative size-[6px] rounded-full" />
                  </span>
                  <span
                    v-else-if="view.state"
                    :class="cn('ml-2 w-[12px] shrink-0 text-center font-mono text-[0.75rem] font-semibold', STATUS_CLASS[view.state.status])"
                    v-tooltip="STATUS_LABEL[view.state.status] + (view.state.staged ? ', vorgemerkt' : '')"
                  >
                    {{ STATUS_LETTER[view.state.status] }}
                  </span>
                  <span v-else-if="view.folderState" class="ml-2 flex w-[12px] shrink-0 justify-center">
                    <span :class="cn('size-[6px] rounded-full bg-current', STATUS_CLASS[view.folderState])" />
                  </span>
                </div>
              </div>
              <div
                v-else
                class="absolute inset-x-0 top-0 flex items-center pr-3 text-xs text-muted-foreground italic"
                :style="{
                  transform: `translateY(${view.index * rowHeight}px)`,
                  height: `${rowHeight}px`,
                  paddingLeft: `${INSET + PAD + view.row.depth * INDENT + CHEVRON + 4}px`,
                }"
              >
                <span :class="cn('truncate', view.row.kind === 'message' && view.row.error && 'text-destructive not-italic')">
                  {{ view.row.kind === 'more' ? `… ${view.row.count} weitere Einträge` : view.row.text }}
                </span>
              </div>
            </template>
          </div>
          <template v-if="rows.length === 0 && !searching">
            <div v-if="!filtered" class="px-4 pt-3 text-center text-xs text-muted-foreground">Der Ordner ist leer.</div>
            <div v-else-if="model.searchLoading" class="flex justify-center pt-6">
              <Spinner class="size-[16px] text-muted-foreground" />
            </div>
            <div v-else class="flex flex-col items-center gap-2 px-4 pt-3 text-center text-xs text-muted-foreground">
              {{ emptyText }}
              <button type="button" class="cursor-pointer rounded px-1.5 py-0.5 text-foreground/80 hover:bg-accent hover:text-foreground" @click="showAll">
                Alle Dateien zeigen
              </button>
            </div>
          </template>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-64">
        <ContextMenuItem
          v-if="menuTarget.path"
          :disabled="!sessionRunning"
          @select="mention(menuTarget.path, menuTarget.dir)"
        >
          <AtSignIcon v-if="isSession" />
          <TextCursorInputIcon v-else />
          {{ isSession ? 'In Claude erwähnen' : 'Pfad ins Terminal einfügen' }}
        </ContextMenuItem>
        <ContextMenuItem v-if="!menuTarget.dir" @select="showDiff(menuTarget.path, true)">
          <GitCompareIcon />
          Änderungen zeigen
        </ContextMenuItem>
        <ContextMenuItem v-if="!menuTarget.dir" @select="openFile(menuTarget.path)">
          <ExternalLinkIcon />
          Mit Standardprogramm öffnen
        </ContextMenuItem>
        <ContextMenuItem v-else @select="openFolder(menuTarget.path)">
          <FolderOpenIcon />
          Im {{ explorer }} öffnen
        </ContextMenuItem>
        <ContextMenuItem v-if="menuTarget.path" @select="showItem(menuTarget.path)">
          <SearchIcon />
          Im {{ explorer }} zeigen
        </ContextMenuItem>
        <ContextMenuItem v-if="searching && menuTarget.path" @select="showInTree(menuTarget.path, false)">
          <ListTreeIcon />
          Im Baum zeigen
        </ContextMenuItem>
        <template v-if="menuState">
          <ContextMenuSeparator />
          <ContextMenuItem @select="onGit('stage', menuTarget.path)">
            <PlusIcon />
            Vormerken
          </ContextMenuItem>
          <ContextMenuItem v-if="menuState.staged" @select="onGit('unstage', menuTarget.path)">
            <MinusIcon />
            Nicht mehr vormerken
          </ContextMenuItem>
          <ContextMenuItem :variant="menuState.status === 'deleted' ? 'default' : 'destructive'" @select="onGit('discard', menuTarget.path)">
            <Undo2Icon />
            {{ menuState.status === 'deleted' ? 'Wiederherstellen…' : 'Änderungen verwerfen…' }}
          </ContextMenuItem>
        </template>
        <ContextMenuSeparator />
        <ContextMenuItem @select="create('file', menuFolder)">
          <FilePlusIcon />
          Neue Datei…
        </ContextMenuItem>
        <ContextMenuItem @select="create('folder', menuFolder)">
          <FolderPlusIcon />
          Neuer Ordner…
        </ContextMenuItem>
        <template v-if="menuTarget.path && !isGone(menuTarget.path)">
          <ContextMenuItem @select="rename(menuTarget.path, menuTarget.dir)">
            <PencilIcon />
            Umbenennen…
            <ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @select="trash(menuTarget.path, menuTarget.dir)">
            <Trash2Icon />
            In den Papierkorb
            <ContextMenuShortcut>Entf</ContextMenuShortcut>
          </ContextMenuItem>
        </template>
        <ContextMenuSeparator />
        <ContextMenuItem @select="copy(abs(menuTarget.path))">
          <CopyIcon />
          Pfad kopieren
        </ContextMenuItem>
        <ContextMenuItem v-if="menuTarget.path" @select="copy(menuTarget.path)">
          <CopyIcon />
          Relativen Pfad kopieren
        </ContextMenuItem>
        <template v-if="menuTarget.dir && target.session.mode !== 'login'">
          <ContextMenuSeparator />
          <ContextMenuItem @select="launcher.newSession(target.session.accountId, abs(menuTarget.path))">
            <PlusIcon />
            Neue Session in diesem Ordner
          </ContextMenuItem>
          <ContextMenuItem @select="launcher.shell(target.session.accountId, abs(menuTarget.path))">
            <SquareTerminalIcon />
            Shell in diesem Ordner
          </ContextMenuItem>
        </template>
        <template v-if="menuTarget.path && ancestors(menuTarget.path).length && !searching">
          <ContextMenuSeparator />
          <ContextMenuItem @select="toggleDir(parentPath(menuTarget.path), false)">
            <ChevronsDownUpIcon />
            Übergeordneten Ordner zuklappen
          </ContextMenuItem>
        </template>
      </ContextMenuContent>
    </ContextMenu>

    <FileNameDialog :root="target.root" :root-name="rootName" :request="nameRequest" @close="nameRequest = null" @done="onNamed" />

    <!-- The tree's inner edge: a line to drag its width by, like the dividers between groups. -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Breite des Dateibaums ändern"
      tabindex="0"
      :aria-valuenow="Math.round(fileTree.width)"
      :aria-valuemin="MIN_TREE_WIDTH"
      :aria-valuemax="MAX_TREE_WIDTH"
      :class="cn('group/handle absolute inset-y-0 z-20 w-[9px] cursor-col-resize outline-none', side === 'left' ? '-right-[4px]' : '-left-[4px]')"
      @pointerdown="onResizeStart"
      @dblclick="fileTree.setWidth(DEFAULT_TREE_WIDTH)"
      @keydown="onResizeKey"
    >
      <div
        :class="
          cn(
            'absolute inset-y-0 left-[4px] w-px bg-border transition-colors group-hover/handle:bg-primary/60 group-focus-visible/handle:bg-primary',
            resizing && 'bg-primary/60',
          )
        "
      />
    </div>
  </aside>
</template>
