<script setup lang="ts">
import {
  ArrowRightLeftIcon,
  BellIcon,
  BellOffIcon,
  CircleStopIcon,
  Columns2Icon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GlobeIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PencilIcon,
  RotateCwIcon,
  Rows2Icon,
  SquareArrowOutUpRightIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { TerminalInfo } from '@shared/types'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
import AccountDot from '@/components/common/AccountDot.vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useLauncher } from '@/composables/useLauncher'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { attentionLook } from '@/lib/attention'
import { attempt } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useBrowsersStore } from '@/stores/browsers'
import { useTerminalsStore, type TerminalTab } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import BrowserFavicon from './BrowserFavicon.vue'
import TerminalTabCard from './TerminalTabCard.vue'

/**
 * A tab shows each of its terminals: one fills it, the terminals of a split tab sit side by side in
 * it (one below the other in the sidebar), each with its own close button. Hover card and menu act on
 * the terminal under the pointer, else on the one that has (or last had) the keyboard.
 * `vertical`: a full-width entry in the sidebar, with the hover card beside it.
 */
const props = defineProps<{ tab: TerminalTab; selected: boolean; vertical?: boolean }>()
/** A terminal of the tab was clicked. */
const emit = defineEmits<{ select: [id: string] }>()

const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const launcher = useLauncher()
const { closeTerminal, closeTab, stopTerminal, restartTerminal } = useTerminalActions()
const accountSwitch = useAccountSwitch()

const browsers = useBrowsersStore()
/** The tab's element, where its hover card is placed. */
const tabEl = ref<HTMLElement | null>(null)
const split = computed(() => props.tab.panes.length > 1)
/** The terminal under the pointer; kept while the menu is open, which acts on it. */
const pointed = ref<string | null>(null)
const terminal = computed(() => props.tab.panes.find((p) => p.id === pointed.value) ?? props.tab.focused)

/** The account whose limits the terminal uses; the session may lie with another one after a switch. */
const account = computed(() => accounts.get(terminal.value.authAccountId))
const sessionAccount = computed(() =>
  terminal.value.accountId === terminal.value.authAccountId ? undefined : accounts.get(terminal.value.accountId),
)
const exited = computed(() => terminal.value.status === 'exited')
const isBrowser = computed(() => terminal.value.mode === 'browser')
const closeLabel = (pane: TerminalInfo) => (!split.value ? 'Tab schließen' : pane.mode === 'browser' ? 'Browser schließen' : 'Terminal schließen')

function openPage() {
  const { url } = terminal.value
  if (url && /^https?:/i.test(url)) void attempt(() => window.api.app.openExternal(url), 'Seite konnte nicht geöffnet werden')
}

/**
 * The terminals with what their part of the tab shows. News the user hasn't seen is a dot where the
 * close button is (until hovered), orange when Claude waits. In a selected split tab the terminals
 * without the keyboard are dimmed.
 */
const entries = computed(() =>
  props.tab.panes.map((pane) => ({
    pane,
    color: accounts.get(pane.authAccountId)?.color,
    attention: pane.attention ? attentionLook[pane.attention] : null,
    dimmed: split.value && props.selected && pane.id !== props.tab.focused.id,
  })),
)

// The terminal pane lays its own colour over the page's surface; the selected tab in the title bar
// stacks the same two layers, so it has exactly the colour of the terminal it joins.
const { containerBackground } = useTerminalAppearance()
const joinedBackground = computed(() =>
  !props.vertical && props.selected
    ? { background: `linear-gradient(${containerBackground.value}, ${containerBackground.value}), var(--surface)` }
    : undefined,
)
/** A split tab in the title bar narrows down to this before the strip starts to scroll. */
const minWidth = computed(() =>
  !props.vertical && split.value ? { minWidth: `${props.tab.panes.length * 6}rem` } : undefined,
)
// Choices are built when the menu opens, so they reflect the current limits.
const menuOpen = ref(false)
const choices = computed(() =>
  menuOpen.value ? accountSwitch.choices(terminal.value.accountId, terminal.value.authAccountId) : [],
)
const canSwitch = computed(() => terminal.value.mode === 'session' && Boolean(terminal.value.sessionId))

function point(id: string | null) {
  if (!menuOpen.value) pointed.value = id
}

function toggleMuted() {
  const { id, muted } = terminal.value
  void attempt(() => terminals.setMuted(id, !muted), 'Benachrichtigungen des Tabs konnten nicht geändert werden')
}

/** Id of the terminal whose title is being edited. */
const renaming = ref<string | null>(null)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
const setInput = (el: unknown) => {
  input.value = el instanceof HTMLInputElement ? el : null
}

// The hover card steps aside for the context menu, for renaming and while tabs are dragged.
// After a drag it waits until the pointer comes back, instead of opening on the dropped tab:
// the dragged tab holds the pointer, so its open delay runs out during the drag, which is ignored.
const ui = useUiStore()
const hovered = ref(false)
const cardOpen = computed(() => hovered.value && !menuOpen.value && !renaming.value && !ui.draggingTab)
watch(
  () => ui.draggingTab,
  (id) => {
    if (id) hovered.value = false
  },
)

function onMenuOpen(open: boolean) {
  menuOpen.value = open
  if (open) hovered.value = false
  else pointed.value = null
}

// On the way into its open hover card the card stays with the terminal it shows (its buttons act on
// it); it lets go once the card closes.
function onPointerLeave() {
  if (!cardOpen.value) point(null)
}
watch(hovered, (open) => {
  if (!open) point(null)
})

function startRename(id = terminal.value.id) {
  const pane = props.tab.panes.find((p) => p.id === id)
  if (!pane) return
  draft.value = pane.title
  renaming.value = id
  hovered.value = false
  // The open menu holds on to the keyboard; the field gets it once the menu is closed.
  if (!menuOpen.value) void nextTick(focusRenameField)
}

function focusRenameField() {
  input.value?.focus()
  input.value?.select()
}

async function commitRename() {
  const id = renaming.value
  if (!id) return
  renaming.value = null
  const pane = props.tab.panes.find((p) => p.id === id)
  if (!pane) return
  const title = draft.value.trim()
  // Empty gives the terminal back the session's title.
  if (title ? title !== pane.title : pane.fixedTitle) {
    await attempt(() => terminals.rename(id, title), 'Umbenennen fehlgeschlagen')
  }
}

function onRenameKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') void commitRename()
  else if (event.key === 'Escape') renaming.value = null
}

/** Renaming from the menu: the closed menu gives the keyboard to the rename field instead of the page. */
function onMenuCloseAutoFocus(event: Event) {
  if (!renaming.value) return
  event.preventDefault()
  focusRenameField()
}

function onMouseDown(event: MouseEvent, id: string) {
  // Middle click closes like in Windows Terminal and browsers; in a split tab only that terminal.
  if (event.button === 1) {
    event.preventDefault()
    void closeTerminal(id)
  }
}

async function closeOthers() {
  for (const other of terminals.tabs.filter((t) => t.id !== props.tab.id)) {
    await closeTab(other)
  }
}

function openFolder() {
  void attempt(() => window.api.app.openPath(terminal.value.cwd), 'Ordner konnte nicht geöffnet werden')
}
</script>

<template>
  <!-- Each trigger hands its anchor to the nearest menu or card around it. The menu's anchor is where the
       tab was right-clicked; with the menu around the card it went to the card, which then showed up there,
       and the menu had none. So the menu sits inside the card, and the card is placed at the tab itself. -->
  <HoverCard :open="cardOpen" :open-delay="500" :close-delay="100" @update:open="hovered = $event && !ui.draggingTab">
    <ContextMenu @update:open="onMenuOpen">
      <ContextMenuTrigger as-child>
        <HoverCardTrigger as-child>
          <div
            ref="tabEl"
            role="tab"
            :data-terminal-id="tab.id"
            :aria-selected="selected"
            :class="
              cn(
                // Dragged onto the page (data-docking) it fades in its place, the page shows where it goes.
                'app-no-drag group/tab relative flex cursor-pointer text-xs transition-colors data-docking:opacity-50',
                vertical
                  ? cn(
                      // While dragged (data-dragging, see useTabDrag) it looks lifted like the selected one.
                      'w-full shrink-0 rounded-lg data-dragging:bg-surface-strong data-dragging:text-foreground data-dragging:shadow-md data-dragging:ring-1 data-dragging:ring-foreground/10',
                      split && 'flex-col',
                      selected
                        ? 'bg-surface-strong text-foreground shadow-sm ring-1 ring-foreground/10'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )
                  : // In the title bar the selected tab has the terminal's colour and the page's border and
                    // stays open at the bottom, so it joins the terminal below. The others light up as a floating pill.
                    // Tabs narrow down to min-w-28 like in a browser before the strip starts to scroll.
                    cn(
                      'isolate rounded-t-lg border-x border-t',
                      !split && 'max-w-56 min-w-28',
                      selected
                        ? 'border-border text-foreground in-data-unfocused:text-muted-foreground'
                        : 'border-transparent text-muted-foreground before:absolute before:inset-x-0 before:inset-y-1 before:-z-10 before:rounded-lg before:transition-colors hover:text-foreground hover:before:bg-accent data-dragging:text-foreground data-dragging:before:bg-surface-strong data-dragging:before:shadow-md data-dragging:before:ring-1 data-dragging:before:ring-foreground/10',
                    ),
              )
            "
            :style="[joinedBackground, minWidth]"
            @pointerleave="onPointerLeave"
          >
            <template v-for="({ pane, color, attention, dimmed }, index) in entries" :key="pane.id">
              <span
                v-if="index > 0"
                aria-hidden="true"
                :class="cn('shrink-0 bg-border', vertical ? 'mx-3 h-px' : 'h-4 w-px self-center')"
              />
              <div
                :data-pane-id="pane.id"
                :class="
                  cn(
                    'group/pane flex min-w-0 items-center gap-2 pr-1 pl-3',
                    // One below the other in the sidebar, each as high as a tab.
                    // Side by side in the title bar, each as wide as its title up to max-w-44.
                    vertical && split ? 'h-8 shrink-0' : cn(split ? 'max-w-44 flex-auto' : 'flex-1', vertical && 'h-8'),
                    dimmed && 'text-muted-foreground hover:text-foreground',
                  )
                "
                @click="emit('select', pane.id)"
                @dblclick="startRename(pane.id)"
                @mousedown="onMouseDown($event, pane.id)"
                @pointermove="point(pane.id)"
                @contextmenu="pointed = pane.id"
              >
                <!-- Same width for every symbol, so the title doesn't move when Claude Code starts or stops working. -->
                <span class="flex size-3.5 shrink-0 items-center justify-center">
                  <KeyRoundIcon v-if="pane.mode === 'login'" class="size-3.5" />
                  <template v-else-if="pane.mode === 'browser'">
                    <LoaderCircleIcon
                      v-if="browsers.get(pane.id)?.state.loading"
                      role="status"
                      aria-label="Seite lädt"
                      class="size-3.5 animate-spin"
                    />
                    <BrowserFavicon v-else :terminal-id="pane.id" class="size-3.5" />
                  </template>
                  <LoaderCircleIcon
                    v-else-if="pane.busy"
                    role="status"
                    aria-label="Claude Code arbeitet"
                    class="size-3.5 animate-spin"
                    :style="{ color: color || undefined }"
                  />
                  <SquareTerminalIcon v-else-if="pane.mode === 'shell'" class="size-3.5" />
                  <TriangleAlertIcon v-else-if="pane.limit" class="size-3.5 text-warning" />
                  <AccountDot v-else :color="color" :class="cn(pane.status === 'exited' && 'opacity-40')" />
                </span>

                <input
                  v-if="renaming === pane.id"
                  :ref="setInput"
                  v-model="draft"
                  aria-label="Tab-Titel"
                  :placeholder="pane.autoTitle"
                  class="min-w-0 flex-1 rounded-sm bg-transparent px-1 ring-1 ring-ring outline-none"
                  @blur="commitRename"
                  @keydown.stop="onRenameKeydown"
                  @click.stop
                  @dblclick.stop
                />
                <span
                  v-else
                  :class="
                    cn(
                      'min-w-0 flex-1 truncate',
                      pane.status === 'exited' && 'text-muted-foreground line-through',
                      attention && pane.status !== 'exited' && 'font-medium text-foreground',
                    )
                  "
                >
                  {{ pane.title }}
                </span>
                <BellOffIcon
                  v-if="pane.muted && renaming !== pane.id"
                  aria-label="Benachrichtigungen stummgeschaltet"
                  class="size-3 shrink-0 text-muted-foreground"
                />

                <button
                  type="button"
                  :aria-label="closeLabel(pane)"
                  :class="
                    cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/pane:opacity-100 hover:bg-accent hover:text-foreground',
                      (selected || attention) && 'opacity-100',
                    )
                  "
                  @click.stop="closeTerminal(pane.id)"
                  @dblclick.stop
                >
                  <span
                    v-if="attention"
                    role="status"
                    :aria-label="attention.label"
                    :class="cn('size-2 rounded-full group-hover/pane:hidden', attention.dot)"
                  />
                  <XIcon :class="cn('size-3.5', attention && 'hidden group-hover/pane:block')" />
                </button>
              </div>
            </template>
          </div>
        </HoverCardTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-64" @close-auto-focus="onMenuCloseAutoFocus">
        <!-- In a split tab: which of its terminals the menu acts on. -->
        <ContextMenuLabel v-if="split" class="truncate">{{ terminal.title }}</ContextMenuLabel>
        <ContextMenuGroup>
          <ContextMenuItem @select="startRename()">
            <PencilIcon />
            Umbenennen
          </ContextMenuItem>
          <template v-if="isBrowser">
            <ContextMenuItem @select="browsers.get(terminal.id)?.reload()">
              <RotateCwIcon />
              Neu laden
            </ContextMenuItem>
            <ContextMenuItem :disabled="!terminal.url?.startsWith('http')" @select="openPage">
              <ExternalLinkIcon />
              Im Standardbrowser öffnen
            </ContextMenuItem>
          </template>
          <template v-else>
            <ContextMenuItem @select="openFolder">
              <FolderOpenIcon />
              Ordner öffnen
            </ContextMenuItem>
            <ContextMenuItem @select="restartTerminal(terminal.id)">
              <RotateCwIcon />
              Neu starten
            </ContextMenuItem>
            <ContextMenuItem :disabled="exited" @select="stopTerminal(terminal.id)">
              <CircleStopIcon />
              Prozess beenden
            </ContextMenuItem>
            <ContextMenuItem @select="toggleMuted">
              <BellIcon v-if="terminal.muted" />
              <BellOffIcon v-else />
              {{ terminal.muted ? 'Benachrichtigungen einschalten' : 'Benachrichtigungen stummschalten' }}
            </ContextMenuItem>
          </template>
        </ContextMenuGroup>
        <template v-if="terminal.mode === 'session'">
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger :disabled="!canSwitch">
              <ArrowRightLeftIcon />
              Account wechseln
            </ContextMenuSubTrigger>
            <ContextMenuSubContent class="w-72">
              <AccountChoiceItems
                menu="context"
                :choices="choices"
                @select="accountSwitch.continueTerminal(terminal, $event)"
              />
            </ContextMenuSubContent>
          </ContextMenuSub>
        </template>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem @select="launcher.split(terminal, 'row')">
            <Columns2Icon />
            Vertikal teilen
            <ContextMenuShortcut>Alt+Umschalt+Plus</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem @select="launcher.split(terminal, 'column')">
            <Rows2Icon />
            Horizontal teilen
            <ContextMenuShortcut>Alt+Umschalt+Minus</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem @select="launcher.browser(null, { terminalId: terminal.id, direction: 'row' })">
            <GlobeIcon />
            Browser daneben öffnen
          </ContextMenuItem>
          <ContextMenuItem v-if="split" @select="terminals.detach(terminal.id)">
            <SquareArrowOutUpRightIcon />
            In eigenen Tab verschieben
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem v-if="split" @select="closeTerminal(terminal.id)">
            <XIcon />
            {{ isBrowser ? 'Browser schließen' : 'Terminal schließen' }}
            <!-- The shortcut closes the terminal with the keyboard, which needn't be the one right-clicked. -->
            <ContextMenuShortcut v-if="terminal.id === terminals.activeId">Strg+Umschalt+W</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem @select="closeTab(tab)">
            <XIcon v-if="!split" />
            Tab schließen
            <ContextMenuShortcut v-if="!split">Strg+Umschalt+W</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem :disabled="terminals.tabs.length < 2" @select="closeOthers">
            Andere Tabs schließen
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
    <HoverCardContent
      :reference="tabEl ?? undefined"
      :side="vertical ? 'right' : 'bottom'"
      align="start"
      :side-offset="vertical ? 12 : 6"
      class="w-72"
    >
      <TerminalTabCard
        :terminal="terminal"
        :account="account"
        :session-account="sessionAccount"
        @open-folder="openFolder"
        @rename="startRename()"
      />
    </HoverCardContent>
  </HoverCard>
</template>
