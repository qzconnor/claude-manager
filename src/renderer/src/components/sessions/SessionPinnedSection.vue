<script setup lang="ts">
import { ChevronRightIcon, PinIcon } from '@lucide/vue'
import type { SessionSearchHit, SessionSummary } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { SessionRef } from '@/composables/useSessionDetail'
import { sessionKey } from '@/composables/useSessionSearch'
import { cn } from '@/lib/utils'
import SessionListItem from './SessionListItem.vue'

/**
 * The pinned sessions on top of the list, sticky like the sections below, the latest first. They stay
 * in their folders too: here each row names its folder.
 */
defineProps<{
  sessions: SessionSummary[]
  open: boolean
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
  select: [session: SessionSummary]
  toggle: [session: SessionSummary, range: boolean]
}>()
</script>

<template>
  <Collapsible :open="open" data-list-group class="flex flex-col gap-0.5" @update:open="emit('update:open', $event)">
    <div class="sticky top-0 z-10 mb-0.5 flex items-center gap-1 rounded-lg bg-surface-strong p-1 backdrop-blur-md">
      <CollapsibleTrigger
        data-list-row
        class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')" />
        <PinIcon class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="truncate">Angeheftet</span>
        <Badge variant="secondary" class="ml-auto tabular-nums">{{ sessions.length }}</Badge>
      </CollapsibleTrigger>
    </div>
    <CollapsibleContent class="flex flex-col gap-0.5 pl-1">
      <SessionListItem
        v-for="session in sessions"
        :key="sessionKey(session.accountId, session.id)"
        :session="session"
        :now="now"
        :selected="selected?.accountId === session.accountId && selected.sessionId === session.id"
        :hit="hits?.get(sessionKey(session.accountId, session.id))"
        :terms="terms"
        :selecting="selecting"
        :checked="checked?.has(sessionKey(session.accountId, session.id))"
        show-folder
        @select="emit('select', session)"
        @toggle="emit('toggle', session, $event)"
      />
    </CollapsibleContent>
  </Collapsible>
</template>
