<script setup lang="ts">
import { BellRingIcon, LayoutGridIcon, PlusIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import OverviewCard from '@/components/overview/OverviewCard.vue'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useClock } from '@/composables/useClock'
import { useLauncher } from '@/composables/useLauncher'
import { nextWaiting, OVERVIEW_STATES, overviewGroups, type OverviewState } from '@/lib/overview'
import { useTerminalsStore } from '@/stores/terminals'

/**
 * All tabs at a glance (Mission Control): where Claude waits for the user comes first, then what
 * works, what is ready and what ended. A click goes to the tab, Ctrl+Shift+J from anywhere to the
 * next one that waits.
 */
const terminals = useTerminalsStore()
const launcher = useLauncher()
const router = useRouter()
const now = useClock(1000)

const groups = computed(() => overviewGroups(terminals.terminals))
const total = computed(() => OVERVIEW_STATES.reduce((sum, state) => sum + groups.value[state].length, 0))

const LABELS: Record<OverviewState, string> = {
  waiting: 'Wartet auf dich',
  working: 'Arbeitet',
  ready: 'Bereit',
  ended: 'Beendet',
}

/** Shows a tab; in groups the route follows it by itself. */
function open(id: string) {
  terminals.activate(id)
  if (!terminals.grouped) void router.push({ name: 'terminals' })
}

function openNextWaiting() {
  const id = nextWaiting(terminals.terminals, null)
  if (id) open(id)
}
</script>

<template>
  <PageContainer>
    <PageHeader title="Übersicht" description="Alle Tabs auf einen Blick: wo Claude auf dich wartet, was gerade läuft und was fertig ist.">
      <template v-if="total" #actions>
        <Button variant="outline" :disabled="!groups.waiting.length" @click="openNextWaiting">
          <BellRingIcon data-icon="inline-start" />
          Zum wartenden Tab
          <KbdGroup class="ml-1">
            <Kbd>Strg</Kbd><Kbd>Umschalt</Kbd><Kbd>J</Kbd>
          </KbdGroup>
        </Button>
      </template>
    </PageHeader>

    <Empty v-if="!total" class="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><LayoutGridIcon /></EmptyMedia>
        <EmptyTitle>Keine offenen Tabs</EmptyTitle>
        <EmptyDescription>Sessions und Shells, die du öffnest, erscheinen hier mit ihrem Zustand.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button @click="launcher.newSession()">
          <PlusIcon data-icon="inline-start" />
          Neue Session
        </Button>
      </EmptyContent>
    </Empty>

    <template v-for="state in OVERVIEW_STATES" :key="state">
      <section v-if="groups[state].length" class="flex flex-col gap-3" :aria-label="LABELS[state]">
        <h2 class="flex items-center gap-2 text-sm font-medium">
          <span v-if="state === 'waiting'" class="size-2 rounded-full bg-warning" aria-hidden="true" />
          {{ LABELS[state] }}
          <span class="text-muted-foreground tabular-nums">{{ groups[state].length }}</span>
        </h2>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
          <OverviewCard v-for="terminal in groups[state]" :key="terminal.id" :terminal="terminal" :now="now" @open="open(terminal.id)" />
        </div>
      </section>
    </template>
  </PageContainer>
</template>
