<script setup lang="ts">
import {
  ArrowRightLeftIcon,
  CircleStopIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PencilIcon,
  RotateCwIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import type { TerminalInfo } from '@shared/types'
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
import { useTerminalActions } from '@/composables/useTerminalActions'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { attempt } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useTerminalsStore } from '@/stores/terminals'
import TerminalTabCard from './TerminalTabCard.vue'

/** `vertical`: a full-width row in the sidebar, with the hover card beside it. */
const props = defineProps<{ terminal: TerminalInfo; selected: boolean; vertical?: boolean }>()
const emit = defineEmits<{ select: [] }>()

const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const { closeTerminal, stopTerminal, restartTerminal } = useTerminalActions()
const accountSwitch = useAccountSwitch()

/** The account whose limits the tab uses; the session may lie with another one after a switch. */
const account = computed(() => accounts.get(props.terminal.authAccountId))
const sessionAccount = computed(() =>
  props.terminal.accountId === props.terminal.authAccountId ? undefined : accounts.get(props.terminal.accountId),
)
const exited = computed(() => props.terminal.status === 'exited')

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
  menuOpen.value ? accountSwitch.choices(props.terminal.accountId, props.terminal.authAccountId) : [],
)
const canSwitch = computed(() => props.terminal.mode === 'session' && Boolean(props.terminal.sessionId))

const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

// The hover card steps aside for the context menu and for renaming.
const hovered = ref(false)
const cardOpen = computed(() => hovered.value && !menuOpen.value && !editing.value)

function onMenuOpen(open: boolean) {
  menuOpen.value = open
  if (open) hovered.value = false
}

function startRename() {
  draft.value = props.terminal.title
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
  if (title ? title !== props.terminal.title : props.terminal.fixedTitle) {
    await attempt(() => terminals.rename(props.terminal.id, title), 'Umbenennen fehlgeschlagen')
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
    void closeTerminal(props.terminal.id)
  }
}

async function closeOthers() {
  for (const other of terminals.terminals.filter((t) => t.id !== props.terminal.id)) {
    await closeTerminal(other.id)
  }
}

function openFolder() {
  void attempt(() => window.api.app.openPath(props.terminal.cwd), 'Ordner konnte nicht geöffnet werden')
}
</script>

<template>
  <ContextMenu @update:open="onMenuOpen">
    <HoverCard :open="cardOpen" :open-delay="500" :close-delay="100" @update:open="hovered = $event">
      <ContextMenuTrigger as-child>
        <HoverCardTrigger as-child>
          <div
            role="tab"
            :data-terminal-id="terminal.id"
            :aria-selected="selected"
            :class="
              cn(
                'app-no-drag group/tab relative flex shrink-0 cursor-pointer items-center gap-2 pr-1 pl-3 text-xs transition-colors',
                vertical
                  ? cn(
                      'h-8 w-full rounded-lg',
                      selected
                        ? 'bg-surface-strong text-foreground shadow-sm ring-1 ring-foreground/10'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )
                  : // In the title bar the selected tab has the terminal's colour and the page's border and
                    // stays open at the bottom, so it joins the terminal below. The others light up as a floating pill.
                    cn(
                      'isolate max-w-56 min-w-28 rounded-t-lg border-x border-t',
                      selected
                        ? 'border-border text-foreground in-data-unfocused:text-muted-foreground'
                        : 'border-transparent text-muted-foreground before:absolute before:inset-x-0 before:inset-y-1 before:-z-10 before:rounded-lg before:transition-colors hover:text-foreground hover:before:bg-accent',
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
                v-else-if="terminal.busy"
                role="status"
                aria-label="Claude Code arbeitet"
                class="size-3.5 animate-spin"
                :style="{ color: account?.color ?? undefined }"
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
            <span v-else :class="cn('min-w-0 flex-1 truncate', exited && 'text-muted-foreground line-through')">
              {{ terminal.title }}
            </span>

            <button
              type="button"
              aria-label="Tab schließen"
              :class="
                cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-accent hover:text-foreground',
                  selected && 'opacity-100',
                )
              "
              @click.stop="closeTerminal(terminal.id)"
              @dblclick.stop
            >
              <XIcon class="size-3.5" />
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
        <ContextMenuItem @select="closeTerminal(terminal.id)">
          <XIcon />
          Tab schließen
          <ContextMenuShortcut>Strg+Umschalt+W</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem :disabled="terminals.terminals.length < 2" @select="closeOthers">
          Andere Tabs schließen
        </ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  </ContextMenu>
</template>
