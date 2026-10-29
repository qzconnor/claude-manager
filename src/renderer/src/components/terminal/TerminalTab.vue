<script setup lang="ts">
import {
  ArrowRightLeftIcon,
  CircleStopIcon,
  FolderOpenIcon,
  KeyRoundIcon,
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
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { attempt } from '@/lib/errors'
import { limitLabel } from '@/lib/usage'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useTerminalsStore } from '@/stores/terminals'

const props = defineProps<{ terminal: TerminalInfo; selected: boolean }>()
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
const tooltip = computed(() =>
  [
    props.terminal.title,
    account.value?.name,
    sessionAccount.value && `Session gespeichert bei „${sessionAccount.value.name}“`,
    props.terminal.limit && `${limitLabel(props.terminal.limit.type)} erreicht`,
    props.terminal.cwd,
  ]
    .filter(Boolean)
    .join('\n'),
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

function startRename() {
  draft.value = props.terminal.title
  editing.value = true
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}

async function commitRename() {
  if (!editing.value) return
  editing.value = false
  const title = draft.value.trim()
  if (title && title !== props.terminal.title) {
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
  <ContextMenu @update:open="menuOpen = $event">
    <ContextMenuTrigger as-child>
      <div
        role="tab"
        :data-terminal-id="terminal.id"
        :aria-selected="selected"
        :title="tooltip"
        :class="
          cn(
            'app-no-drag group/tab relative flex h-8 max-w-56 min-w-28 shrink-0 cursor-pointer items-center gap-2 rounded-lg pr-1 pl-3 text-xs transition-colors',
            selected
              ? 'bg-surface-strong text-foreground shadow-sm ring-1 ring-foreground/10'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )
        "
        @click="emit('select')"
        @dblclick="startRename"
        @mousedown="onMouseDown"
      >
        <KeyRoundIcon v-if="terminal.mode === 'login'" class="size-3.5 shrink-0" />
        <SquareTerminalIcon v-else-if="terminal.mode === 'shell'" class="size-3.5 shrink-0" />
        <TriangleAlertIcon v-else-if="terminal.limit" class="size-3.5 shrink-0 text-warning" />
        <AccountDot v-else :color="account?.color" :class="cn(exited && 'opacity-40')" />

        <input
          v-if="editing"
          ref="input"
          v-model="draft"
          aria-label="Tab-Titel"
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
    </ContextMenuTrigger>
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
