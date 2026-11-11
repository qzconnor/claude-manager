<script setup lang="ts">
import {
  ArrowRightLeftIcon,
  CheckIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  ListChecksIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { SessionSearchHit, SessionSummary } from '@shared/types'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
import AccountDot from '@/components/common/AccountDot.vue'
import HighlightText from '@/components/common/HighlightText.vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useLauncher } from '@/composables/useLauncher'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { attempt } from '@/lib/errors'
import { formatBytes, formatRelative } from '@/lib/format'
import { sessionFolder } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useUiStore } from '@/stores/ui'
import SessionMoveMenu from './SessionMoveMenu.vue'

const props = defineProps<{
  session: SessionSummary
  selected: boolean
  now: number
  /** Where a search matched in the conversation. */
  hit?: SessionSearchHit
  terms?: string[]
  /** The list is in selection mode: a click checks the session instead of showing it. */
  selecting?: boolean
  checked?: boolean
}>()
const emit = defineEmits<{
  select: []
  /** `range`: Shift was held, check everything since the last click. */
  toggle: [range: boolean]
}>()

const launcher = useLauncher()
const accounts = useAccountsStore()
const accountSwitch = useAccountSwitch()
/** A folder holds the sessions of all accounts: the dot before the title tells whose, as in the tabs. */
const account = computed(() => accounts.get(props.session.accountId))
const removal = useSessionRemoval()
const ui = useUiStore()
const menuOpen = ref(false)

/** In selection mode the checked sessions stand out, otherwise the one shown on the right. */
const highlighted = computed(() => (props.selecting ? props.checked : props.selected))

function onClick(event: MouseEvent) {
  if (props.selecting) emit('toggle', event.shiftKey)
  // Strg+Klick starts selecting, as in the Explorer.
  else if (event.ctrlKey) emit('toggle', false)
  else emit('select')
}

function onDoubleClick() {
  if (!props.selecting) void launcher.resume(props.session)
}

function openFolder() {
  const folder = sessionFolder(props.session)
  if (folder) void attempt(() => window.api.app.openPath(folder), 'Ordner konnte nicht geöffnet werden')
}

const worktreeTitle = computed(() => {
  const worktree = props.session.worktree
  if (!worktree) return ''
  return [`Worktree ${worktree.name}`, worktree.branch && `Branch ${worktree.branch}`, worktree.path].filter(Boolean).join('\n')
})

function rename() {
  ui.sessionRenameRequest = { sessionId: props.session.id, title: props.session.title, name: props.session.name }
}

async function copyId() {
  await navigator.clipboard.writeText(props.session.id)
  toast.success('Session-ID kopiert')
}
</script>

<template>
  <ContextMenu @update:open="menuOpen = $event">
    <ContextMenuTrigger as-child>
      <Item
        as="button"
        type="button"
        size="sm"
        :variant="highlighted ? 'muted' : 'default'"
        :aria-current="selected || undefined"
        :role="selecting ? 'checkbox' : undefined"
        :aria-checked="selecting ? checked : undefined"
        :class="
          cn(
            'px-2.5 py-2 text-left',
            !highlighted && 'hover:bg-muted/60',
            highlighted && 'ring-1 ring-foreground/10',
            selecting && 'flex-nowrap',
          )
        "
        @click="onClick"
        @dblclick="onDoubleClick"
      >
        <!-- Only a picture of a checkbox: a real one can't sit inside the button. -->
        <span
          v-if="selecting"
          aria-hidden="true"
          :class="
            cn(
              'flex size-4 shrink-0 items-center justify-center self-start rounded-[4px] border border-input transition-colors dark:bg-input/30',
              checked && 'border-primary bg-primary text-primary-foreground dark:bg-primary',
            )
          "
        >
          <CheckIcon v-if="checked" class="size-3.5" />
        </span>
        <ItemContent class="min-w-0 gap-0.5">
          <div class="flex min-w-0 items-baseline gap-2">
            <!-- ItemTitle is a flex container, so the ellipsis needs its own text box. -->
            <ItemTitle class="min-w-0 flex-1">
              <span v-tooltip="account?.name ?? session.accountId" class="flex shrink-0 items-center self-center">
                <AccountDot :color="account?.color" />
              </span>
              <span class="truncate"><HighlightText :text="session.title" :terms="terms ?? []" /></span>
            </ItemTitle>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
              {{ formatRelative(session.updatedAt, now) }}
            </span>
          </div>
          <!-- The folder is the node above in the list. -->
          <ItemDescription class="flex min-w-0 items-center gap-2 text-xs">
            <!-- A worktree has a branch of its own: the name says enough, the rest is in the tooltip. -->
            <span v-if="session.worktree" class="flex min-w-0 items-center gap-1" v-tooltip="worktreeTitle">
              <FolderGit2Icon class="size-3 shrink-0" />
              <span class="truncate">{{ session.worktree.name }}</span>
            </span>
            <span v-else-if="session.gitBranch" class="flex min-w-0 items-center gap-1">
              <GitBranchIcon class="size-3 shrink-0" />
              <span class="truncate">{{ session.gitBranch }}</span>
            </span>
            <span class="ml-auto shrink-0 tabular-nums">
              {{ session.messageCount }}{{ session.messageCountExact ? '' : '+' }} Nachr. · {{ formatBytes(session.sizeBytes) }}
            </span>
          </ItemDescription>
          <p v-if="hit" class="line-clamp-2 text-xs text-muted-foreground">
            <span class="font-medium text-foreground/80">{{ hit.role === 'user' ? 'Du' : 'Claude' }}:</span>{{ ' ' }}
            <HighlightText :text="hit.snippet" :terms="terms ?? []" />
            <span v-if="hit.matches > 1" class="tabular-nums"> · {{ hit.matches }} Treffer</span>
          </p>
        </ItemContent>
      </Item>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-64">
      <ContextMenuGroup>
        <ContextMenuItem @select="launcher.resume(session)">
          <PlayIcon />
          Fortsetzen
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ArrowRightLeftIcon />
            Mit anderem Account fortsetzen
          </ContextMenuSubTrigger>
          <ContextMenuSubContent class="w-72">
            <AccountChoiceItems
              v-if="menuOpen"
              menu="context"
              :choices="accountSwitch.choices(session.accountId, session.accountId)"
              @select="accountSwitch.continueSession(session, $event)"
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem @select="launcher.resume(session, true)">
          <GitForkIcon />
          Als neue Session abzweigen
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem @select="rename">
          <PencilIcon />
          Umbenennen…
        </ContextMenuItem>
        <ContextMenuItem :disabled="!sessionFolder(session)" @select="openFolder">
          <FolderOpenIcon />
          Projektordner öffnen
        </ContextMenuItem>
        <SessionMoveMenu v-if="menuOpen" :session="session" />
        <ContextMenuItem @select="copyId">
          <CopyIcon />
          Session-ID kopieren
        </ContextMenuItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        <ContextMenuItem v-if="!selecting || !checked" @select="emit('toggle', false)">
          <ListChecksIcon />
          Auswählen
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" @select="removal.remove([session])">
          <Trash2Icon />
          Löschen…
        </ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  </ContextMenu>
</template>
