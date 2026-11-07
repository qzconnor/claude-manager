<script setup lang="ts">
import { ChevronRightIcon, PlusIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { SessionSearchHit, SessionSummary } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLauncher } from '@/composables/useLauncher'
import type { SessionRef } from '@/composables/useSessionDetail'
import type { SessionProject } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import SessionProjectGroup from './SessionProjectGroup.vue'

/** An account in the session list, the top of the tree: its folders below it, and their sessions below them. */
const props = defineProps<{
  accountId: string
  projects: SessionProject[]
  /** Sessions in all folders. */
  count: number
  error: string | null
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
}>()
const emit = defineEmits<{
  'update:open': [open: boolean]
  openProject: [project: SessionProject, open: boolean]
  select: [session: SessionSummary]
  toggle: [session: SessionSummary, range: boolean]
  check: [project: SessionProject, value: boolean]
}>()

const accounts = useAccountsStore()
const launcher = useLauncher()
const account = computed(() => accounts.get(props.accountId))
</script>

<template>
  <Collapsible :open="open" class="flex flex-col gap-0.5" @update:open="emit('update:open', $event)">
    <div class="sticky top-0 z-10 mb-0.5 flex items-center gap-1 rounded-lg bg-surface-strong p-1 backdrop-blur-md">
      <!-- A plain row like the folders below: a ghost button would keep a background while open. -->
      <CollapsibleTrigger
        class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon
          :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')"
        />
        <AccountDot :color="account?.color" />
        <span class="truncate">{{ account?.name ?? accountId }}</span>
        <Badge variant="secondary" class="tabular-nums">{{ count }}</Badge>
      </CollapsibleTrigger>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-sm" aria-label="Neue Session mit diesem Account" @click="launcher.newSession(accountId)">
            <PlusIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Neue Session mit {{ account?.name }}</TooltipContent>
      </Tooltip>
    </div>
    <CollapsibleContent class="flex flex-col gap-0.5 pl-1">
      <p v-if="error" class="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
        <TriangleAlertIcon class="size-3.5 shrink-0" />
        {{ error }}
      </p>
      <p v-else-if="projects.length === 0" class="px-3 py-2 text-xs text-muted-foreground">Keine Sessions gefunden.</p>
      <SessionProjectGroup
        v-for="project in projects"
        :key="project.id"
        :project="project"
        :open="openProjects.has(project.id)"
        :selected="selected"
        :now="now"
        :hits="hits"
        :terms="terms"
        :selecting="selecting"
        :checked="checked"
        @update:open="emit('openProject', project, $event)"
        @select="emit('select', $event)"
        @toggle="(session, range) => emit('toggle', session, range)"
        @check="emit('check', project, $event)"
      />
    </CollapsibleContent>
  </Collapsible>
</template>
