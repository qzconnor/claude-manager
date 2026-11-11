<script setup lang="ts">
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CopyIcon,
  FoldersIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  InboxIcon,
  LayersIcon,
  ListXIcon,
  ScrollTextIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { SessionSearchHit, SessionSummary, Workspace } from '@shared/types'
import HighlightText from '@/components/common/HighlightText.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useLauncher } from '@/composables/useLauncher'
import type { SessionRef } from '@/composables/useSessionDetail'
import { useSessionPage } from '@/composables/useSessionPages'
import { sessionKey } from '@/composables/useSessionSearch'
import { attempt, toastError } from '@/lib/errors'
import { shortenPath } from '@/lib/format'
import { FOLDERS_SECTION_ID, PAGE_SIZE, type SessionProject, type SessionRoot } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useUiStore } from '@/stores/ui'
import { useWorkspacesStore } from '@/stores/workspaces'
import NewSessionButton from './NewSessionButton.vue'
import NewSessionMenuItem from './NewSessionMenuItem.vue'
import SessionListItem from './SessionListItem.vue'
import SessionProjectGroup from './SessionProjectGroup.vue'

/**
 * A section of the session list, sticky at the top while its rows scroll by: a workspace with its
 * projects and the sessions in its own folder, a start folder (kept apart from the projects), or the
 * folders in no workspace (`root` null).
 */
const props = defineProps<{
  root: SessionRoot | null
  /** For a workspace: whether its folder is there and has a prompt. */
  workspace?: Workspace | null
  /** The folders in no workspace: the title tells them from the workspaces above. */
  title?: string
  projects: SessionProject[]
  count: number
  open: boolean
  /** The folders shown open, by id. */
  openProjects: Set<string>
  selected: SessionRef | null
  now: number
  /** Matches of a search in the conversations, by `sessionKey`. */
  hits?: Map<string, SessionSearchHit>
  /** Words of the search, to highlight them. */
  terms?: string[]
  /** Selection mode: the checked sessions by `sessionKey`. */
  selecting?: boolean
  checked?: Set<string>
  /** A folder or section shown from elsewhere, by id: it stands out for a moment. */
  highlighted?: string | null
  /** A workspace among others: dragged by its header to another place, or moved up and down in its menu. */
  sortable?: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  /** A folder was opened or closed, also one in a project. */
  openProject: [project: SessionProject, open: boolean]
  select: [session: SessionSummary]
  toggle: [session: SessionSummary, range: boolean]
  check: [project: SessionProject, value: boolean]
  /** Up (-1) or down (1) among the workspaces. */
  move: [offset: -1 | 1]
}>()

const launcher = useLauncher()
const ui = useUiStore()
const app = useAppStore()
const workspaces = useWorkspacesStore()
const menuOpen = ref(false)
const {
  shown: ownSessions,
  hidden,
  showMore,
} = useSessionPage(
  () => props.root?.id ?? FOLDERS_SECTION_ID,
  () => props.root?.sessions ?? [],
)

const activeProjects = computed(() => props.projects.filter((p) => p.sessions.length > 0))
/**
 * Projects without sessions, which a workspace may have many of: put away below the others until
 * asked for, so the folders one works in stay together.
 */
const emptyProjects = computed(() => props.projects.filter((p) => p.sessions.length === 0))
const showEmpty = ref(false)
// A folder shown from elsewhere (a new workspace, the dashboard) comes into view even when it has no sessions.
watch(
  () => props.highlighted,
  (id) => {
    if (id && emptyProjects.value.some((p) => p.id === id)) showEmpty.value = true
  },
)

const kind = computed(() => props.root?.kind ?? 'folders')
const icon = computed(() => ({ workspace: LayersIcon, start: InboxIcon, folders: FoldersIcon })[kind.value])
const name = computed(() => (props.root?.kind === 'start' ? 'Standardordner' : (props.root?.name ?? props.title ?? 'Ordner')))
/** Where a workspace lies; for a start folder, which one it is. */
const subtitle = computed(() => {
  if (!props.root) return ''
  return props.root.kind === 'start' ? shortenPath(props.root.path, app.info?.homeDir) : props.root.parent
})
const missing = computed(() => props.workspace?.exists === false)
const details = computed(() => {
  if (!props.root) return 'Ordner in keinem Workspace'
  const lines = [props.root.path]
  if (props.root.kind === 'start') lines.push('Hier starten Sessions, wenn du keinen Ordner wählst.')
  if (missing.value) lines.push('Ordner nicht gefunden')
  else if (props.workspace?.hasPrompt) lines.push('Mit Prompt (cm_prompts.md)')
  if (props.sortable) lines.push('Zum Sortieren ziehen')
  return lines.join('\n')
})

function newProject() {
  if (props.root) ui.projectRequest = { workspace: props.root.path, name: props.root.name }
}

function editPrompt() {
  if (props.root) ui.workspaceRequest = { mode: 'edit', path: props.root.path }
}

function openFolder() {
  if (props.root) void attempt(() => window.api.app.openPath(props.root!.path), 'Ordner konnte nicht geöffnet werden')
}

async function copyPath() {
  if (!props.root) return
  await navigator.clipboard.writeText(props.root.path)
  toast.success('Pfad kopiert')
}

async function removeWorkspace() {
  if (!props.root) return
  try {
    await workspaces.remove(props.root.path)
    toast.success(`„${props.root.name}“ ist kein Workspace mehr`, {
      description: 'Der Ordner und seine cm_prompts.md bleiben, seine Sessions stehen wieder bei den Ordnern.',
    })
  } catch (error) {
    toastError(error, 'Workspace konnte nicht entfernt werden')
  }
}
</script>

<template>
  <Collapsible
    :open="open"
    :data-drag-id="sortable && root ? root.path : undefined"
    class="flex flex-col gap-0.5 transition-opacity data-dragging:opacity-40"
    @update:open="emit('update:open', $event)"
  >
    <ContextMenu @update:open="menuOpen = $event">
      <ContextMenuTrigger as-child :disabled="!root">
        <div
          data-drag-header
          :data-project-id="root?.id ?? 'folders'"
          :class="
            cn(
              'sticky top-0 z-10 mb-0.5 flex scroll-mt-2 items-center gap-1 rounded-lg bg-surface-strong p-1 backdrop-blur-md',
              (menuOpen || (root && highlighted === root.id)) && 'ring-1 ring-foreground/15',
            )
          "
        >
          <!-- A plain row like the folders below: a ghost button would keep a background while open. -->
          <CollapsibleTrigger
            v-tooltip="details"
            :data-drag-grip="sortable ? '' : undefined"
            class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRightIcon :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')" />
            <TriangleAlertIcon v-if="missing" class="size-3.5 shrink-0 text-warning" />
            <component :is="icon" v-else class="size-3.5 shrink-0 text-muted-foreground" />
            <span :class="cn('max-w-[60%] shrink-0 truncate', missing && 'text-muted-foreground line-through')">
              <HighlightText :text="name" :terms="terms ?? []" />
            </span>
            <span v-if="subtitle" class="min-w-0 truncate font-mono text-xs font-normal text-muted-foreground">{{ subtitle }}</span>
            <Badge variant="secondary" class="ml-auto tabular-nums">{{ count }}</Badge>
          </CollapsibleTrigger>
          <Button
            v-if="root?.kind === 'workspace' && workspace?.hasPrompt"
            v-tooltip="'Prompt bearbeiten'"
            variant="ghost"
            size="icon-sm"
            aria-label="Prompt bearbeiten"
            class="text-muted-foreground"
            @click="editPrompt"
          >
            <ScrollTextIcon />
          </Button>
          <!-- A workspace starts sessions in its projects; in its own folder only through the menu. -->
          <NewSessionButton v-if="root && !missing && root.kind !== 'workspace'" :path="root.path" :name="name" size="icon-sm" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent v-if="root" class="w-56">
        <ContextMenuGroup>
          <!-- A workspace gets sessions in its projects: a new one, and the session starts there. -->
          <ContextMenuItem v-if="root.kind === 'workspace'" :disabled="missing" @select="newProject">
            <FolderPlusIcon />
            Projekt hier anlegen…
          </ContextMenuItem>
          <NewSessionMenuItem v-else :path="missing ? null : root.path" />
          <ContextMenuItem :disabled="missing" @select="launcher.shell(launcher.defaultAccountId(), root.path)">
            <SquareTerminalIcon />
            Shell hier öffnen
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem v-if="root.kind === 'workspace'" :disabled="missing" @select="editPrompt">
            <ScrollTextIcon />
            Prompt bearbeiten…
          </ContextMenuItem>
          <ContextMenuItem :disabled="missing" @select="openFolder">
            <FolderOpenIcon />
            Ordner öffnen
          </ContextMenuItem>
          <ContextMenuItem @select="copyPath">
            <CopyIcon />
            Pfad kopieren
          </ContextMenuItem>
        </ContextMenuGroup>
        <template v-if="root.kind === 'workspace'">
          <ContextMenuSeparator />
          <template v-if="canMoveUp || canMoveDown">
            <ContextMenuItem :disabled="!canMoveUp" @select="emit('move', -1)">
              <ArrowUpIcon />
              Nach oben
            </ContextMenuItem>
            <ContextMenuItem :disabled="!canMoveDown" @select="emit('move', 1)">
              <ArrowDownIcon />
              Nach unten
            </ContextMenuItem>
            <ContextMenuSeparator />
          </template>
          <ContextMenuItem @select="removeWorkspace">
            <ListXIcon />
            Kein Workspace mehr
          </ContextMenuItem>
        </template>
      </ContextMenuContent>
    </ContextMenu>

    <CollapsibleContent class="flex flex-col gap-0.5 pl-1">
      <p v-if="root?.kind === 'workspace' && projects.length === 0 && root.sessions.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
        {{ missing ? 'Der Ordner ist nicht da.' : 'Noch keine Projekte. Jeder Unterordner wird eins.' }}
      </p>
      <SessionProjectGroup
        v-for="project in activeProjects"
        :key="project.id"
        :project="project"
        :open="openProjects.has(project.id)"
        :open-folders="openProjects"
        :convertible="kind !== 'workspace'"
        :selected="selected"
        :now="now"
        :hits="hits"
        :terms="terms"
        :selecting="selecting"
        :checked="checked"
        :highlighted="highlighted"
        @update:open="emit('openProject', project, $event)"
        @open-folder="(folder, open) => emit('openProject', folder, open)"
        @select="emit('select', $event)"
        @toggle="(session, range) => emit('toggle', session, range)"
        @check="emit('check', project, $event)"
        @check-folder="(folder, value) => emit('check', folder, value)"
      />
      <SessionListItem
        v-for="session in ownSessions"
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
        v-if="hidden > 0"
        variant="ghost"
        size="sm"
        class="self-start text-muted-foreground"
        @click="showMore"
      >
        Weitere {{ Math.min(PAGE_SIZE, hidden) }} von {{ hidden }} anzeigen
      </Button>
      <template v-if="emptyProjects.length">
        <!-- Like a folder of the tree: its chevron turns, the folders appear below it. -->
        <button
          type="button"
          :aria-expanded="showEmpty"
          class="flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          @click="showEmpty = !showEmpty"
        >
          <ChevronRightIcon :class="cn('size-3.5 shrink-0 transition-transform', showEmpty && 'rotate-90')" />
          <span class="tabular-nums">{{ emptyProjects.length }} Ordner ohne Sessions</span>
        </button>
        <div v-if="showEmpty" class="ml-[0.9rem] flex flex-col gap-0.5 border-l pl-1.5">
          <SessionProjectGroup
            v-for="project in emptyProjects"
            :key="project.id"
            :project="project"
            :open="false"
            :convertible="kind !== 'workspace'"
            :selected="selected"
            :now="now"
            :selecting="selecting"
            :highlighted="highlighted"
          />
        </div>
      </template>
    </CollapsibleContent>
  </Collapsible>
</template>
