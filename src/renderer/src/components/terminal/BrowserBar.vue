<script setup lang="ts">
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, PlusIcon, SparklesIcon, SquareTerminalIcon, XIcon } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, ref, watch } from 'vue'
import type { TerminalInfo } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLauncher } from '@/composables/useLauncher'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { cn } from '@/lib/utils'
import { BROWSER_TAB } from '@/lib/workspace'
import { useAccountsStore } from '@/stores/accounts'
import { useBrowsersStore } from '@/stores/browsers'
import { useTerminalsStore } from '@/stores/terminals'
import BrowserFavicon from './BrowserFavicon.vue'

/**
 * The bar at the top of the browser tab: whose pages it shows (it follows the session with the
 * keyboard; another session's can be looked at from its menu), the pages of that session like a
 * browser's tabs, and a new page.
 */
const terminals = useTerminalsStore()
const browsers = useBrowsersStore()
const accounts = useAccountsStore()
const launcher = useLauncher()
const { closeTerminal } = useTerminalActions()
const { containerBackground } = useTerminalAppearance()
const strip = ref<HTMLElement | null>(null)

const session = computed(() => terminals.browserSession)
const pages = computed(() => (session.value ? terminals.browsersOf(session.value.id) : []))
const shown = computed(() => terminals.browserPage?.id ?? null)

const colorOf = (terminal: TerminalInfo) => accounts.get(terminal.authAccountId)?.color
/** Claude acts in the page right now, or did a moment ago. */
const claudeIn = (page: string) => browsers.controls.get(page)?.active === true
const claudeBusyIn = (page: string) => browsers.controls.get(page)?.busy === true
/** Claude acts in a page of the session right now; only in its browser, not elsewhere in the session. */
const busyIn = (sessionId: string) => terminals.browsersOf(sessionId).some((page) => claudeBusyIn(page.id))

/** The open sessions (and shells), whose browsers there are to look at; in the order of the tabs. Logins have none. */
const sessions = computed(() => terminals.terminals.filter((t) => t.mode !== 'browser' && t.mode !== 'login'))
/** Claude works in the browser of another session: a dot on the session's menu says so. */
const busyElsewhere = computed(() =>
  terminals.terminals.some((t) => t.mode === 'browser' && terminals.isSessionPage(t.id) && !pages.value.includes(t) && claudeBusyIn(t.id)),
)

const pageLabel = (count: number) => (count === 0 ? 'keine Seiten' : count === 1 ? '1 Seite' : `${count} Seiten`)

/** A press on the bar's empty space gives the browser tab's group the keyboard. */
function onEmptyPress() {
  if (terminals.focusedTab !== BROWSER_TAB) terminals.activateTab(BROWSER_TAB)
}

function onPageMouseDown(event: MouseEvent, page: TerminalInfo) {
  // Middle click closes like in browsers.
  if (event.button !== 1) return
  event.preventDefault()
  void closeTerminal(page.id)
}

function newPage() {
  if (session.value) void launcher.newPage(session.value.id)
}

// A vertical mouse wheel scrolls the pages horizontally; the shown one stays in view.
useEventListener(
  strip,
  'wheel',
  (event: WheelEvent) => {
    if (!strip.value || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
    strip.value.scrollLeft += event.deltaY
    event.preventDefault()
  },
  { passive: false },
)
watch(
  shown,
  (id) => {
    if (!id) return
    void nextTick(() => strip.value?.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex min-w-0 items-center gap-1 border-b px-1.5" :style="{ background: containerBackground }" @pointerdown.self="onEmptyPress">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="relative flex h-[26px] max-w-48 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-xs text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <template v-if="session">
            <LoaderCircleIcon
              v-if="busyIn(session.id)"
              role="status"
              aria-label="Claude arbeitet in diesem Browser"
              class="size-3.5 shrink-0 animate-spin"
              :style="{ color: colorOf(session) || undefined }"
            />
            <SquareTerminalIcon v-else-if="session.mode === 'shell'" class="size-3.5 shrink-0" />
            <AccountDot v-else :color="colorOf(session)" />
            <span class="min-w-0 truncate">{{ session.title }}</span>
          </template>
          <span v-else class="truncate">Keine Session</span>
          <ChevronDownIcon class="size-3.5 shrink-0 opacity-70" />
          <span
            v-if="busyElsewhere"
            aria-label="Claude arbeitet im Browser einer anderen Session"
            class="absolute top-0.5 right-0.5 size-1.5 animate-pulse rounded-full bg-primary"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-72">
        <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">
          Der Browser zeigt die Seiten der Session, mit der du gerade arbeitest.
          {{ sessions.length > 0 ? 'Wähle eine andere, um in ihren Browser zu schauen.' : 'Gerade ist keine offen.' }}
        </DropdownMenuLabel>
        <!-- Without sessions only the text. -->
        <DropdownMenuSeparator v-if="sessions.length > 0" />
        <DropdownMenuItem v-for="item in sessions" :key="item.id" v-tooltip.right="`${item.title}\n${item.worktree?.path || item.cwd}`" @select="terminals.peekBrowser(item.id)">
          <!-- Claude acts in one of its pages: a spinner in the account's colour as on the tab, and the name shimmers as the step over the page does. -->
          <LoaderCircleIcon v-if="busyIn(item.id)" aria-hidden="true" class="animate-spin" :style="{ color: colorOf(item) || undefined }" />
          <SquareTerminalIcon v-else-if="item.mode === 'shell'" />
          <AccountDot v-else :color="colorOf(item)" />
          <span :class="cn('min-w-0 flex-1 truncate', busyIn(item.id) && 'text-shimmer')">
            {{ item.title }}<span v-if="busyIn(item.id)" class="sr-only">, Claude arbeitet in diesem Browser</span>
          </span>
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ pageLabel(terminals.browsersOf(item.id).length) }}</span>
          <CheckIcon :class="cn('shrink-0', item.id !== session?.id && 'invisible')" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <div class="h-4 w-px shrink-0 bg-border" />

    <div ref="strip" role="tablist" aria-label="Seiten" class="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
      <div
        v-for="page in pages"
        :key="page.id"
        role="tab"
        :data-page-id="page.id"
        :aria-selected="page.id === shown"
        v-tooltip="page.url && page.url !== 'about:blank' ? `${page.title}\n${page.url}` : page.title"
        :class="
          cn(
            'group/page flex h-[26px] max-w-56 min-w-24 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-[3px] pl-2 text-xs transition-colors',
            page.id === shown ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          )
        "
        @click="terminals.activate(page.id)"
        @mousedown="onPageMouseDown($event, page)"
      >
        <span class="flex size-3.5 shrink-0 items-center justify-center">
          <LoaderCircleIcon v-if="browsers.get(page.id)?.state.loading" role="status" aria-label="Seite lädt" class="size-3.5 animate-spin" />
          <BrowserFavicon v-else :terminal-id="page.id" class="size-3.5" />
        </span>
        <span class="min-w-0 flex-1 truncate">{{ page.title }}</span>
        <SparklesIcon v-if="claudeIn(page.id)" aria-label="Claude arbeitet hier" :class="cn('size-3 shrink-0 text-primary', claudeBusyIn(page.id) && 'animate-pulse')" />
        <button
          type="button"
          aria-label="Seite schließen"
          v-tooltip="'Seite schließen'"
          :class="
            cn(
              'flex size-[20px] shrink-0 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 transition-opacity group-hover/page:opacity-100 hover:bg-foreground/10 hover:text-foreground',
              page.id === shown && 'opacity-100',
            )
          "
          @click.stop="closeTerminal(page.id)"
        >
          <XIcon class="size-[12px]" />
        </button>
      </div>
    </div>

    <button
      v-if="session"
      type="button"
      aria-label="Neue Seite"
      v-tooltip="'Neue Seite'"
      class="flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      @click="newPage"
    >
      <PlusIcon class="size-[16px]" />
    </button>
    <div class="h-full min-w-2 flex-1" @pointerdown="onEmptyPress" />
  </div>
</template>
