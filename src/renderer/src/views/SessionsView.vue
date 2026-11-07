<script setup lang="ts">
import {
  ArrowDownWideNarrowIcon,
  CheckIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  HardDriveIcon,
  HistoryIcon,
  ListChecksIcon,
  MinusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from '@lucide/vue'
import { refDebounced } from '@vueuse/core'
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { SessionSummary } from '@shared/types'
import { searchTerms } from '@shared/utils'
import AccountDot from '@/components/common/AccountDot.vue'
import SessionDetailPanel from '@/components/sessions/SessionDetailPanel.vue'
import SessionFilterChip, { type FilterOption } from '@/components/sessions/SessionFilterChip.vue'
import SessionGroupSection from '@/components/sessions/SessionGroupSection.vue'
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
import { useSessionDetail, type SessionRef } from '@/composables/useSessionDetail'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { sessionKey, useSessionSearch } from '@/composables/useSessionSearch'
import { attempt } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { containsTerms, searchText } from '@/lib/search'
import { groupByProject, projectId, type SessionProject, type SessionSort } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'

/**
 * The buttons beside the search: as high as the field and in whole pixels (32px around a 16px icon,
 * the edge a ring), so the icon sits on whole device pixels at every UI size and scaling.
 */
const TOOL_BUTTON = 'size-[32px] rounded-lg border-0 bg-transparent p-0 ring-1 ring-input ring-inset'
const TOOL_BUTTON_PRESSED =
  'bg-primary/10 ring-primary/40 hover:bg-primary/15 dark:bg-primary/10 dark:ring-primary/30 dark:hover:bg-primary/15'

const sessions = useSessionsStore()
const accounts = useAccountsStore()
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
  const text = searchText(session.title, session.firstPrompt, session.lastPrompt, session.cwd, session.gitBranch, session.id)
  return containsTerms(text, terms.value)
}

/** Account › folder › sessions, the standard account included. */
const allGroups = computed(() => {
  const order = new Map(accountOrder.value.map((a, i) => [a.id, i]))
  const home = app.info?.homeDir
  return sessions.groups
    .filter((g) => accountFilter.value === 'all' || g.accountId === accountFilter.value)
    .map((g) => {
      const matching = g.sessions.filter(matches)
      return {
        accountId: g.accountId,
        error: g.error,
        count: matching.length,
        projects: groupByProject(g.accountId, matching, sort.value, home),
      }
    })
    .filter((g) => !filtering.value || g.count > 0)
    .sort((a, b) => (order.get(a.accountId) ?? 99) - (order.get(b.accountId) ?? 99))
})

/** The standard account while it is hidden, with its matching sessions; null while shown or without matches. */
const hiddenStandard = computed(() => {
  if (!standardHidden.value) return null
  const group = allGroups.value.find((g) => g.accountId === SYSTEM_ACCOUNT_ID)
  return group && group.count > 0 ? group : null
})
const tree = computed(() =>
  standardHidden.value ? allGroups.value.filter((g) => g.accountId !== SYSTEM_ACCOUNT_ID) : allGroups.value,
)

const projects = computed(() => tree.value.flatMap((g) => g.projects))
/** The sessions in the list, in its order. */
const shown = computed(() => projects.value.flatMap((p) => p.sessions))
const total = computed(() => shown.value.length)
const totalBytes = computed(() => shown.value.reduce((sum, s) => sum + s.sizeBytes, 0))

const emptyMessage = computed(() => {
  const filtered = age.value !== null || size.value !== null
  if (query.value) return `Keine Session passt zu „${query.value}“${filtered ? ' und den Filtern' : ''}.`
  return filtered ? 'Keine Session passt zu den Filtern.' : null
})

// --- opening and closing accounts and folders --------------------------------
function toggled(set: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

const closedAccounts = ref(new Set<string>())
/** Folders start closed, for an overview; these were opened. */
const openedProjects = ref(new Set<string>())
/** While searching or filtering every folder with matches is open, except those closed meanwhile. */
const closedWhileFiltering = ref(new Set<string>())
watch([query, ageFilter, sizeFilter], () => {
  closedWhileFiltering.value = new Set()
})

const openProjects = computed(
  () =>
    new Set(
      projects.value
        .filter((p) => (filtering.value ? !closedWhileFiltering.value.has(p.id) : openedProjects.value.has(p.id)))
        .map((p) => p.id),
    ),
)

function setAccountOpen(accountId: string, open: boolean) {
  closedAccounts.value = toggled(closedAccounts.value, accountId, !open)
}

function setProjectOpen(project: SessionProject, open: boolean) {
  if (filtering.value) closedWhileFiltering.value = toggled(closedWhileFiltering.value, project.id, !open)
  // Opened while searching, it stays open once the search is cleared.
  openedProjects.value = toggled(openedProjects.value, project.id, open)
}

/** The folders of the accounts that are open. */
const reachableProjects = computed(() =>
  tree.value.filter((g) => !closedAccounts.value.has(g.accountId)).flatMap((g) => g.projects),
)
const allOpen = computed(
  () => reachableProjects.value.length > 0 && reachableProjects.value.every((p) => openProjects.value.has(p.id)),
)

function toggleAll() {
  const ids = projects.value.map((p) => p.id)
  if (allOpen.value) {
    openedProjects.value = new Set()
    closedWhileFiltering.value = new Set(ids)
  } else {
    closedAccounts.value = new Set()
    openedProjects.value = new Set([...openedProjects.value, ...ids])
    closedWhileFiltering.value = new Set()
  }
}

/** Opens the account and the folder of a session. */
function reveal(target: SessionRef) {
  const session = sessions.groups
    .find((g) => g.accountId === target.accountId)
    ?.sessions.find((s) => s.id === target.sessionId)
  if (!session) return
  closedAccounts.value = toggled(closedAccounts.value, session.accountId, false)
  openedProjects.value = toggled(openedProjects.value, projectId(session.accountId, session), true)
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
  reachableProjects.value.filter((p) => openProjects.value.has(p.id)).flatMap((p) => p.sessions),
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
  openedProjects.value = toggled(openedProjects.value, projectId(session.accountId, session), true)
}

const list = ref<HTMLElement | null>(null)

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
    void (sessions.loaded ? Promise.resolve() : sessions.load()).then(
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

const load = () => attempt(() => sessions.load(), 'Sessions konnten nicht geladen werden')
onMounted(load)
onActivated(() => {
  if (!sessions.loaded) void load()
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
              <Button variant="outline" aria-label="Neu einlesen" :class="TOOL_BUTTON" :disabled="sessions.loading" @click="load">
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
            {{ total }} {{ total === 1 ? 'Session' : 'Sessions' }} · {{ projects.length }} Ordner · {{ formatBytes(totalBytes) }}
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

      <div ref="list" class="min-h-0 flex-1 overflow-y-auto p-2">
        <div v-if="!sessions.loaded" class="flex flex-col gap-3 p-2">
          <Skeleton v-for="i in 8" :key="i" class="h-8 w-full" />
        </div>
        <div v-else class="flex flex-col gap-3">
          <SessionGroupSection
            v-for="group in tree"
            :key="group.accountId"
            :account-id="group.accountId"
            :projects="group.projects"
            :count="group.count"
            :error="group.error"
            :open="!closedAccounts.has(group.accountId)"
            :open-projects="openProjects"
            :selected="selected"
            :now="now"
            :hits="hits"
            :terms="terms"
            :selecting="selecting"
            :checked="checked"
            @update:open="setAccountOpen(group.accountId, $event)"
            @open-project="setProjectOpen"
            @select="select"
            @toggle="toggle"
            @check="checkProject"
          />
          <p v-if="emptyMessage && total === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
            {{ emptyMessage }}
          </p>
          <div
            v-if="hiddenStandard || (severalAccounts && showStandard && accountFilter === 'all')"
            class="flex items-center gap-2 rounded-lg bg-muted/40 py-1 pr-1 pl-3 text-xs text-muted-foreground"
          >
            <EyeOffIcon v-if="hiddenStandard" class="size-3.5 shrink-0" />
            <EyeIcon v-else class="size-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate tabular-nums">
              <template v-if="hiddenStandard">
                „{{ standardName }}“ ausgeblendet ·
                {{ hiddenStandard.count }} {{ filtering ? 'Treffer' : hiddenStandard.count === 1 ? 'Session' : 'Sessions' }}
              </template>
              <template v-else>„{{ standardName }}“ wird angezeigt</template>
            </span>
            <Button variant="ghost" size="xs" @click="showStandard = !!hiddenStandard">
              {{ hiddenStandard ? 'Anzeigen' : 'Ausblenden' }}
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
