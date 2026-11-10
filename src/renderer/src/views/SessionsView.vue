<script setup lang="ts">
import {
  ArrowDownWideNarrowIcon,
  CheckIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  FolderPlusIcon,
  HardDriveIcon,
  HistoryIcon,
  ListChecksIcon,
  MinusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from '@lucide/vue'
import { refDebounced, useEventListener } from '@vueuse/core'
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { SessionSummary } from '@shared/types'
import { searchTerms } from '@shared/utils'
import AccountDot from '@/components/common/AccountDot.vue'
import SessionDetailPanel from '@/components/sessions/SessionDetailPanel.vue'
import SessionFilterChip, { type FilterOption } from '@/components/sessions/SessionFilterChip.vue'
import SessionRootSection from '@/components/sessions/SessionRootSection.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClock } from '@/composables/useClock'
import { useSectionDrag } from '@/composables/useSectionDrag'
import { useSessionDetail, type SessionRef } from '@/composables/useSessionDetail'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { sessionKey, useSessionSearch } from '@/composables/useSessionSearch'
import { attempt } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { containsTerms, searchText } from '@/lib/search'
import {
  buildSessionTree,
  FOLDERS_SECTION_ID,
  opensByDefault,
  placeFolder,
  placeSession,
  type Placement,
  type SessionProject,
  type SessionRoot,
  type SessionSort,
  type TreeRoots,
} from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { useWorkspacesStore } from '@/stores/workspaces'

/**
 * The buttons beside the search: as high as the field and in whole pixels (32px around a 16px icon,
 * the edge a ring), so the icon sits on whole device pixels at every UI size and scaling.
 */
const TOOL_BUTTON = 'size-[32px] rounded-lg border-0 bg-transparent p-0 ring-1 ring-input ring-inset'
const TOOL_BUTTON_PRESSED =
  'bg-primary/10 ring-primary/40 hover:bg-primary/15 dark:bg-primary/10 dark:ring-primary/30 dark:hover:bg-primary/15'

const sessions = useSessionsStore()
const workspaces = useWorkspacesStore()
const accounts = useAccountsStore()
const settings = useSettingsStore()
const app = useAppStore()
const ui = useUiStore()
const removal = useSessionRemoval()
const now = useClock(60_000)

const DAY_MS = 86_400_000
/** By the last activity. `older`: not touched for that long, e.g. to clean up. */
const AGE_FILTERS = [
  [
    { value: 'within-1', label: 'Letzte 24 Stunden', days: 1, older: false },
    { value: 'within-7', label: 'Letzte 7 Tage', days: 7, older: false },
    { value: 'within-30', label: 'Letzte 30 Tage', days: 30, older: false },
  ],
  [
    { value: 'older-7', label: 'Älter als 1 Woche', days: 7, older: true },
    { value: 'older-30', label: 'Älter als 1 Monat', days: 30, older: true },
    { value: 'older-90', label: 'Älter als 3 Monate', days: 90, older: true },
    { value: 'older-180', label: 'Älter als 6 Monate', days: 180, older: true },
    { value: 'older-365', label: 'Älter als 1 Jahr', days: 365, older: true },
  ],
]
const ageFilter = ref('all')
const age = computed(() => AGE_FILTERS.flat().find((f) => f.value === ageFilter.value) ?? null)

const KB = 1024
const MB = 1024 * KB
/** By the size of the transcript, e.g. to find the big ones or the ones that hardly started. */
const SIZE_FILTERS = [
  [
    { value: 'over-1m', label: 'Größer als 1 MB', short: 'Über 1 MB', bytes: MB, larger: true },
    { value: 'over-10m', label: 'Größer als 10 MB', short: 'Über 10 MB', bytes: 10 * MB, larger: true },
    { value: 'over-50m', label: 'Größer als 50 MB', short: 'Über 50 MB', bytes: 50 * MB, larger: true },
  ],
  [
    { value: 'under-1m', label: 'Kleiner als 1 MB', short: 'Unter 1 MB', bytes: MB, larger: false },
    { value: 'under-100k', label: 'Kleiner als 100 KB', short: 'Unter 100 KB', bytes: 100 * KB, larger: false },
    { value: 'under-10k', label: 'Kleiner als 10 KB', short: 'Unter 10 KB', bytes: 10 * KB, larger: false },
  ],
]
const sizeFilter = ref('all')
const size = computed(() => SIZE_FILTERS.flat().find((f) => f.value === sizeFilter.value) ?? null)

const accountFilter = ref('all')

/**
 * With several accounts the own ones come first and the standard account (`~/.claude`) is hidden
 * until asked for; chosen in the account filter, it shows anyway.
 */
const severalAccounts = computed(() => accounts.accounts.length > 1)
const showStandard = ref(false)
const standardHidden = computed(
  () => severalAccounts.value && !showStandard.value && accountFilter.value !== SYSTEM_ACCOUNT_ID,
)
const standardName = computed(() => accounts.get(SYSTEM_ACCOUNT_ID)?.name ?? 'Standard')
/** The order of the accounts page, the standard account last when there are others. */
const accountOrder = computed(() => {
  if (!severalAccounts.value) return accounts.accounts
  return [...accounts.accounts].sort((a, b) => Number(a.id === SYSTEM_ACCOUNT_ID) - Number(b.id === SYSTEM_ACCOUNT_ID))
})
const accountOptions = computed<FilterOption[][]>(() => [
  accountOrder.value.map((a) => ({ value: a.id, label: a.name, color: a.color })),
])

const SORTS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Zuletzt aktiv' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Größe' },
  { value: 'count', label: 'Anzahl Sessions' },
]
const sort = ref<SessionSort>('recent')
const sortLabel = computed(() => SORTS.find((s) => s.value === sort.value)?.label)

const search = ref('')
const query = refDebounced(search, 150)
const terms = computed(() => searchTerms(query.value))
/** Matches in the conversations; titles and prompts are searched right here. */
const { hits } = useSessionSearch(query)
const selected = ref<SessionRef | null>(null)
const { detail, summary, loading, error } = useSessionDetail(selected)

/** Searching or filtering by age or size: then the folders with matches open by themselves. */
const filtering = computed(() => terms.value.length > 0 || age.value !== null || size.value !== null)
const filtersActive = computed(() => accountFilter.value !== 'all' || age.value !== null || size.value !== null)

function resetFilters() {
  accountFilter.value = 'all'
  ageFilter.value = 'all'
  sizeFilter.value = 'all'
}

function onSearchEscape(event: KeyboardEvent) {
  if (!search.value) return
  // Only the search: a selection stays.
  event.stopPropagation()
  search.value = ''
}

function inAge(session: SessionSummary): boolean {
  if (!age.value) return true
  const cutoff = now.value - age.value.days * DAY_MS
  const updated = Date.parse(session.updatedAt)
  return age.value.older ? updated < cutoff : updated >= cutoff
}

function inSize(session: SessionSummary): boolean {
  if (!size.value) return true
  return size.value.larger ? session.sizeBytes > size.value.bytes : session.sizeBytes < size.value.bytes
}

function matches(session: SessionSummary): boolean {
  if (!inAge(session) || !inSize(session)) return false
  if (terms.value.length === 0 || hits.value.has(sessionKey(session.accountId, session.id))) return true
  const text = searchText(
    session.title,
    session.firstPrompt,
    session.lastPrompt,
    session.cwd,
    session.gitBranch,
    session.worktree?.name,
    session.id,
  )
  return containsTerms(text, terms.value)
}

/** The accounts the account filter lets through. */
const filteredGroups = computed(() =>
  sessions.groups.filter((g) => accountFilter.value === 'all' || g.accountId === accountFilter.value),
)

/** The matching sessions of all accounts the list shows: a folder holds them together, whoever ran them. */
const visibleSessions = computed(() =>
  filteredGroups.value
    .filter((g) => !(standardHidden.value && g.accountId === SYSTEM_ACCOUNT_ID))
    .flatMap((g) => g.sessions.filter(matches)),
)

/** Matching sessions of the standard account while it is hidden. */
const hiddenStandardCount = computed(() => {
  if (!standardHidden.value) return 0
  return filteredGroups.value.find((g) => g.accountId === SYSTEM_ACCOUNT_ID)?.sessions.filter(matches).length ?? 0
})

/** Accounts whose sessions couldn't be read. */
const accountErrors = computed(() =>
  filteredGroups.value
    .filter((g) => g.error)
    .map((g) => ({ accountId: g.accountId, name: accounts.get(g.accountId)?.name ?? g.accountId, error: g.error })),
)

/** Where new sessions start without a folder chosen: the list keeps them apart from the projects. */
const startFolders = computed(() =>
  [settings.settings.claude.defaultCwd, app.info?.fallbackCwd, ...accounts.accounts.map((a) => a.defaultCwd)].filter(
    (path): path is string => !!path?.trim(),
  ),
)
const roots = computed<TreeRoots>(() => ({
  workspaces: workspaces.workspaces.map((w) => ({ path: w.path, projects: w.projects })),
  startFolders: startFolders.value,
}))
const workspaceByPath = computed(() => new Map(workspaces.workspaces.map((w) => [w.path, w])))

/** Workspaces › projects › sessions, the folders in no workspace and the start folders. */
const tree = computed(() =>
  // While searching or filtering, folders without matches go; otherwise every project shows, to start sessions there.
  buildSessionTree(visibleSessions.value, roots.value, { sort: sort.value, home: app.info?.homeDir, showEmpty: !filtering.value }),
)

/** A section of the list: a workspace, the other folders (`root` null) or a start folder. */
interface Section {
  id: string
  root: SessionRoot | null
  projects: SessionProject[]
  /** Sessions in the root's own folder. */
  sessions: SessionSummary[]
  count: number
}

const sections = computed<Section[]>(() => {
  const { workspaces: ws, folders, starts } = tree.value
  const ofRoot = (root: SessionRoot): Section => ({ id: root.id, root, projects: root.projects, sessions: root.sessions, count: root.count })
  const rest: Section[] = folders.length
    ? [{ id: FOLDERS_SECTION_ID, root: null, projects: folders, sessions: [], count: folders.reduce((n, p) => n + p.sessions.length, 0) }]
    : []
  // The start folders first (closed, out of the way), the workspaces in the order the user dragged them into.
  return [...starts.map(ofRoot), ...ws.map(ofRoot), ...rest]
})
const workspaceSections = computed(() => sections.value.filter((s) => s.root?.kind === 'workspace'))

const projects = computed(() => sections.value.flatMap((s) => s.projects))
/** The sessions in the list, in its order. */
const shown = computed(() => sections.value.flatMap((s) => [...s.projects.flatMap((p) => p.sessions), ...s.sessions]))
const total = computed(() => shown.value.length)
const totalBytes = computed(() => shown.value.reduce((sum, s) => sum + s.sizeBytes, 0))
const folderCount = computed(() => projects.value.filter((p) => p.sessions.length > 0).length)

const emptyMessage = computed(() => {
  const filtered = age.value !== null || size.value !== null
  if (query.value) return `Keine Session passt zu „${query.value}“${filtered ? ' und den Filtern' : ''}.`
  return filtered ? 'Keine Session passt zu den Filtern.' : null
})

// --- opening and closing sections and folders --------------------------------
function toggled(set: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

/**
 * Sections and folders whose state differs from how they start (see `opensByDefault`): workspaces and
 * the other folders open, start folders and folders closed, for an overview.
 */
const flipped = ref(new Set<string>())
/** While searching or filtering every section and folder with matches is open, except those closed meanwhile. */
const closedWhileFiltering = ref(new Set<string>())
watch([query, ageFilter, sizeFilter], () => {
  closedWhileFiltering.value = new Set()
})

function isOpen(id: string): boolean {
  return filtering.value ? !closedWhileFiltering.value.has(id) : opensByDefault(id) !== flipped.value.has(id)
}

/** Sets how a section or folder stays once the search is cleared, without the rest of `setOpen`. */
function keepOpen(id: string, open: boolean) {
  flipped.value = toggled(flipped.value, id, open !== opensByDefault(id))
}

function setOpen(id: string, open: boolean) {
  if (filtering.value) closedWhileFiltering.value = toggled(closedWhileFiltering.value, id, !open)
  // Opened while searching, it stays open once the search is cleared.
  keepOpen(id, open)
}

const openProjects = computed(() => new Set(projects.value.filter((p) => isOpen(p.id)).map((p) => p.id)))

/** The folders with sessions in the open sections. */
const reachableProjects = computed(() =>
  sections.value.filter((s) => isOpen(s.id)).flatMap((s) => s.projects.filter((p) => p.sessions.length > 0)),
)
const allOpen = computed(
  () => reachableProjects.value.length > 0 && reachableProjects.value.every((p) => openProjects.value.has(p.id)),
)

function toggleAll() {
  const ids = projects.value.filter((p) => p.sessions.length > 0).map((p) => p.id)
  if (allOpen.value) {
    for (const id of ids) keepOpen(id, false)
    closedWhileFiltering.value = new Set([...closedWhileFiltering.value, ...ids])
  } else {
    for (const id of [...sections.value.map((s) => s.id), ...ids]) keepOpen(id, true)
    closedWhileFiltering.value = new Set()
  }
}

/** Opens the section and the folder of a place in the list. */
function revealPlace(place: Placement) {
  keepOpen(place.rootId ?? FOLDERS_SECTION_ID, true)
  if (place.projectId) keepOpen(place.projectId, true)
}

/** Opens the section and the folder of a session. */
function reveal(target: SessionRef) {
  const session = sessions.groups
    .find((g) => g.accountId === target.accountId)
    ?.sessions.find((s) => s.id === target.sessionId)
  if (session) revealPlace(placeSession(session, roots.value))
}

// --- selecting several sessions, e.g. to delete the old ones ----------------
const selecting = ref(false)
const checked = ref(new Set<string>())
/** Where a Shift+click range starts. */
let anchor: string | null = null
/** Only what the filters show: a checked session that is filtered out is not deleted. */
const checkedSessions = computed(() => shown.value.filter((s) => checked.value.has(sessionKey(s.accountId, s.id))))
const checkedBytes = computed(() => checkedSessions.value.reduce((sum, s) => sum + s.sizeBytes, 0))
const allState = computed(() => {
  const count = checkedSessions.value.length
  if (count === 0) return false
  return count === shown.value.length ? true : 'indeterminate'
})

/** The sessions one can see, top to bottom: a Shift+click range leaves out closed folders. */
const visibleOrder = computed(() =>
  sections.value
    .filter((s) => isOpen(s.id))
    .flatMap((s) => [...s.projects.filter((p) => openProjects.value.has(p.id)).flatMap((p) => p.sessions), ...s.sessions]),
)

function startSelecting() {
  selecting.value = true
  checked.value = new Set()
  anchor = null
}

function stopSelecting() {
  selecting.value = false
  checked.value = new Set()
  anchor = null
}

function toggle(session: SessionSummary, range: boolean) {
  if (!selecting.value) startSelecting()
  const key = sessionKey(session.accountId, session.id)
  const next = new Set(checked.value)
  const keys = range && anchor ? visibleOrder.value.map((s) => sessionKey(s.accountId, s.id)) : []
  const from = anchor ? keys.indexOf(anchor) : -1
  const to = keys.indexOf(key)
  if (from !== -1 && to !== -1) {
    for (const k of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(k)
  } else if (next.has(key)) next.delete(key)
  else next.add(key)
  anchor = key
  checked.value = next
}

/** Checks or unchecks all sessions of a folder. */
function checkProject(project: SessionProject, value: boolean) {
  if (!selecting.value) startSelecting()
  const next = new Set(checked.value)
  for (const s of project.sessions) {
    if (value) next.add(sessionKey(s.accountId, s.id))
    else next.delete(sessionKey(s.accountId, s.id))
  }
  checked.value = next
  anchor = null
}

function setAll(value: boolean | 'indeterminate') {
  checked.value = value === true ? new Set(shown.value.map((s) => sessionKey(s.accountId, s.id))) : new Set()
  anchor = null
}

async function removeChecked() {
  if (await removal.remove(checkedSessions.value)) stopSelecting()
}

function onKeydown(event: KeyboardEvent) {
  if (!selecting.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    stopSelecting()
  } else if (event.key === 'a' && event.ctrlKey && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault()
    setAll(true)
  }
}

function select(session: SessionSummary) {
  selected.value = { accountId: session.accountId, sessionId: session.id }
  // Its folder stays open after a search.
  revealPlace(placeSession(session, roots.value))
}

const list = ref<HTMLElement | null>(null)

// Workspaces are dragged by their header; the order is saved (`workspaces.json`).
useSectionDrag(list, { onDrop: moveWorkspace })

/** Puts the workspace before another one (null: last) and saves the order. */
function moveWorkspace(path: string, before: string | null) {
  const order = workspaces.workspaces.map((w) => w.path).filter((p) => p !== path)
  const at = before === null ? -1 : order.indexOf(before)
  order.splice(at === -1 ? order.length : at, 0, path)
  void attempt(() => workspaces.reorder(order), 'Reihenfolge konnte nicht gespeichert werden')
}

/** Up or down past the next workspace shown (while searching, others may be left out). */
function moveSection(section: Section, offset: -1 | 1) {
  const shownWorkspaces = workspaceSections.value
  const index = shownWorkspaces.indexOf(section)
  const path = section.root?.path
  if (index === -1 || !path || !shownWorkspaces[index + offset]) return
  const before = offset < 0 ? shownWorkspaces[index - 1]?.root?.path : shownWorkspaces[index + 2]?.root?.path
  moveWorkspace(path, before ?? null)
}

/** A folder shown from elsewhere stands out for a moment. */
const highlightedProject = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | undefined

/** Reads what the list needs once: the sessions and the workspaces. */
function loadOnce(): Promise<unknown> {
  return Promise.all([sessions.loaded ? null : sessions.load(), workspaces.loaded ? null : workspaces.load()])
}

// A folder in the dashboard, or a new workspace: open it and scroll to it, without search or filters.
watch(
  () => ui.folderToShow,
  (target) => {
    if (!target) return
    ui.folderToShow = null
    search.value = ''
    resetFilters()
    stopSelecting()
    if (target.accountId === SYSTEM_ACCOUNT_ID) showStandard.value = true
    void loadOnce().then(
      () => {
        const place = placeFolder(target.path, target.projectKey ?? '', roots.value)
        revealPlace(place)
        const id = place.projectId ?? place.rootId ?? FOLDERS_SECTION_ID
        highlightedProject.value = id
        clearTimeout(highlightTimer)
        highlightTimer = setTimeout(() => (highlightedProject.value = null), 2000)
        return nextTick(() => list.value?.querySelector(`[data-project-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' }))
      },
      () => undefined,
    )
  },
  { immediate: true },
)

// "Verlauf lesen" in the tab search: select the session and keep the search that found it.
watch(
  () => ui.sessionToShow,
  (target) => {
    if (!target) return
    ui.sessionToShow = null
    search.value = target.query
    resetFilters()
    stopSelecting()
    if (target.accountId === SYSTEM_ACCOUNT_ID) showStandard.value = true
    const session = { accountId: target.accountId, sessionId: target.sessionId }
    selected.value = session
    // Its folder stays open once the search is cleared.
    void loadOnce().then(
      () => reveal(session),
      () => undefined,
    )
    // Once the list is filtered (the search is debounced) and rendered.
    setTimeout(() => {
      void nextTick(() => list.value?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' }))
    }, 250)
  },
  { immediate: true },
)

/** The folders the list shows, to find out which of them aren't there (any more). */
const shownFolders = computed(() => {
  const { workspaces: inWorkspaces, starts, folders } = tree.value
  const paths = [...inWorkspaces, ...starts].flatMap((root) => root.projects.map((p) => p.path)).concat(folders.map((f) => f.path))
  return [...new Set(paths.filter((path): path is string => !!path))].sort()
})
const checkFolders = () => workspaces.checkFolders(shownFolders.value)
watch(() => shownFolders.value.join('\n'), () => void checkFolders(), { immediate: true })
// A project gone from its workspace stays in the list while sessions name it: check it then too.
watch(() => workspaces.workspaces, () => void checkFolders())
// Moved or deleted in Explorer meanwhile: shown as gone once the window is back.
useEventListener(window, 'focus', () => void checkFolders())

const load = () => attempt(() => Promise.all([sessions.load(), workspaces.load()]), 'Sessions konnten nicht geladen werden')
/**
 * Reads everything again: the workspaces first, as folders moved meanwhile (in Explorer) take their
 * sessions along, then the sessions, then which folders are gone.
 */
const reload = () =>
  attempt(async () => {
    await workspaces.load()
    await sessions.load()
    await checkFolders()
  }, 'Sessions konnten nicht geladen werden')
onMounted(load)
onActivated(() => {
  if (!sessions.loaded || !workspaces.loaded) void load()
  else void checkFolders()
})
</script>

<template>
  <div class="flex size-full min-h-0">
    <aside class="flex w-96 shrink-0 flex-col border-r" @keydown="onKeydown">
      <div class="flex flex-col gap-2 border-b p-3 pb-2">
        <div class="flex items-center gap-2">
          <InputGroup class="h-[32px] flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              v-model="search"
              placeholder="Sessions durchsuchen…"
              spellcheck="false"
              @keydown.esc="onSearchEscape"
            />
            <InputGroupAddon v-if="search" align="inline-end">
              <InputGroupButton size="icon-xs" class="size-[24px]" aria-label="Suche leeren" @click="search = ''">
                <XIcon class="size-[16px]" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="outline"
                aria-label="Mehrere auswählen"
                :aria-pressed="selecting"
                :class="cn(TOOL_BUTTON, selecting && TOOL_BUTTON_PRESSED)"
                @click="selecting ? stopSelecting() : startSelecting()"
              >
                <ListChecksIcon class="size-[16px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ selecting ? 'Auswahl beenden' : 'Mehrere auswählen (Umschalt+Klick für Bereiche)' }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="outline" aria-label="Neuer Workspace" :class="TOOL_BUTTON" @click="ui.workspaceRequest = { mode: 'create' }">
                <FolderPlusIcon class="size-[16px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Neuer Workspace</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="outline" aria-label="Neu einlesen" :class="TOOL_BUTTON" :disabled="sessions.loading" @click="reload">
                <Spinner v-if="sessions.loading" class="size-[16px]" />
                <RefreshCwIcon v-else class="size-[16px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Neu einlesen</TooltipContent>
          </Tooltip>
        </div>

        <div class="flex min-w-0 items-center gap-1.5">
          <SessionFilterChip
            v-if="accounts.accounts.length > 1"
            v-model="accountFilter"
            :icon="UsersIcon"
            name="Account"
            all-label="Alle Accounts"
            :groups="accountOptions"
          >
            <template #option="{ option }">
              <AccountDot :color="option.color" />
              {{ option.label }}
            </template>
          </SessionFilterChip>
          <SessionFilterChip
            v-model="ageFilter"
            :icon="ClockIcon"
            name="Zeitraum"
            all-label="Jeder Zeitraum"
            :groups="AGE_FILTERS"
          />
          <SessionFilterChip v-model="sizeFilter" :icon="HardDriveIcon" name="Größe" all-label="Jede Größe" :groups="SIZE_FILTERS" />
          <Tooltip v-if="filtersActive">
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="Filter zurücksetzen" @click="resetFilters">
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Filter zurücksetzen</TooltipContent>
          </Tooltip>
        </div>

        <div class="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span class="min-w-0 flex-1 truncate tabular-nums">
            {{ total }} {{ total === 1 ? 'Session' : 'Sessions' }} · {{ folderCount }} Ordner · {{ formatBytes(totalBytes) }}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="xs" class="font-normal text-muted-foreground" aria-label="Ordner sortieren">
                <ArrowDownWideNarrowIcon data-icon="inline-start" />
                {{ sortLabel }}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-auto min-w-44">
              <DropdownMenuLabel>Ordner sortieren nach</DropdownMenuLabel>
              <DropdownMenuRadioGroup v-model="sort">
                <DropdownMenuRadioItem v-for="option in SORTS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-xs"
                class="text-muted-foreground"
                :aria-label="allOpen ? 'Alle Ordner zuklappen' : 'Alle Ordner aufklappen'"
                :disabled="projects.length === 0"
                @click="toggleAll"
              >
                <ChevronsDownUpIcon v-if="allOpen" />
                <ChevronsUpDownIcon v-else />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ allOpen ? 'Alle Ordner zuklappen' : 'Alle Ordner aufklappen' }}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <!-- Room for the scrollbar is kept, so the rows don't move when it comes; the padding evens out its width. -->
      <div ref="list" class="min-h-0 flex-1 overflow-y-auto py-2 pr-0.5 pl-2.5 [scrollbar-gutter:stable]">
        <div v-if="!sessions.loaded" class="flex flex-col gap-3 p-2">
          <Skeleton v-for="i in 8" :key="i" class="h-8 w-full" />
        </div>
        <div v-else class="flex flex-col gap-3">
          <p
            v-for="failure in accountErrors"
            :key="failure.accountId"
            class="flex items-center gap-2 px-3 py-1 text-xs text-destructive"
          >
            <TriangleAlertIcon class="size-3.5 shrink-0" />
            <span class="min-w-0">{{ failure.name }}: {{ failure.error }}</span>
          </p>
          <SessionRootSection
            v-for="section in sections"
            :key="section.id"
            :root="section.root"
            :workspace="section.root ? workspaceByPath.get(section.root.path) : null"
            :title="tree.workspaces.length ? 'Weitere Ordner' : 'Ordner'"
            :projects="section.projects"
            :count="section.count"
            :open="isOpen(section.id)"
            :open-projects="openProjects"
            :selected="selected"
            :now="now"
            :hits="hits"
            :terms="terms"
            :selecting="selecting"
            :checked="checked"
            :highlighted="highlightedProject"
            :sortable="section.root?.kind === 'workspace' && workspaceSections.length > 1"
            :can-move-up="section.root?.kind === 'workspace' && workspaceSections.indexOf(section) > 0"
            :can-move-down="section.root?.kind === 'workspace' && workspaceSections.indexOf(section) < workspaceSections.length - 1"
            @update:open="setOpen(section.id, $event)"
            @move="moveSection(section, $event)"
            @open-project="(project, open) => setOpen(project.id, open)"
            @select="select"
            @toggle="toggle"
            @check="checkProject"
          />
          <p v-if="emptyMessage && total === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
            {{ emptyMessage }}
          </p>
          <p v-else-if="sections.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
            Noch keine Sessions.
          </p>
          <div
            v-if="hiddenStandardCount > 0 || (severalAccounts && showStandard && accountFilter === 'all')"
            class="flex items-center gap-2 rounded-lg bg-muted/40 py-1 pr-1 pl-3 text-xs text-muted-foreground"
          >
            <EyeOffIcon v-if="hiddenStandardCount > 0" class="size-3.5 shrink-0" />
            <EyeIcon v-else class="size-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate tabular-nums">
              <template v-if="hiddenStandardCount > 0">
                „{{ standardName }}“ ausgeblendet ·
                {{ hiddenStandardCount }} {{ filtering ? 'Treffer' : hiddenStandardCount === 1 ? 'Session' : 'Sessions' }}
              </template>
              <template v-else>„{{ standardName }}“ wird angezeigt</template>
            </span>
            <Button variant="ghost" size="xs" @click="showStandard = hiddenStandardCount > 0">
              {{ hiddenStandardCount > 0 ? 'Anzeigen' : 'Ausblenden' }}
            </Button>
          </div>
        </div>
      </div>

      <div v-if="selecting" class="flex items-center gap-2 border-t p-3">
        <Checkbox
          id="sessions-check-all"
          :model-value="allState"
          :disabled="total === 0"
          aria-label="Alle angezeigten Sessions auswählen"
          class="data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground"
          @update:model-value="setAll"
        >
          <template #default="{ state }">
            <MinusIcon v-if="state === 'indeterminate'" />
            <CheckIcon v-else />
          </template>
        </Checkbox>
        <label for="sessions-check-all" class="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
          <template v-if="checkedSessions.length > 0">
            {{ checkedSessions.length }} von {{ total }} · {{ formatBytes(checkedBytes) }}
          </template>
          <template v-else>Alle {{ total }} auswählen</template>
        </label>
        <Button variant="ghost" size="sm" @click="stopSelecting">Fertig</Button>
        <Button
          variant="destructive"
          size="sm"
          :disabled="checkedSessions.length === 0 || sessions.removing"
          @click="removeChecked"
        >
          <Spinner v-if="sessions.removing" data-icon="inline-start" />
          <Trash2Icon v-else data-icon="inline-start" />
          Löschen
        </Button>
      </div>
    </aside>

    <section class="min-w-0 flex-1">
      <SessionDetailPanel v-if="summary" :summary="summary" :detail="detail" :loading="loading" :error="error" />
      <Empty v-else class="size-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>Session auswählen</EmptyTitle>
          <EmptyDescription>
            Wähle links eine Session, um den Verlauf zu lesen. Doppelklick setzt sie direkt in einem neuen Tab fort.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  </div>
</template>
