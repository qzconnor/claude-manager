<script setup lang="ts">
import {
  ArrowRightLeftIcon,
  CheckIcon,
  CopyIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  ListChecksIcon,
  PlayIcon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { SessionSearchHit, SessionSummary } from '@shared/types'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
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
import { formatRelative, shortenPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'

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

const app = useAppStore()
const launcher = useLauncher()
const accountSwitch = useAccountSwitch()
const removal = useSessionRemoval()
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
  if (props.session.cwd) void attempt(() => window.api.app.openPath(props.session.cwd!), 'Ordner konnte nicht geöffnet werden')
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
            'text-left',
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
              <span class="truncate"><HighlightText :text="session.title" :terms="terms ?? []" /></span>
            </ItemTitle>
            <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
              {{ formatRelative(session.updatedAt, now) }}
            </span>
          </div>
          <ItemDescription class="flex min-w-0 items-center gap-2 text-xs">
            <span class="min-w-0 truncate font-mono">{{ shortenPath(session.cwd, app.info?.homeDir) }}</span>
            <span v-if="session.gitBranch" class="flex shrink-0 items-center gap-1">
              <GitBranchIcon class="size-3" />
              <span class="max-w-28 truncate">{{ session.gitBranch }}</span>
            </span>
            <span class="ml-auto shrink-0 tabular-nums">
              {{ session.messageCount }}{{ session.messageCountExact ? '' : '+' }} Nachr.
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
    <ContextMenuContent class="w-56">
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
        <ContextMenuItem :disabled="!session.cwd" @select="openFolder">
          <FolderOpenIcon />
          Projektordner öffnen
        </ContextMenuItem>
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
