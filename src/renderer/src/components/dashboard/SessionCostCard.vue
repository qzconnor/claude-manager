<script setup lang="ts">
import { ChevronDownIcon, ChevronUpIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { modelPrice } from '@shared/model-prices'
import type { AccountTokenStats, SessionSummary, SessionTokenStats } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCost, formatNumber, formatTokens } from '@/lib/format'
import { describeFolder } from '@/lib/session-tree'
import { useAppStore } from '@/stores/app'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'

/** The sessions that cost the most in the period, with their subagents; a click shows the session. */
const props = defineProps<{ stats: AccountTokenStats | null; loading: boolean; days: number }>()

const FIRST = 8

const app = useAppStore()
const ui = useUiStore()
const sessions = useSessionsStore()
const router = useRouter()
const all = ref(false)

// The saved sessions know the names given in the app and which sessions are still there.
if (!sessions.loaded) sessions.load().catch(() => undefined)

const known = computed(() => {
  const byId = new Map<string, SessionSummary>()
  for (const group of sessions.groups) {
    if (group.accountId !== props.stats?.accountId) continue
    for (const session of group.sessions) byId.set(session.id, session)
  }
  return byId
})

const rows = computed(() => {
  const list = props.stats?.sessions ?? []
  return (all.value ? list : list.slice(0, FIRST)).map((session) => {
    const summary = known.value.get(session.sessionId)
    return {
      session,
      title: summary?.title ?? session.title ?? 'Ohne Titel',
      ...describeFolder(session.path, session.projectKey, app.info?.homeDir),
      // Until the list is read, every session counts as there.
      exists: !sessions.loaded || !!summary,
    }
  })
})
const hidden = computed(() => Math.max(0, (props.stats?.sessions.length ?? 0) - FIRST))

/** A session that only used models without a price costs nothing known, not nothing. */
function cost(session: SessionTokenStats): string {
  return session.cost === 0 && session.model && !modelPrice(session.model) ? '–' : formatCost(session.cost)
}

function hint(row: (typeof rows.value)[number]): string {
  const { session } = row
  return [
    row.title,
    session.path ?? session.projectKey,
    [
      `Input ${formatTokens(session.input)}`,
      `Output ${formatTokens(session.output)}`,
      `Cache-Write ${formatTokens(session.cacheCreation)}`,
      `Cache-Read ${formatTokens(session.cacheRead)}`,
    ].join(' · '),
    row.exists ? 'Klicken, um die Session zu zeigen' : 'Die Session gibt es nicht mehr',
  ].join('\n')
}

function show(row: (typeof rows.value)[number]) {
  if (!props.stats || !row.exists) return
  ui.sessionToShow = { accountId: props.stats.accountId, sessionId: row.session.sessionId, query: '' }
  void router.push({ name: 'sessions' })
}

const shortModel = (model: string | null) => model?.replace(/^claude-/, '') ?? '–'
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Teuerste Sessions</CardTitle>
      <CardDescription>{{ days }} Tage · mit ihren Subagents</CardDescription>
    </CardHeader>
    <CardContent>
      <Skeleton v-if="!stats || loading" class="h-40 w-full" />
      <p v-else-if="rows.length === 0" class="py-6 text-center text-sm text-muted-foreground">Keine Daten</p>
      <template v-else>
        <Table class="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead class="w-36">Modell</TableHead>
              <TableHead class="w-24 text-right">Kosten</TableHead>
              <TableHead class="w-24 text-right">Antworten</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="row in rows"
              :key="`${row.session.projectKey}\n${row.session.sessionId}`"
              :class="row.exists ? 'cursor-pointer' : 'text-muted-foreground'"
              :tabindex="row.exists ? 0 : undefined"
              v-tooltip="hint(row)"
              @click="show(row)"
              @keydown.enter="show(row)"
            >
              <TableCell>
                <div class="flex min-w-0 items-baseline gap-2">
                  <span class="max-w-[70%] shrink-0 truncate font-medium">{{ row.title }}</span>
                  <span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{{ row.name }}</span>
                </div>
              </TableCell>
              <TableCell class="truncate font-mono text-xs">{{ shortModel(row.session.model) }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ cost(row.session) }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ formatNumber(row.session.messages) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Button v-if="hidden > 0" variant="ghost" size="sm" class="mt-2 text-muted-foreground" @click="all = !all">
          <ChevronUpIcon v-if="all" data-icon="inline-start" />
          <ChevronDownIcon v-else data-icon="inline-start" />
          {{ all ? 'Weniger anzeigen' : `Alle ${hidden + FIRST} anzeigen` }}
        </Button>
      </template>
    </CardContent>
  </Card>
</template>
