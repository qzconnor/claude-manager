<script setup lang="ts">
import {
  ArrowRightLeftIcon,
  BellIcon,
  BellOffIcon,
  CircleStopIcon,
  Columns2Icon,
  FolderOpenIcon,
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
import type { AttentionKind } from '@shared/types'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
import AccountDot from '@/components/common/AccountDot.vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
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
import { useTerminalsStore, type TerminalTab } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import TerminalTabCard from './TerminalTabCard.vue'

/**
 * A tab shows the terminal in it that has (or last had) the keyboard; its menu acts on that one.
 * `vertical`: a full-width row in the sidebar, with the hover card beside it.
 */
const props = defineProps<{ tab: TerminalTab; selected: boolean; vertical?: boolean }>()
const emit = defineEmits<{ select: [] }>()

const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const launcher = useLauncher()
const { closeTerminal, closeTab, stopTerminal, restartTerminal } = useTerminalActions()
const accountSwitch = useAccountSwitch()

const terminal = computed(() => props.tab.focused)
/** The tab holds several terminals: a symbol shows how the first split divides it. */
const split = computed(() => props.tab.panes.length > 1)
const splitIcon = computed(() =>
  typeof props.tab.layout === 'object' && props.tab.layout.direction === 'column' ? Rows2Icon : Columns2Icon,
)

/** The account whose limits the tab uses; the session may lie with another one after a switch. */
const account = computed(() => accounts.get(terminal.value.authAccountId))
const sessionAccount = computed(() =>
  terminal.value.accountId === terminal.value.authAccountId ? undefined : accounts.get(terminal.value.accountId),
)
const exited = computed(() => terminal.value.status === 'exited')
/** The colour of a terminal of the tab that is at work. */
const busyColor = computed(() => {
  const busy = props.tab.panes.find((p) => p.busy)
  return busy ? (accounts.get(busy.authAccountId)?.color ?? '') : null
})

// The terminal pane lays its own colour over the page's surface; the selected tab in the title bar
// stacks the same two layers, so it has exactly the colour of the terminal it joins.
const { containerBackground } = useTerminalAppearance()
const joinedBackground = computed(() =>
  !props.vertical && props.selected
    ? { background: `linear-gradient(${containerBackground.value}, ${containerBackground.value}), var(--surface)` }
    : undefined,
)
// Choices are built when the menu opens, so they reflect the current limits.
const menuOpen = ref(false)
const choices = computed(() =>
  menuOpen.value ? accountSwitch.choices(terminal.value.accountId, terminal.value.authAccountId) : [],
)
const canSwitch = computed(() => terminal.value.mode === 'session' && Boolean(terminal.value.sessionId))

/**
 * News the user hasn't seen, in any terminal of the tab: a dot where the close button is (until
 * hovered), orange when Claude waits.
 */
const ATTENTION_ORDER: AttentionKind[] = ['input', 'limit', 'done']
const attention = computed(() => {
  const kind = ATTENTION_ORDER.find((k) => props.tab.panes.some((p) => p.attention === k))
  return kind ? attentionLook[kind] : null
})

function toggleMuted() {
  void attempt(
    () => terminals.setMuted(terminal.value.id, !terminal.value.muted),
    'Benachrichtigungen des Tabs konnten nicht geändert werden',
  )
}

const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

// The hover card steps aside for the context menu, for renaming and while tabs are dragged.
// After a drag it waits until the pointer comes back, instead of opening on the dropped tab.
const ui = useUiStore()
const hovered = ref(false)
const cardOpen = computed(() => hovered.value && !menuOpen.value && !editing.value && !ui.draggingTab)
watch(
  () => ui.draggingTab,
  (id) => {
    if (id) hovered.value = false
  },
)

function onMenuOpen(open: boolean) {
  menuOpen.value = open
  if (open) hovered.value = false
}

function startRename() {
  draft.value = terminal.value.title
  editing.value = true
  hovered.value = false
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}

async function commitRename() {
  if (!editing.value) return
  editing.value = false
  const title = draft.value.trim()
  // Empty gives the tab back the session's title.
  if (title ? title !== terminal.value.title : terminal.value.fixedTitle) {
    await attempt(() => terminals.rename(terminal.value.id, title), 'Umbenennen fehlgeschlagen')
  }
}

function onRenameKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') void commitRename()
  else if (event.key === 'Escape') editing.value = false
}

function onMouseDown(event: MouseEvent) {
  // Middle click closes like in Windows Terminal and browsers.
  if (event.button === 1) {
    event.preventDefault()
    void closeTab(props.tab)
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
  <ContextMenu @update:open="onMenuOpen">
    <HoverCard :open="cardOpen" :open-delay="500" :close-delay="100" @update:open="hovered = $event">
      <ContextMenuTrigger as-child>
        <HoverCardTrigger as-child>
          <div
            role="tab"
            :data-terminal-id="tab.id"
            :aria-selected="selected"
            :class="
              cn(
                'app-no-drag group/tab relative flex cursor-pointer items-center gap-2 pr-1 pl-3 text-xs transition-colors',
                vertical
                  ? cn(
                      // While dragged (data-dragging, see useTabDrag) it looks lifted like the selected one.
                      'h-8 w-full shrink-0 rounded-lg data-dragging:bg-surface-strong data-dragging:text-foreground data-dragging:shadow-md data-dragging:ring-1 data-dragging:ring-foreground/10',
                      selected
                        ? 'bg-surface-strong text-foreground shadow-sm ring-1 ring-foreground/10'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )
                  : // In the title bar the selected tab has the terminal's colour and the page's border and
                    // stays open at the bottom, so it joins the terminal below. The others light up as a floating pill.
                    // Tabs narrow down to min-w-28 like in a browser before the strip starts to scroll.
                    cn(
                      'isolate max-w-56 min-w-28 rounded-t-lg border-x border-t',
                      selected
                        ? 'border-border text-foreground in-data-unfocused:text-muted-foreground'
                        : 'border-transparent text-muted-foreground before:absolute before:inset-x-0 before:inset-y-1 before:-z-10 before:rounded-lg before:transition-colors hover:text-foreground hover:before:bg-accent data-dragging:text-foreground data-dragging:before:bg-surface-strong data-dragging:before:shadow-md data-dragging:before:ring-1 data-dragging:before:ring-foreground/10',
                    ),
              )
            "
            :style="joinedBackground"
            @click="emit('select')"
            @dblclick="startRename"
            @mousedown="onMouseDown"
          >
            <!-- Same width for every symbol, so the title doesn't move when Claude Code starts or stops working. -->
            <span class="flex size-3.5 shrink-0 items-center justify-center">
              <KeyRoundIcon v-if="terminal.mode === 'login'" class="size-3.5" />
              <LoaderCircleIcon
                v-else-if="busyColor !== null"
                role="status"
                aria-label="Claude Code arbeitet"
                class="size-3.5 animate-spin"
                :style="{ color: busyColor || undefined }"
              />
              <SquareTerminalIcon v-else-if="terminal.mode === 'shell'" class="size-3.5" />
              <TriangleAlertIcon v-else-if="terminal.limit" class="size-3.5 text-warning" />
              <AccountDot v-else :color="account?.color" :class="cn(exited && 'opacity-40')" />
            </span>

            <input
              v-if="editing"
              ref="input"
              v-model="draft"
              aria-label="Tab-Titel"
              placeholder="Automatischer Titel"
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
                  exited && 'text-muted-foreground line-through',
                  attention && !exited && 'font-medium text-foreground',
                )
              "
            >
              {{ terminal.title }}
            </span>
            <component
              :is="splitIcon"
              v-if="split && !editing"
              role="img"
              :aria-label="`${tab.panes.length} Terminals`"
              class="size-3 shrink-0 text-muted-foreground"
            />
            <BellOffIcon
              v-if="terminal.muted && !editing"
              aria-label="Benachrichtigungen stummgeschaltet"
              class="size-3 shrink-0 text-muted-foreground"
            />

            <button
              type="button"
              aria-label="Tab schließen"
              :class="
                cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-accent hover:text-foreground',
                  (selected || attention) && 'opacity-100',
                )
              "
              @click.stop="closeTab(tab)"
              @dblclick.stop
            >
              <span
                v-if="attention"
                role="status"
                :aria-label="attention.label"
                :class="cn('size-2 rounded-full group-hover/tab:hidden', attention.dot)"
              />
              <XIcon :class="cn('size-3.5', attention && 'hidden group-hover/tab:block')" />
            </button>
          </div>
        </HoverCardTrigger>
      </ContextMenuTrigger>
      <HoverCardContent :side="vertical ? 'right' : 'bottom'" align="start" :side-offset="vertical ? 12 : 6" class="w-72">
        <TerminalTabCard
          :terminal="terminal"
          :account="account"
          :session-account="sessionAccount"
          @open-folder="openFolder"
        />
      </HoverCardContent>
    </HoverCard>
    <ContextMenuContent class="w-64">
      <ContextMenuGroup>
        <ContextMenuItem @select="startRename">
          <PencilIcon />
          Umbenennen
        </ContextMenuItem>
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
        <ContextMenuItem v-if="split" @select="terminals.detach(terminal.id)">
          <SquareArrowOutUpRightIcon />
          In eigenen Tab verschieben
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem v-if="split" @select="closeTerminal(terminal.id)">
          <XIcon />
          Terminal schließen
          <ContextMenuShortcut>Strg+Umschalt+W</ContextMenuShortcut>
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
</template>
