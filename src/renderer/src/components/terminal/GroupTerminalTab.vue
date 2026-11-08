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
  PanelBottomIcon,
  PanelRightIcon,
  PencilIcon,
  RotateCwIcon,
  Rows2Icon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
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
import { useLauncher } from '@/composables/useLauncher'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { attentionLook } from '@/lib/attention'
import { attempt } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useBrowsersStore } from '@/stores/browsers'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import BrowserFavicon from './BrowserFavicon.vue'
import TerminalTabCard from './TerminalTabCard.vue'

/**
 * A terminal's tab in the tab bar of its group. `selected`: the group shows it, `focused`: it also
 * has the keyboard. The selected tab has the terminal's colour and joins the terminal below.
 */
const props = defineProps<{ terminal: TerminalInfo; groupId: string; selected: boolean; focused: boolean; joined: Record<string, string> }>()
const emit = defineEmits<{ select: [id: string] }>()

const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const browsers = useBrowsersStore()
const launcher = useLauncher()
const ui = useUiStore()
const { closeTerminal, closeTabs, stopTerminal, restartTerminal } = useTerminalActions()
const accountSwitch = useAccountSwitch()

const tabEl = ref<HTMLElement | null>(null)
const account = computed(() => accounts.get(props.terminal.authAccountId))
const sessionAccount = computed(() =>
  props.terminal.accountId === props.terminal.authAccountId ? undefined : accounts.get(props.terminal.accountId),
)
const color = computed(() => account.value?.color)
const attention = computed(() => (props.terminal.attention ? attentionLook[props.terminal.attention] : null))
const exited = computed(() => props.terminal.status === 'exited')
const isBrowser = computed(() => props.terminal.mode === 'browser')
/** A browser names its session: the two usually lie in different groups. */
const session = computed(() => (isBrowser.value ? terminals.sessionOf(props.terminal.id) : null))
const group = computed(() => terminals.groups.find((g) => g.id === props.groupId))
/** The mouse is over the tab that goes with this one (its session, or one of its browsers): it looks hovered too. */
const linkedHover = computed(
  () => !!ui.hoveredTab && ui.hoveredTab !== props.terminal.id && terminals.linked(ui.hoveredTab).includes(props.terminal.id),
)
function onPointerLeave() {
  if (ui.hoveredTab === props.terminal.id) ui.hoveredTab = null
}
onBeforeUnmount(onPointerLeave)
const others = computed(() => group.value?.tabs.filter((t) => t.id !== props.terminal.id) ?? [])

function openPage() {
  const { url } = props.terminal
  if (url && /^https?:/i.test(url)) void attempt(() => window.api.app.openExternal(url), 'Seite konnte nicht geöffnet werden')
}

const menuOpen = ref(false)
const choices = computed(() =>
  menuOpen.value ? accountSwitch.choices(props.terminal.accountId, props.terminal.authAccountId) : [],
)
const canSwitch = computed(() => props.terminal.mode === 'session' && Boolean(props.terminal.sessionId))

function toggleMuted() {
  const { id, muted } = props.terminal
  void attempt(() => terminals.setMuted(id, !muted), 'Benachrichtigungen des Tabs konnten nicht geändert werden')
}

const renaming = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

// The hover card steps aside for the context menu, for renaming and while tabs are dragged.
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
}

function startRename() {
  draft.value = props.terminal.title
  renaming.value = true
  hovered.value = false
  // The open menu holds on to the keyboard; the field gets it once the menu is closed.
  if (!menuOpen.value) void nextTick(focusRenameField)
}

function focusRenameField() {
  input.value?.focus()
  input.value?.select()
}

async function commitRename() {
  if (!renaming.value) return
  renaming.value = false
  const title = draft.value.trim()
  // Empty gives the terminal back the session's title.
  if (title ? title !== props.terminal.title : props.terminal.fixedTitle) {
    await attempt(() => terminals.rename(props.terminal.id, title), 'Umbenennen fehlgeschlagen')
  }
}

function onRenameKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') void commitRename()
  else if (event.key === 'Escape') renaming.value = false
}

function onMenuCloseAutoFocus(event: Event) {
  if (!renaming.value) return
  event.preventDefault()
  focusRenameField()
}

function onMouseDown(event: MouseEvent) {
  // Middle click closes like in browsers and editors.
  if (event.button === 1) {
    event.preventDefault()
    void closeTerminal(props.terminal.id)
  }
}

function openFolder() {
  // A session in a worktree works in the worktree's folder.
  const path = props.terminal.worktree?.path ?? props.terminal.cwd
  void attempt(() => window.api.app.openPath(path), 'Ordner konnte nicht geöffnet werden')
}
</script>

<template>
  <HoverCard :open="cardOpen" :open-delay="500" :close-delay="100" @update:open="hovered = $event && !ui.draggingTab">
    <ContextMenu @update:open="onMenuOpen">
      <ContextMenuTrigger as-child>
        <HoverCardTrigger as-child>
          <div
            ref="tabEl"
            role="tab"
            :data-terminal-id="terminal.id"
            :data-linked-hover="linkedHover || undefined"
            :aria-selected="selected"
            :class="
              cn(
                'app-no-drag group/tab relative flex h-full min-w-28 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border pr-1 pl-3 text-xs transition-colors data-docking:opacity-50',
                // Room for the session's name too.
                session ? 'max-w-72' : 'max-w-56',
                selected
                  ? cn('border-border border-b-transparent', focused ? 'text-foreground' : 'text-muted-foreground')
                  : 'border-transparent border-b-border text-muted-foreground hover:bg-accent/60 hover:text-foreground data-dragging:bg-surface-strong data-dragging:text-foreground data-dragging:shadow-md data-linked-hover:bg-accent/60 data-linked-hover:text-foreground',
              )
            "
            :style="selected ? joined : undefined"
            @click="emit('select', terminal.id)"
            @dblclick="startRename"
            @mousedown="onMouseDown"
            @pointerenter="ui.hoveredTab = terminal.id"
            @pointerleave="onPointerLeave"
          >
            <span class="flex size-3.5 shrink-0 items-center justify-center">
              <KeyRoundIcon v-if="terminal.mode === 'login'" class="size-3.5" />
              <template v-else-if="isBrowser">
                <LoaderCircleIcon
                  v-if="browsers.get(terminal.id)?.state.loading"
                  role="status"
                  aria-label="Seite lädt"
                  class="size-3.5 animate-spin"
                />
                <BrowserFavicon v-else :terminal-id="terminal.id" class="size-3.5" />
              </template>
              <LoaderCircleIcon
                v-else-if="terminal.busy"
                role="status"
                aria-label="Claude Code arbeitet"
                class="size-3.5 animate-spin"
                :style="{ color: color || undefined }"
              />
              <SquareTerminalIcon v-else-if="terminal.mode === 'shell'" class="size-3.5" />
              <TriangleAlertIcon v-else-if="terminal.limit" class="size-3.5 text-warning" />
              <AccountDot v-else :color="color" :class="cn(exited && 'opacity-40')" />
            </span>

            <input
              v-if="renaming"
              ref="input"
              v-model="draft"
              aria-label="Tab-Titel"
              :placeholder="terminal.autoTitle"
              class="min-w-0 flex-1 rounded-sm bg-transparent px-1 ring-1 ring-ring outline-none"
              @blur="commitRename"
              @keydown.stop="onRenameKeydown"
              @click.stop
              @dblclick.stop
            />
            <span v-else class="flex min-w-0 flex-1 items-baseline gap-1">
              <span
                :class="
                  cn(
                    'min-w-0 truncate',
                    exited && 'text-muted-foreground line-through',
                    attention && !exited && 'font-medium text-foreground',
                  )
                "
              >
                {{ terminal.title }}
              </span>
              <!-- Too long for the tab, both give way, the longer one more; the card shows them in full. -->
              <span v-if="session" class="min-w-0 truncate text-muted-foreground">· {{ session.title }}</span>
            </span>
            <BellOffIcon
              v-if="terminal.muted && !renaming"
              aria-label="Benachrichtigungen stummgeschaltet"
              class="size-3 shrink-0 text-muted-foreground"
            />

            <button
              type="button"
              :aria-label="isBrowser ? 'Browser schließen' : 'Tab schließen'"
              :class="
                cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/tab:opacity-100 group-data-linked-hover/tab:opacity-100 hover:bg-accent hover:text-foreground',
                  (selected || attention) && 'opacity-100',
                )
              "
              @click.stop="closeTerminal(terminal.id)"
              @dblclick.stop
            >
              <span
                v-if="attention"
                role="status"
                :aria-label="attention.label"
                :class="cn('size-2 rounded-full group-hover/tab:hidden group-data-linked-hover/tab:hidden', attention.dot)"
              />
              <XIcon :class="cn('size-3.5', attention && 'hidden group-hover/tab:block group-data-linked-hover/tab:block')" />
            </button>
          </div>
        </HoverCardTrigger>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-64" @close-auto-focus="onMenuCloseAutoFocus">
        <ContextMenuGroup>
          <ContextMenuItem @select="startRename">
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
              <AccountChoiceItems menu="context" :choices="choices" @select="accountSwitch.continueTerminal(terminal, $event)" />
            </ContextMenuSubContent>
          </ContextMenuSub>
        </template>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem @select="launcher.split(terminal, 'row')">
            <Columns2Icon />
            Neue Session rechts
            <ContextMenuShortcut>Alt+Umschalt+Plus</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem @select="launcher.split(terminal, 'column')">
            <Rows2Icon />
            Neue Session unten
            <ContextMenuShortcut>Alt+Umschalt+Minus</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem :disabled="!terminals.sessionFor(terminal)" @select="launcher.browserFor(terminal)">
            <GlobeIcon />
            Browser daneben öffnen
          </ContextMenuItem>
          <ContextMenuItem :disabled="others.length === 0" @select="terminals.dropTab(terminal.id, groupId, 'right')">
            <PanelRightIcon />
            In Gruppe rechts verschieben
          </ContextMenuItem>
          <ContextMenuItem :disabled="others.length === 0" @select="terminals.dropTab(terminal.id, groupId, 'down')">
            <PanelBottomIcon />
            In Gruppe unten verschieben
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem @select="closeTerminal(terminal.id)">
            <XIcon />
            Schließen
            <ContextMenuShortcut v-if="focused">Strg+Umschalt+W</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem :disabled="others.length === 0" @select="closeTabs(others.map((t) => t.id))">
            Andere Tabs der Gruppe schließen
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
    <HoverCardContent :reference="tabEl ?? undefined" side="bottom" align="start" :side-offset="6" class="w-72">
      <TerminalTabCard
        :terminal="terminal"
        :account="account"
        :session-account="sessionAccount"
        :session="session ?? undefined"
        @open-folder="openFolder"
        @rename="startRename"
      />
    </HoverCardContent>
  </HoverCard>
</template>
