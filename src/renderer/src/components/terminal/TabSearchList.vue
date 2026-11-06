<script setup lang="ts">
import {
  HistoryIcon,
  KeyRoundIcon,
  MessageSquareTextIcon,
  SearchIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { refDebounced } from '@vueuse/core'
import { injectListboxRootContext, ListboxContent, ListboxFilter, ListboxGroup, ListboxGroupLabel, ListboxItem } from 'reka-ui'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { SessionSearchHit, SessionSummary, TerminalInfo } from '@shared/types'
import { searchTerms } from '@shared/utils'
import AccountDot from '@/components/common/AccountDot.vue'
import HighlightText from '@/components/common/HighlightText.vue'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClock } from '@/composables/useClock'
import { useLauncher } from '@/composables/useLauncher'
import { sessionKey, useSessionSearch } from '@/composables/useSessionSearch'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { formatRelative, shortenPath } from '@/lib/format'
import { containsTerms, searchText } from '@/lib/search'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSessionsStore } from '@/stores/sessions'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import BrowserFavicon from './BrowserFavicon.vue'

/** Sessions listed at most for a search; with more, another word narrows it down better than scrolling. */
const MAX_SESSIONS = 50
/** Sessions offered to carry on with before anything is typed. */
const RECENT_SESSIONS = 8

/**
 * The open tabs and the sessions, searched by title and through the conversation, like the tab search
 * of a browser. Lives inside a ListboxRoot, whose keyboard navigation it drives from the input.
 */
const emit = defineEmits<{ done: [] }>()

const route = useRoute()
const router = useRouter()
const app = useAppStore()
const accounts = useAccountsStore()
const sessions = useSessionsStore()
const terminals = useTerminalsStore()
const ui = useUiStore()
const launcher = useLauncher()
const { closeTerminal } = useTerminalActions()
const listbox = injectListboxRootContext()
const now = useClock(60_000)

const query = ref('')
/** Titles are filtered on every key, the conversations shortly after typing stops. */
const terms = computed(() => searchTerms(query.value))
const { hits, searching, prepare } = useSessionSearch(refDebounced(query, 150))

onMounted(() => {
  prepare()
  if (!sessions.loaded) void sessions.load()
  listbox.highlightFirstItem()
})

/** Every session with the fields its title search runs on, by `sessionKey`. */
const indexed = computed(() => {
  const map = new Map<string, { session: SessionSummary; text: string }>()
  for (const group of sessions.groups) {
    for (const session of group.sessions) {
      const text = searchText(session.title, session.firstPrompt, session.lastPrompt, session.cwd, session.gitBranch)
      map.set(sessionKey(session.accountId, session.id), { session, text })
    }
  }
  return map
})

interface TabRow {
  key: string
  terminal: TerminalInfo
  session: SessionSummary | null
  /** Set when only the conversation matched. */
  hit: SessionSearchHit | null
}

interface SessionRow {
  key: string
  session: SessionSummary
  hit: SessionSearchHit | null
  named: boolean
}

const tabRows = computed<TabRow[]>(() =>
  terminals.terminals.flatMap((terminal) => {
    const key = terminal.sessionId ? sessionKey(terminal.accountId, terminal.sessionId) : null
    const entry = key ? indexed.value.get(key) : undefined
    const hit = (key && hits.value.get(key)) || null
    const named = containsTerms(
      searchText(terminal.title, terminal.cwd, accounts.get(terminal.authAccountId)?.name, entry?.text),
      terms.value,
    )
    if (!named && !hit) return []
    return [{ key: `tab:${terminal.id}`, terminal, session: entry?.session ?? null, hit: named ? null : hit }]
  }),
)

/** Sessions open in a tab are listed with the tabs. */
const openKeys = computed(
  () => new Set(terminals.terminals.flatMap((t) => (t.sessionId ? [sessionKey(t.accountId, t.sessionId)] : []))),
)

const sessionMatches = computed<SessionRow[]>(() => {
  const rows: SessionRow[] = []
  for (const [key, { session, text }] of indexed.value) {
    if (openKeys.value.has(key)) continue
    const named = containsTerms(text, terms.value)
    const hit = (terms.value.length > 0 && hits.value.get(key)) || null
    if (named || hit) rows.push({ key, session, hit: named ? null : hit, named })
  }
  // Matches in the title before those in the conversation, each newest first.
  return rows.sort((a, b) => Number(b.named) - Number(a.named) || b.session.updatedAt.localeCompare(a.session.updatedAt))
})
const sessionRows = computed(() => sessionMatches.value.slice(0, terms.value.length ? MAX_SESSIONS : RECENT_SESSIONS))
const hiddenSessions = computed(() => (terms.value.length ? sessionMatches.value.length - sessionRows.value.length : 0))
const nothingFound = computed(
  () => terms.value.length > 0 && !searching.value && tabRows.value.length === 0 && sessionRows.value.length === 0,
)

// The list changes while typing and again when the conversations have been searched:
// Enter has to keep hitting a row that is still there.
watch([tabRows, sessionRows], () => {
  void nextTick(() => {
    if (!listbox.highlightedElement.value?.isConnected) listbox.highlightFirstItem()
  })
})

const multipleAccounts = computed(() => accounts.accounts.length > 1)

function folderName(path: string | null): string | null {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? null
}

function tabDetails(row: TabRow): string {
  const { terminal } = row
  if (terminal.mode === 'browser') return terminal.url === 'about:blank' ? 'Browser' : `Browser · ${terminal.url}`
  const state =
    terminal.status === 'exited'
      ? 'Beendet'
      : terminal.limit
        ? 'Limit erreicht'
        : terminal.mode === 'login'
          ? 'Anmeldung'
          : terminal.mode === 'shell'
            ? 'Shell'
            : null
  return [
    folderName(terminal.cwd),
    row.session?.gitBranch,
    multipleAccounts.value ? accounts.get(terminal.authAccountId)?.name : null,
    state,
  ]
    .filter(Boolean)
    .join(' · ')
}

function sessionDetails(session: SessionSummary): string {
  return [
    shortenPath(session.cwd, app.info?.homeDir),
    session.gitBranch,
    multipleAccounts.value ? accounts.get(session.accountId)?.name : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function openTab(terminal: TerminalInfo) {
  emit('done')
  terminals.activate(terminal.id)
  if (route.name !== 'terminals') void router.push({ name: 'terminals' })
}

function resume(session: SessionSummary) {
  emit('done')
  void launcher.resume(session)
}

function showConversation(session: SessionSummary) {
  emit('done')
  ui.sessionToShow = { accountId: session.accountId, sessionId: session.id, query: query.value.trim() }
  void router.push({ name: 'sessions' })
}

const rowClass =
  'group/row flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 outline-none select-none data-highlighted:bg-accent'
const groupLabelClass = 'px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground'
/** Shown on the highlighted row in place of its time; they keep the focus in the input. */
const rowButtonClass =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground'
</script>

<template>
  <div class="flex items-center gap-2.5 border-b px-3.5">
    <SearchIcon class="size-4 shrink-0 text-muted-foreground" />
    <ListboxFilter
      v-model="query"
      auto-focus
      placeholder="Tabs und Sessions durchsuchen…"
      aria-label="Tabs und Sessions durchsuchen"
      spellcheck="false"
      class="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
    />
    <Spinner v-if="searching" class="size-3.5 shrink-0 text-muted-foreground" />
    <span v-else class="shrink-0 text-xs text-muted-foreground">Strg+Umschalt+A</span>
  </div>

  <ListboxContent
    class="max-h-[min(32rem,calc(var(--reka-popover-content-available-height)-3rem))] overflow-y-auto p-1.5 outline-none"
  >
    <ListboxGroup v-if="tabRows.length">
      <ListboxGroupLabel :class="groupLabelClass">
        Geöffnete Tabs
        <span class="tabular-nums">· {{ tabRows.length }}</span>
      </ListboxGroupLabel>
      <ListboxItem
        v-for="row in tabRows"
        :key="row.key"
        :value="row.key"
        :class="rowClass"
        @select="openTab(row.terminal)"
      >
        <span class="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <KeyRoundIcon v-if="row.terminal.mode === 'login'" class="size-4" />
          <BrowserFavicon v-else-if="row.terminal.mode === 'browser'" :terminal-id="row.terminal.id" class="size-4" />
          <TriangleAlertIcon v-else-if="row.terminal.limit" class="size-4 text-warning" />
          <SquareTerminalIcon v-else :class="cn('size-4', row.terminal.status === 'exited' && 'opacity-50')" />
          <AccountDot
            v-if="row.terminal.mode !== 'browser'"
            :color="accounts.get(row.terminal.authAccountId)?.color"
            class="absolute -right-0.5 -bottom-0.5 ring-popover"
          />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="flex min-w-0 items-center gap-2">
            <span
              :class="
                cn(
                  'min-w-0 truncate text-sm font-medium',
                  row.terminal.status === 'exited' && 'text-muted-foreground line-through',
                )
              "
            >
              <HighlightText :text="row.terminal.title" :terms="terms" />
            </span>
            <span
              v-if="route.name === 'terminals' && row.terminal.id === terminals.activeId"
              class="shrink-0 rounded-sm bg-primary/10 px-1.5 text-[11px] leading-4 font-medium text-primary"
            >
              Aktiv
            </span>
          </span>
          <span v-if="row.hit" class="line-clamp-2 text-xs text-muted-foreground">
            <span class="font-medium text-foreground/80">{{ row.hit.role === 'user' ? 'Du' : 'Claude' }}:</span>{{ ' ' }}
            <HighlightText :text="row.hit.snippet" :terms="terms" />
          </span>
          <span v-else class="truncate text-xs text-muted-foreground">{{ tabDetails(row) }}</span>
        </span>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums group-data-highlighted/row:hidden">
          {{ formatRelative(row.session?.updatedAt ?? row.terminal.createdAt, now) }}
        </span>
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              aria-label="Tab schließen"
              :class="cn(rowButtonClass, 'hidden group-data-highlighted/row:flex')"
              @mousedown.prevent
              @click.stop="closeTerminal(row.terminal.id)"
            >
              <XIcon class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Tab schließen</TooltipContent>
        </Tooltip>
      </ListboxItem>
    </ListboxGroup>

    <ListboxGroup v-if="sessionRows.length">
      <ListboxGroupLabel :class="groupLabelClass">
        {{ terms.length ? 'Sessions' : 'Letzte Sessions' }}
        <span v-if="terms.length" class="tabular-nums">· {{ sessionMatches.length }}</span>
      </ListboxGroupLabel>
      <ListboxItem
        v-for="row in sessionRows"
        :key="row.key"
        :value="row.key"
        :class="rowClass"
        @select="resume(row.session)"
      >
        <span class="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <MessageSquareTextIcon class="size-4" />
          <AccountDot
            :color="accounts.get(row.session.accountId)?.color"
            class="absolute -right-0.5 -bottom-0.5 ring-popover"
          />
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-medium">
            <HighlightText :text="row.session.title" :terms="terms" />
          </span>
          <span v-if="row.hit" class="line-clamp-2 text-xs text-muted-foreground">
            <span class="font-medium text-foreground/80">{{ row.hit.role === 'user' ? 'Du' : 'Claude' }}:</span>{{ ' ' }}
            <HighlightText :text="row.hit.snippet" :terms="terms" />
          </span>
          <span v-else class="truncate text-xs text-muted-foreground">{{ sessionDetails(row.session) }}</span>
        </span>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums group-data-highlighted/row:hidden">
          {{ formatRelative(row.session.updatedAt, now) }}
        </span>
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              aria-label="Verlauf lesen"
              :class="cn(rowButtonClass, 'hidden group-data-highlighted/row:flex')"
              @mousedown.prevent
              @click.stop="showConversation(row.session)"
            >
              <HistoryIcon class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Verlauf lesen</TooltipContent>
        </Tooltip>
      </ListboxItem>
    </ListboxGroup>

    <p v-if="hiddenSessions > 0" class="px-2 py-2 text-xs text-muted-foreground">
      {{ hiddenSessions }} weitere Sessions passen – ein weiteres Wort grenzt die Suche ein.
    </p>
    <p v-if="nothingFound" class="px-3 py-8 text-center text-sm text-muted-foreground">
      Kein Tab und keine Session passt zu „{{ query.trim() }}“.
    </p>
    <p
      v-else-if="sessions.loaded && !terms.length && tabRows.length === 0 && sessionRows.length === 0"
      class="px-3 py-8 text-center text-sm text-muted-foreground"
    >
      Noch keine Tabs oder Sessions.
    </p>
  </ListboxContent>
</template>
