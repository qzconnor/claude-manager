<script setup lang="ts">
import { ArrowRightLeftIcon, CopyIcon, FolderOpenIcon, GitBranchIcon, GitForkIcon, PlayIcon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { SessionSummary } from '@shared/types'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
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
import { attempt } from '@/lib/errors'
import { formatRelative, shortenPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'

const props = defineProps<{ session: SessionSummary; selected: boolean; now: number }>()
const emit = defineEmits<{ select: [] }>()

const app = useAppStore()
const launcher = useLauncher()
const accountSwitch = useAccountSwitch()
const menuOpen = ref(false)

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
        :variant="selected ? 'muted' : 'default'"
        :aria-current="selected || undefined"
        :class="cn('text-left', !selected && 'hover:bg-muted/60', selected && 'ring-1 ring-foreground/10')"
        @click="emit('select')"
        @dblclick="launcher.resume(session)"
      >
        <ItemContent class="min-w-0 gap-0.5">
          <div class="flex min-w-0 items-baseline gap-2">
            <!-- ItemTitle is a flex container, so the ellipsis needs its own text box. -->
            <ItemTitle class="min-w-0 flex-1">
              <span class="truncate">{{ session.title }}</span>
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
    </ContextMenuContent>
  </ContextMenu>
</template>
