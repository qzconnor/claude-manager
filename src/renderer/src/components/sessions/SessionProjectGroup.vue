<script setup lang="ts">
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  FolderXIcon,
  LayersIcon,
  ListChecksIcon,
  MinusIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { folderKey, inFolder } from '@shared/folders'
import type { SessionSearchHit, SessionSummary } from '@shared/types'
import { workspaceOf } from '@shared/workspaces'
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
import { useFolderMove } from '@/composables/useFolderMove'
import { useLauncher } from '@/composables/useLauncher'
import type { SessionRef } from '@/composables/useSessionDetail'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { useSessionPage } from '@/composables/useSessionPages'
import { sessionKey } from '@/composables/useSessionSearch'
import { attempt } from '@/lib/errors'
import { formatBytes, formatRelative } from '@/lib/format'
import { splitFolder } from '@/lib/recent-folders'
import { PAGE_SIZE, type SessionProject } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui'
import { useWorkspacesStore } from '@/stores/workspaces'
import NewSessionButton from './NewSessionButton.vue'
import NewSessionMenuItem from './NewSessionMenuItem.vue'
import SessionListItem from './SessionListItem.vue'

/**
 * A folder in the session list (a project of a workspace, a folder in one, or a folder of its own): the
 * folders in it that sessions ran in and its own sessions of all accounts below it, opened and closed
 * like a folder in a tree.
 */
const props = defineProps<{
  project: SessionProject
  open: boolean
  /** The folders in it shown open, by id. */
  openFolders?: Set<string>
  /**
   * In no workspace: the menu offers to make it, or the folder it lies in, a workspace. A project of a
   * workspace can become one itself, then the list shows it by itself.
   */
  convertible?: boolean
  selected: SessionRef | null
  now: number
  hits?: Map<string, SessionSearchHit>
  terms?: string[]
  selecting?: boolean
  checked?: Set<string>
  /** The folder shown from elsewhere (e.g. the dashboard), by id: it stands out for a moment. */
  highlighted?: string | null
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  select: [session: SessionSummary]
  toggle: [session: SessionSummary, range: boolean]
  /** Check or uncheck all sessions of the folder, also those in the folders in it. */
  check: [value: boolean]
  /** A folder in it was opened or closed. */
  openFolder: [folder: SessionProject, open: boolean]
  /** All sessions of a folder in it were checked or unchecked. */
  checkFolder: [folder: SessionProject, value: boolean]
}>()

const launcher = useLauncher()
const removal = useSessionRemoval()
const ui = useUiStore()
const workspaces = useWorkspacesStore()
const folderMove = useFolderMove()
const menuOpen = ref(false)
/** Its own sessions; those in its folders are with them. */
const {
  shown: visible,
  hidden,
  showMore,
} = useSessionPage(
  () => props.project.id,
  () => props.project.own,
)

const checkState = computed(() => {
  const count = props.project.sessions.filter((s) => props.checked?.has(sessionKey(s.accountId, s.id))).length
  if (count === 0) return false
  return count === props.project.sessions.length ? true : 'indeterminate'
})

const empty = computed(() => props.project.sessions.length === 0)
/** The folder isn't there (any more), e.g. moved or deleted outside the app. */
const missing = computed(() => !!props.project.path && workspaces.isMissing(props.project.path))
/** Where sessions can start and the folder can go: only where it is. */
const path = computed(() => (missing.value ? null : props.project.path))

const details = computed(() => {
  const { sessions, sizeBytes, updatedAt, path } = props.project
  const gone = missing.value ? 'Der Ordner ist nicht mehr da. Verschoben? Im Menü lässt sich sein neuer Ort zuordnen.' : ''
  if (!updatedAt) return [path, 'Noch keine Sessions', gone].filter(Boolean).join('\n')
  const count = sessions.length === 1 ? '1 Session' : `${sessions.length} Sessions`
  return [path, `${count} · ${formatBytes(sizeBytes)} · zuletzt ${formatRelative(updatedAt, props.now)}`, gone]
    .filter(Boolean)
    .join('\n')
})

/**
 * The workspaces the folder can move into: not the one it lies in, nor itself or one in it. A
 * workspace in another one says which.
 */
const moveTargets = computed(() => {
  const folder = path.value
  if (!folder) return []
  const here = folderKey(splitFolder(folder).parent)
  const all = workspaces.workspaces.filter((w) => w.exists)
  return all
    .filter((w) => folderKey(w.path) !== here && !inFolder(w.path, folder))
    .map((w) => {
      const outer = workspaceOf(splitFolder(w.path).parent, all.map((o) => o.path))
      return { path: w.path, name: w.name, outer: outer ? splitFolder(outer).name : null }
    })
})

function moveTo(into: string) {
  if (path.value) void folderMove.move(path.value, into)
}

/** A new workspace, beside the one the folder lies in; the folder moves into it once made. */
function moveToNewWorkspace() {
  if (!path.value || folderMove.blocked(path.value)) return
  const parent = splitFolder(splitFolder(path.value).parent).parent || null
  ui.workspaceRequest = { mode: 'create', parent, move: { path: path.value } }
}

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
              (menuOpen || highlighted === project.id) && 'bg-muted/60',
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
            <component
              :is="missing ? FolderXIcon : open && !empty ? FolderOpenIcon : FolderIcon"
              :class="cn('size-3.5 shrink-0 text-muted-foreground', missing && 'text-destructive/70')"
            />
            <span
              :class="
                cn('max-w-[70%] shrink-0 truncate font-medium', (empty || missing) && 'font-normal text-muted-foreground', missing && 'line-through')
              "
            >
              <HighlightText :text="project.name" :terms="terms ?? []" />
            </span>
            <span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{{ project.parent }}</span>
          </CollapsibleTrigger>
          <span v-if="!empty" class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ project.sessions.length }}</span>
          <NewSessionButton
            v-if="path"
            :path="path"
            :name="project.name"
            class="opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          />
          <span v-else class="size-6 shrink-0" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-56">
        <ContextMenuGroup>
          <NewSessionMenuItem :path="path" />
          <ContextMenuItem :disabled="!path" @select="launcher.newSessionInWorktree(null, path)">
            <FolderGit2Icon />
            Neue Session in Worktree…
          </ContextMenuItem>
          <ContextMenuItem :disabled="!path" @select="launcher.shell(launcher.defaultAccountId(), path)">
            <SquareTerminalIcon />
            Shell hier öffnen
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem v-if="missing" @select="folderMove.relocate(project.path!)">
            <FolderSearchIcon />
            Neuen Ort zuordnen…
          </ContextMenuItem>
          <ContextMenuItem v-else :disabled="!path" @select="openFolder">
            <FolderOpenIcon />
            Ordner öffnen
          </ContextMenuItem>
          <ContextMenuItem :disabled="!project.path" @select="copyPath">
            <CopyIcon />
            Pfad kopieren
          </ContextMenuItem>
          <ContextMenuSub v-if="path">
            <ContextMenuSubTrigger>
              <FolderInputIcon />
              Verschieben nach
            </ContextMenuSubTrigger>
            <ContextMenuSubContent class="max-h-[min(24rem,var(--reka-context-menu-content-available-height))] w-64 overflow-y-auto">
              <ContextMenuItem v-for="target in moveTargets" :key="target.path" @select="moveTo(target.path)">
                <LayersIcon />
                <span class="min-w-0 truncate">{{ target.name }}</span>
                <span v-if="target.outer" class="ml-auto shrink-0 text-xs text-muted-foreground">in {{ target.outer }}</span>
              </ContextMenuItem>
              <ContextMenuSeparator v-if="moveTargets.length" />
              <ContextMenuItem @select="moveToNewWorkspace">
                <FolderPlusIcon />
                Neuer Workspace…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub v-if="convertible && path">
            <ContextMenuSubTrigger>
              <LayersIcon />
              Zum Workspace machen
            </ContextMenuSubTrigger>
            <ContextMenuSubContent class="w-64">
              <ContextMenuItem @select="makeWorkspace(path)">
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
          <ContextMenuItem v-else-if="path" @select="makeWorkspace(path)">
            <LayersIcon />
            Zum Workspace machen…
          </ContextMenuItem>
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
      <!-- Every level down to the sessions, however deep; the folders before the sessions, as in a tree. -->
      <SessionProjectGroup
        v-for="folder in project.folders"
        :key="folder.id"
        :project="folder"
        :open="openFolders?.has(folder.id) ?? false"
        :open-folders="openFolders"
        :convertible="convertible"
        :selected="selected"
        :now="now"
        :hits="hits"
        :terms="terms"
        :selecting="selecting"
        :checked="checked"
        :highlighted="highlighted"
        @update:open="emit('openFolder', folder, $event)"
        @check="emit('checkFolder', folder, $event)"
        @open-folder="(f, o) => emit('openFolder', f, o)"
        @check-folder="(f, v) => emit('checkFolder', f, v)"
        @select="emit('select', $event)"
        @toggle="(session, range) => emit('toggle', session, range)"
      />
      <SessionListItem
        v-for="session in visible"
        :key="sessionKey(session.accountId, session.id)"
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
    </CollapsibleContent>
  </Collapsible>
</template>
