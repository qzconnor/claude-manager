<script setup lang="ts">
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  ListChecksIcon,
  MinusIcon,
  PlusIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { SessionSearchHit, SessionSummary } from '@shared/types'
import HighlightText from '@/components/common/HighlightText.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLauncher } from '@/composables/useLauncher'
import type { SessionRef } from '@/composables/useSessionDetail'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { sessionKey } from '@/composables/useSessionSearch'
import { attempt } from '@/lib/errors'
import { formatBytes, formatRelative } from '@/lib/format'
import type { SessionProject } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import SessionListItem from './SessionListItem.vue'

const PAGE_SIZE = 50

/** A folder in the session list: its sessions below it, opened and closed like a folder in a tree. */
const props = defineProps<{
  project: SessionProject
  open: boolean
  selected: SessionRef | null
  now: number
  hits?: Map<string, SessionSearchHit>
  terms?: string[]
  selecting?: boolean
  checked?: Set<string>
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  select: [session: SessionSummary]
  toggle: [session: SessionSummary, range: boolean]
  /** Check or uncheck all sessions of the folder. */
  check: [value: boolean]
}>()

const launcher = useLauncher()
const removal = useSessionRemoval()
const menuOpen = ref(false)
const limit = ref(PAGE_SIZE)
const visible = computed(() => props.project.sessions.slice(0, limit.value))

const checkState = computed(() => {
  const count = props.project.sessions.filter((s) => props.checked?.has(sessionKey(s.accountId, s.id))).length
  if (count === 0) return false
  return count === props.project.sessions.length ? true : 'indeterminate'
})

const details = computed(() => {
  const { sessions, sizeBytes, updatedAt, path } = props.project
  const count = sessions.length === 1 ? '1 Session' : `${sessions.length} Sessions`
  return [path, `${count} · ${formatBytes(sizeBytes)} · zuletzt ${formatRelative(updatedAt, props.now)}`]
    .filter(Boolean)
    .join('\n')
})

function openFolder() {
  if (props.project.path) void attempt(() => window.api.app.openPath(props.project.path!), 'Ordner konnte nicht geöffnet werden')
}

async function copyPath() {
  if (!props.project.path) return
  await navigator.clipboard.writeText(props.project.path)
  toast.success('Pfad kopiert')
}
</script>

<template>
  <Collapsible :open="open" class="flex flex-col" @update:open="emit('update:open', $event)">
    <ContextMenu @update:open="menuOpen = $event">
      <ContextMenuTrigger as-child>
        <div
          :class="
            cn(
              'group/project flex h-8 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-muted/60',
              menuOpen && 'bg-muted/60',
            )
          "
        >
          <Checkbox
            v-if="selecting"
            :model-value="checkState"
            :disabled="project.sessions.length === 0"
            :aria-label="`Alle Sessions in ${project.name} auswählen`"
            class="ml-2 data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground"
            @update:model-value="emit('check', $event === true)"
          >
            <template #default="{ state }">
              <MinusIcon v-if="state === 'indeterminate'" />
              <CheckIcon v-else />
            </template>
          </Checkbox>
          <CollapsibleTrigger
            :title="details"
            class="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRightIcon :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')" />
            <component :is="open ? FolderOpenIcon : FolderIcon" class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="max-w-[70%] shrink-0 truncate font-medium">
              <HighlightText :text="project.name" :terms="terms ?? []" />
            </span>
            <span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{{ project.parent }}</span>
          </CollapsibleTrigger>
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ project.sessions.length }}</span>
          <Tooltip v-if="project.path">
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Neue Session in diesem Ordner"
                class="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100"
                @click="launcher.newSession(project.accountId, project.path)"
              >
                <PlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Neue Session in {{ project.name }}</TooltipContent>
          </Tooltip>
          <span v-else class="size-6 shrink-0" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-56">
        <ContextMenuGroup>
          <ContextMenuItem :disabled="!project.path" @select="launcher.newSession(project.accountId, project.path)">
            <PlusIcon />
            Neue Session hier
          </ContextMenuItem>
          <ContextMenuItem :disabled="!project.path" @select="launcher.shell(project.accountId, project.path)">
            <SquareTerminalIcon />
            Shell hier öffnen
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem :disabled="!project.path" @select="openFolder">
            <FolderOpenIcon />
            Ordner öffnen
          </ContextMenuItem>
          <ContextMenuItem :disabled="!project.path" @select="copyPath">
            <CopyIcon />
            Pfad kopieren
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem v-if="checkState !== true" @select="emit('check', true)">
            <ListChecksIcon />
            Alle Sessions auswählen
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @select="removal.remove(project.sessions)">
            <Trash2Icon />
            Alle Sessions löschen…
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
    <!-- The line of the tree runs below the chevron. -->
    <CollapsibleContent
      :class="cn('flex flex-col gap-0.5 border-l py-0.5 pl-1.5', selecting ? 'ml-[2.65rem]' : 'ml-[0.9rem]')"
    >
      <SessionListItem
        v-for="session in visible"
        :key="session.id"
        :session="session"
        :now="now"
        :selected="selected?.accountId === session.accountId && selected.sessionId === session.id"
        :hit="hits?.get(sessionKey(session.accountId, session.id))"
        :terms="terms"
        :selecting="selecting"
        :checked="checked?.has(sessionKey(session.accountId, session.id))"
        @select="emit('select', session)"
        @toggle="emit('toggle', session, $event)"
      />
      <Button
        v-if="project.sessions.length > limit"
        variant="ghost"
        size="sm"
        class="self-start text-muted-foreground"
        @click="limit += PAGE_SIZE"
      >
        Weitere {{ Math.min(PAGE_SIZE, project.sessions.length - limit) }} von {{ project.sessions.length - limit }} anzeigen
      </Button>
    </CollapsibleContent>
  </Collapsible>
</template>
