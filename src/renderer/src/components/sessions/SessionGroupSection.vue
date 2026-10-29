<script setup lang="ts">
import { ChevronRightIcon, PlusIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import type { SessionSummary } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLauncher } from '@/composables/useLauncher'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import type { SessionRef } from '@/composables/useSessionDetail'
import SessionListItem from './SessionListItem.vue'

const PAGE_SIZE = 80

const props = defineProps<{
  accountId: string
  sessions: SessionSummary[]
  error: string | null
  selected: SessionRef | null
  now: number
}>()
const emit = defineEmits<{ select: [session: SessionSummary] }>()

const accounts = useAccountsStore()
const launcher = useLauncher()
const account = computed(() => accounts.get(props.accountId))
const open = ref(true)
const limit = ref(PAGE_SIZE)
const visible = computed(() => props.sessions.slice(0, limit.value))
</script>

<template>
  <Collapsible v-model:open="open" class="flex flex-col gap-1">
    <div class="sticky top-0 z-10 flex items-center gap-1 rounded-lg bg-surface-strong p-1 backdrop-blur-md">
      <!-- A plain row like the sessions below: a ghost button would keep a background while open. -->
      <CollapsibleTrigger
        class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon
          :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')"
        />
        <AccountDot :color="account?.color" />
        <span class="truncate">{{ account?.name ?? accountId }}</span>
        <Badge variant="secondary" class="tabular-nums">{{ sessions.length }}</Badge>
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
    <CollapsibleContent class="flex flex-col gap-0.5">
      <p v-if="error" class="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
        <TriangleAlertIcon class="size-3.5 shrink-0" />
        {{ error }}
      </p>
      <p v-else-if="sessions.length === 0" class="px-3 py-2 text-xs text-muted-foreground">Keine Sessions gefunden.</p>
      <SessionListItem
        v-for="session in visible"
        :key="session.id"
        :session="session"
        :now="now"
        :selected="selected?.accountId === accountId && selected.sessionId === session.id"
        @select="emit('select', session)"
      />
      <Button v-if="sessions.length > limit" variant="ghost" size="sm" class="self-center" @click="limit += PAGE_SIZE">
        Weitere {{ Math.min(PAGE_SIZE, sessions.length - limit) }} von {{ sessions.length - limit }} anzeigen
      </Button>
    </CollapsibleContent>
  </Collapsible>
</template>
