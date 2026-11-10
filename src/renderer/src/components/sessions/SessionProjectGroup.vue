<script setup lang="ts">
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  LayersIcon,
  ListChecksIcon,
  MinusIcon,
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
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useLauncher } from '@/composables/useLauncher'
import type { SessionRef } from '@/composables/useSessionDetail'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { sessionKey } from '@/composables/useSessionSearch'
import { attempt } from '@/lib/errors'
import { formatBytes, formatRelative } from '@/lib/format'
import { splitFolder } from '@/lib/recent-folders'
import type { SessionProject } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'
import NewSessionButton from './NewSessionButton.vue'
import NewSessionMenuItem from './NewSessionMenuItem.vue'
import SessionListItem from './SessionListItem.vue'

const PAGE_SIZE = 50

/**
 * A folder in the session list (a project of a workspace, or a folder of its own): its sessions of all
 * accounts below it, opened and closed like a folder in a tree.
 */
const props = defineProps<{
  project: SessionProject
  open: boolean
  /** In no workspace: the menu offers to make it, or the folder it lies in, a workspace. */
  convertible?: boolean
  selected: SessionRef | null
  now: number
  hits?: Map<string, SessionSearchHit>
  terms?: string[]
  selecting?: boolean
  checked?: Set<string>
  /** Shown from elsewhere (e.g. the dashboard): stands out for a moment. */
  highlighted?: boolean
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
const ui = useUiStore()
const menuOpen = ref(false)
const limit = ref(PAGE_SIZE)
const visible = computed(() => props.project.sessions.slice(0, limit.value))

const checkState = computed(() => {
  const count = props.project.sessions.filter((s) => props.checked?.has(sessionKey(s.accountId, s.id))).length
  if (count === 0) return false
  return count === props.project.sessions.length ? true : 'indeterminate'
})

const empty = computed(() => props.project.sessions.length === 0)

const details = computed(() => {
  const { sessions, sizeBytes, updatedAt, path } = props.project
  if (!updatedAt) return [path, 'Noch keine Sessions'].filter(Boolean).join('\n')
  const count = sessions.length === 1 ? '1 Session' : `${sessions.length} Sessions`
  return [path, `${count} · ${formatBytes(sizeBytes)} · zuletzt ${formatRelative(updatedAt, props.now)}`]
    .filter(Boolean)
    .join('\n')
})

/** The folder the project lies in, to make it a workspace with its neighbours; null for a drive or the root. */
const parentFolder = computed(() => {
  if (!props.project.path) return null
  const { parent } = splitFolder(props.project.path)
  return parent ? { path: parent, name: splitFolder(parent).name } : null
})

function makeWorkspace(path: string) {
  ui.workspaceRequest = { mode: 'adopt', path }
}

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
          :data-project-id="project.id"
          :class="
            cn(
              'group/project flex h-8 scroll-mt-2 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-muted/60',
              (menuOpen || highlighted) && 'bg-muted/60',
            )
          "
        >
          <Checkbox
            v-if="selecting"
            :model-value="checkState"
            :disabled="empty"
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
            v-tooltip="details"
            :disabled="empty"
            class="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
          >
            <ChevronRightIcon
              :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && !empty && 'rotate-90', empty && 'opacity-0')"
            />
            <component :is="open && !empty ? FolderOpenIcon : FolderIcon" class="size-3.5 shrink-0 text-muted-foreground" />
            <span :class="cn('max-w-[70%] shrink-0 truncate font-medium', empty && 'font-normal text-muted-foreground')">
              <HighlightText :text="project.name" :terms="terms ?? []" />
            </span>
            <span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{{ project.parent }}</span>
          </CollapsibleTrigger>
          <span v-if="!empty" class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ project.sessions.length }}</span>
          <NewSessionButton
            v-if="project.path"
            :path="project.path"
            :name="project.name"
            class="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          />
          <span v-else class="size-6 shrink-0" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-56">
        <ContextMenuGroup>
          <NewSessionMenuItem :path="project.path" />
          <ContextMenuItem :disabled="!project.path" @select="launcher.newSessionInWorktree(null, project.path)">
            <FolderGit2Icon />
            Neue Session in Worktree…
          </ContextMenuItem>
          <ContextMenuItem :disabled="!project.path" @select="launcher.shell(launcher.defaultAccountId(), project.path)">
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
          <ContextMenuSub v-if="convertible && project.path">
            <ContextMenuSubTrigger>
              <LayersIcon />
              Zum Workspace machen
            </ContextMenuSubTrigger>
            <ContextMenuSubContent class="w-64">
              <ContextMenuItem @select="makeWorkspace(project.path)">
                <FolderIcon />
                <span class="truncate">{{ project.name }}</span>
              </ContextMenuItem>
              <ContextMenuItem v-if="parentFolder" @select="makeWorkspace(parentFolder.path)">
                <FolderIcon />
                <span class="min-w-0 truncate">{{ parentFolder.name }}</span>
                <span class="ml-auto shrink-0 text-xs text-muted-foreground">übergeordnet</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuGroup>
        <ContextMenuSeparator v-if="!empty" />
        <ContextMenuGroup v-if="!empty">
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
