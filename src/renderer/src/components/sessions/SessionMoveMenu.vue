<script setup lang="ts">
import { FolderIcon, FolderInputIcon, FolderSearchIcon, LayersIcon } from '@lucide/vue'
import { computed } from 'vue'
import { folderKey } from '@shared/folders'
import type { SessionSummary } from '@shared/types'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import { useSessionMove } from '@/composables/useSessionMove'
import { childPath, sessionFolder } from '@/lib/session-tree'
import { useWorkspacesStore } from '@/stores/workspaces'

/**
 * „Verschieben nach“ in the context menu of a session: the projects of the workspaces, or any folder.
 * The session goes on there as after `/cd`. Greyed out while Claude works on it.
 */
const props = defineProps<{ session: SessionSummary }>()

const workspaces = useWorkspacesStore()
const sessionMove = useSessionMove()
const working = computed(() => sessionMove.working(props.session))

/** The workspaces with their projects; the folder the session is in can't be chosen. */
const targets = computed(() => {
  const here = sessionFolder(props.session)
  return workspaces.workspaces
    .filter((w) => w.exists && w.projects.length > 0)
    .map((w) => ({
      path: w.path,
      name: w.name,
      projects: w.projects.map((name) => {
        const path = childPath(w.path, name)
        return { path, name, current: !!here && folderKey(here) === folderKey(path) }
      }),
    }))
})
</script>

<template>
  <ContextMenuSub>
    <ContextMenuSubTrigger :disabled="working">
      <FolderInputIcon />
      Verschieben nach
      <ContextMenuShortcut v-if="working" class="tracking-normal">arbeitet</ContextMenuShortcut>
    </ContextMenuSubTrigger>
    <ContextMenuSubContent class="w-64">
      <ContextMenuSub v-for="workspace in targets" :key="workspace.path">
        <ContextMenuSubTrigger>
          <LayersIcon />
          <span class="truncate">{{ workspace.name }}</span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent class="max-h-[min(24rem,var(--reka-context-menu-content-available-height))] w-64 overflow-y-auto">
          <ContextMenuItem
            v-for="project in workspace.projects"
            :key="project.path"
            :disabled="project.current"
            @select="sessionMove.move(session, project.path)"
          >
            <FolderIcon />
            <span class="min-w-0 truncate">{{ project.name }}</span>
            <ContextMenuShortcut v-if="project.current" class="tracking-normal">hier</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator v-if="targets.length" />
      <ContextMenuItem @select="sessionMove.moveElsewhere(session)">
        <FolderSearchIcon />
        Anderer Ordner…
      </ContextMenuItem>
    </ContextMenuSubContent>
  </ContextMenuSub>
</template>
