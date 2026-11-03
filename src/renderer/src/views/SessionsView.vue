<script setup lang="ts">
import { CheckIcon, HistoryIcon, ListChecksIcon, MinusIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from '@lucide/vue'
import { refDebounced } from '@vueuse/core'
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import type { SessionSummary } from '@shared/types'
import { searchTerms } from '@shared/utils'
import AccountDot from '@/components/common/AccountDot.vue'
import SessionDetailPanel from '@/components/sessions/SessionDetailPanel.vue'
import SessionFilterSelect from '@/components/sessions/SessionFilterSelect.vue'
import SessionGroupSection from '@/components/sessions/SessionGroupSection.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionDetail, type SessionRef } from '@/composables/useSessionDetail'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { sessionKey, useSessionSearch } from '@/composables/useSessionSearch'
import { attempt } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { containsTerms, searchText } from '@/lib/search'
import { useAccountsStore } from '@/stores/accounts'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'
import { useClock } from '@/composables/useClock'

const sessions = useSessionsStore()
const accounts = useAccountsStore()
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
    { value: 'over-1m', label: 'Größer als 1 MB', bytes: MB, larger: true },
    { value: 'over-10m', label: 'Größer als 10 MB', bytes: 10 * MB, larger: true },
    { value: 'over-50m', label: 'Größer als 50 MB', bytes: 50 * MB, larger: true },
  ],
  [
    { value: 'under-1m', label: 'Kleiner als 1 MB', bytes: MB, larger: false },
    { value: 'under-100k', label: 'Kleiner als 100 KB', bytes: 100 * KB, larger: false },
    { value: 'under-10k', label: 'Kleiner als 10 KB', bytes: 10 * KB, larger: false },
  ],
]
const sizeFilter = ref('all')
const size = computed(() => SIZE_FILTERS.flat().find((f) => f.value === sizeFilter.value) ?? null)

const search = ref('')
const query = refDebounced(search, 150)
const terms = computed(() => searchTerms(query.value))
/** Matches in the conversations; titles and prompts are searched right here. */
const { hits } = useSessionSearch(query)
const accountFilter = ref('all')
const selected = ref<SessionRef | null>(null)
const { detail, summary, loading, error } = useSessionDetail(selected)

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

const groups = computed(() => {
  const filtering = terms.value.length > 0 || age.value !== null || size.value !== null
  // Keep the account order of the accounts page.
  const order = new Map(accounts.accounts.map((a, i) => [a.id, i]))
  return sessions.groups
    .filter((g) => accountFilter.value === 'all' || g.accountId === accountFilter.value)
    .map((g) => ({ ...g, sessions: g.sessions.filter(matches) }))
    .filter((g) => !filtering || g.sessions.length > 0)
    .sort((a, b) => (order.get(a.accountId) ?? 99) - (order.get(b.accountId) ?? 99))
})

/** The sessions in the list, in its order. */
const shown = computed(() => groups.value.flatMap((g) => g.sessions))
const total = computed(() => shown.value.length)
const totalBytes = computed(() => shown.value.reduce((sum, s) => sum + s.sizeBytes, 0))

const emptyMessage = computed(() => {
  const filtered = age.value !== null || size.value !== null
  if (query.value) return `Keine Session passt zu „${query.value}“${filtered ? ' und den Filtern' : ''}.`
  return filtered ? 'Keine Session passt zu den Filtern.' : null
})

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
  const keys = range && anchor ? shown.value.map((s) => sessionKey(s.accountId, s.id)) : []
  const from = anchor ? keys.indexOf(anchor) : -1
  const to = keys.indexOf(key)
  if (from !== -1 && to !== -1) {
    for (const k of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(k)
  } else if (next.has(key)) next.delete(key)
  else next.add(key)
  anchor = key
  checked.value = next
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
}

const list = ref<HTMLElement | null>(null)

// "Verlauf lesen" in the tab search: select the session and keep the search that found it.
watch(
  () => ui.sessionToShow,
  (target) => {
    if (!target) return
    ui.sessionToShow = null
    search.value = target.query
    accountFilter.value = 'all'
    ageFilter.value = 'all'
    sizeFilter.value = 'all'
    stopSelecting()
    selected.value = { accountId: target.accountId, sessionId: target.sessionId }
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
      <div class="flex flex-col gap-2 border-b p-3">
        <div class="flex items-center gap-2">
          <InputGroup class="flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput v-model="search" placeholder="Sessions durchsuchen…" spellcheck="false" />
          </InputGroup>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                :variant="selecting ? 'secondary' : 'ghost'"
                size="icon-sm"
                aria-label="Mehrere auswählen"
                :aria-pressed="selecting"
                @click="selecting ? stopSelecting() : startSelecting()"
              >
                <ListChecksIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ selecting ? 'Auswahl beenden' : 'Mehrere auswählen (Umschalt+Klick für Bereiche)' }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon-sm" aria-label="Neu einlesen" :disabled="sessions.loading" @click="load">
                <Spinner v-if="sessions.loading" />
                <RefreshCwIcon v-else />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Neu einlesen</TooltipContent>
          </Tooltip>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <Select v-model="accountFilter">
            <SelectTrigger size="sm" class="w-full min-w-0" aria-label="Account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Alle Accounts</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectItem v-for="account in accounts.accounts" :key="account.id" :value="account.id">
                  <AccountDot :color="account.color" />
                  {{ account.name }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <SessionFilterSelect v-model="ageFilter" label="Zeitraum" all-label="Jeder Zeitraum" :groups="AGE_FILTERS" />
          <SessionFilterSelect v-model="sizeFilter" label="Größe" all-label="Jede Größe" :groups="SIZE_FILTERS" />
          <span class="self-center truncate text-right text-xs text-muted-foreground tabular-nums">
            {{ total }} {{ total === 1 ? 'Session' : 'Sessions' }} · {{ formatBytes(totalBytes) }}
          </span>
        </div>
      </div>

      <div ref="list" class="min-h-0 flex-1 overflow-y-auto p-2">
        <div v-if="!sessions.loaded" class="flex flex-col gap-3 p-2">
          <Skeleton v-for="i in 8" :key="i" class="h-12 w-full" />
        </div>
        <div v-else class="flex flex-col gap-3">
          <SessionGroupSection
            v-for="group in groups"
            :key="group.accountId"
            :account-id="group.accountId"
            :sessions="group.sessions"
            :error="group.error"
            :selected="selected"
            :now="now"
            :hits="hits"
            :terms="terms"
            :selecting="selecting"
            :checked="checked"
            @select="select"
            @toggle="toggle"
          />
          <p v-if="emptyMessage && total === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
            {{ emptyMessage }}
          </p>
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
