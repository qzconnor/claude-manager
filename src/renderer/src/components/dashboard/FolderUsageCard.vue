<script setup lang="ts">
import { ChevronDownIcon, ChevronUpIcon, InfoIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { weightedTokens } from '@shared/token-stats'
import type { AccountTokenStats, FolderTokenStats } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatNumber, formatTokens } from '@/lib/format'
import { describeFolder } from '@/lib/session-tree'
import { useAppStore } from '@/stores/app'
import { useUiStore } from '@/stores/ui'

/** Which folders the usage of the period went to, the largest first; a click shows the folder's sessions. */
const props = defineProps<{ stats: AccountTokenStats | null; loading: boolean; days: number }>()

const FIRST = 8

const app = useAppStore()
const ui = useUiStore()
const router = useRouter()
const all = ref(false)

const total = computed(() => props.stats?.folders.reduce((sum, f) => sum + weightedTokens(f), 0) ?? 0)
const rows = computed(() => {
  const folders = props.stats?.folders ?? []
  return (all.value ? folders : folders.slice(0, FIRST)).map((folder) => ({
    folder,
    ...describeFolder(folder.path, folder.projectKey, app.info?.homeDir),
    share: total.value > 0 ? weightedTokens(folder) / total.value : 0,
  }))
})
const hidden = computed(() => Math.max(0, (props.stats?.folders.length ?? 0) - FIRST))

function percent(share: number): string {
  const value = share * 100
  return value > 0 && value < 1 ? '< 1 %' : `${Math.round(value)} %`
}

function breakdown(folder: FolderTokenStats): string {
  return [
    `Input ${formatTokens(folder.input)}`,
    `Output ${formatTokens(folder.output)}`,
    `Cache-Write ${formatTokens(folder.cacheCreation)}`,
    `Cache-Read ${formatTokens(folder.cacheRead)}`,
  ].join(' · ')
}

function show(folder: FolderTokenStats) {
  if (!props.stats) return
  ui.folderToShow = { accountId: props.stats.accountId, path: folder.path, projectKey: folder.projectKey }
  void router.push({ name: 'sessions' })
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Nach Ordner</CardTitle>
      <CardDescription>{{ days }} Tage · Worktrees zählen zu ihrem Repository</CardDescription>
      <CardAction>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon-xs" class="text-muted-foreground" aria-label="Wie der Anteil berechnet wird">
              <InfoIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent class="max-w-72">
            Der Anteil gewichtet die Tokens wie die API-Preise: Output zählt fünffach, Cache-Write 1,25-fach,
            Cache-Read ein Zehntel von Input. Unterschiede zwischen den Modellen bleiben außen vor.
          </TooltipContent>
        </Tooltip>
      </CardAction>
    </CardHeader>
    <CardContent>
      <Skeleton v-if="!stats || loading" class="h-40 w-full" />
      <p v-else-if="rows.length === 0" class="py-6 text-center text-sm text-muted-foreground">Keine Daten</p>
      <template v-else>
        <Table class="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Ordner</TableHead>
              <TableHead class="w-[28%]">Anteil</TableHead>
              <TableHead class="w-24 text-right">Output</TableHead>
              <TableHead class="w-24 text-right">Antworten</TableHead>
              <TableHead class="w-20 text-right">Sessions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="row in rows"
              :key="row.folder.path ?? `#${row.folder.projectKey}`"
              class="cursor-pointer"
              tabindex="0"
              v-tooltip="`${row.folder.path ?? row.folder.projectKey}\n${breakdown(row.folder)}\nKlicken, um die Sessions zu zeigen`"
              @click="show(row.folder)"
              @keydown.enter="show(row.folder)"
            >
              <TableCell>
                <div class="flex min-w-0 items-baseline gap-2">
                  <span class="max-w-[60%] shrink-0 truncate font-medium">{{ row.name }}</span>
                  <span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{{ row.parent }}</span>
                </div>
              </TableCell>
              <TableCell>
                <div class="flex items-center gap-2">
                  <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <div class="h-full rounded-full bg-chart-1" :style="{ width: `${Math.max(row.share * 100, 1)}%` }" />
                  </div>
                  <span class="w-11 shrink-0 text-right text-xs tabular-nums">{{ percent(row.share) }}</span>
                </div>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ formatTokens(row.folder.output) }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ formatNumber(row.folder.messages) }}</TableCell>
              <TableCell class="text-right tabular-nums">{{ formatNumber(row.folder.sessionCount) }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Button v-if="hidden > 0" variant="ghost" size="sm" class="mt-2 text-muted-foreground" @click="all = !all">
          <ChevronUpIcon v-if="all" data-icon="inline-start" />
          <ChevronDownIcon v-else data-icon="inline-start" />
          {{ all ? 'Weniger anzeigen' : `Alle ${hidden + FIRST} Ordner anzeigen` }}
        </Button>
      </template>
    </CardContent>
  </Card>
</template>
