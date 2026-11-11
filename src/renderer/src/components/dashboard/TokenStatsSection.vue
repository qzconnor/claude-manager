<script setup lang="ts">
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  DatabaseIcon,
  DatabaseZapIcon,
  FolderKanbanIcon,
  MessagesSquareIcon,
  TriangleAlertIcon,
} from '@lucide/vue'
import { computed, onActivated, ref, watch } from 'vue'
import AccountSelect from '@/components/common/AccountSelect.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { formatDateTime, formatNumber, formatTokens } from '@/lib/format'
import { statsKey, useUsageStore } from '@/stores/usage'
import FolderUsageCard from './FolderUsageCard.vue'
import StatTile from './StatTile.vue'
import TokenChart from './TokenChart.vue'

const RANGES = [7, 14, 30, 90] as const
const RANGE_OPTIONS = RANGES.map((range) => ({ value: String(range), label: `${range} T.` }))

const accountId = defineModel<string>('accountId', { required: true })
const usage = useUsageStore()

const days = ref<number>(30)
const includeCacheRead = ref(false)

const key = computed(() => statsKey(accountId.value, days.value))
/** Of this account and period; while another one is computed, the last one of it. */
const stats = computed(() => usage.stats[key.value] ?? null)
const loading = computed(() => usage.statsLoading[key.value] ?? false)
const error = computed(() => usage.statsErrors[key.value] ?? null)
const hasData = computed(() => (stats.value?.totals.messages ?? 0) > 0)

function load() {
  void usage.loadStats(accountId.value, days.value)
}

watch([accountId, days], load, { immediate: true })

// Recompute when the dashboard is shown again (it is kept alive between visits).
let activated = false
onActivated(() => {
  if (activated) load()
  activated = true
})

function onRangeChange(value: unknown) {
  const n = Number(value)
  if (RANGES.includes(n as (typeof RANGES)[number])) days.value = n
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="font-heading text-base font-semibold">Token-Verbrauch</h2>
        <p class="text-sm text-muted-foreground">Aus den lokalen Session-Transcripts berechnet (inkl. Subagents).</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <AccountSelect v-model="accountId" size="sm" class="w-48" />
        <SegmentedControl
          :model-value="String(days)"
          :options="RANGE_OPTIONS"
          aria-label="Zeitraum"
          @update:model-value="onRangeChange"
        />
      </div>
    </div>

    <Alert v-if="error" variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{{ stats ? 'Statistik konnte nicht neu berechnet werden' : 'Statistik konnte nicht berechnet werden' }}</AlertTitle>
      <AlertDescription class="flex flex-col items-start gap-2">
        <span>{{ error }}</span>
        <Button variant="outline" size="sm" :disabled="loading" @click="load">Erneut versuchen</Button>
      </AlertDescription>
    </Alert>

    <div v-if="!stats && !error" class="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Skeleton v-for="i in 6" :key="i" class="h-20" />
    </div>
    <div v-else-if="stats" class="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatTile label="Input" :icon="ArrowDownToLineIcon" :value="formatTokens(stats.totals.input)" />
      <StatTile label="Output" :icon="ArrowUpFromLineIcon" :value="formatTokens(stats.totals.output)" />
      <StatTile label="Cache-Write" :icon="DatabaseZapIcon" :value="formatTokens(stats.totals.cacheCreation)" />
      <StatTile label="Cache-Read" :icon="DatabaseIcon" :value="formatTokens(stats.totals.cacheRead)" />
      <StatTile label="Antworten" :icon="MessagesSquareIcon" :value="formatNumber(stats.totals.messages)" />
      <StatTile label="Sessions" :icon="FolderKanbanIcon" :value="formatNumber(stats.sessionCount)" />
    </div>

    <div v-if="stats || !error" class="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Tokens pro Tag</CardTitle>
          <CardDescription>
            {{ stats ? `Berechnet ${formatDateTime(stats.computedAt)}` : 'Wird berechnet…' }}
          </CardDescription>
          <CardAction>
            <Field orientation="horizontal">
              <Switch id="include-cache-read" v-model="includeCacheRead" size="sm" />
              <FieldLabel for="include-cache-read" class="text-xs font-normal">Cache-Reads</FieldLabel>
            </Field>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Skeleton v-if="!stats" class="h-64 w-full" />
          <Empty v-else-if="!hasData" class="h-64">
            <EmptyHeader>
              <EmptyTitle>Keine Aktivität</EmptyTitle>
              <EmptyDescription>Im gewählten Zeitraum gibt es keine Antworten für diesen Account.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <TokenChart v-else :days="stats.days" :include-cache-read="includeCacheRead" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nach Modell</CardTitle>
          <CardDescription>{{ days }} Tage</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton v-if="!stats || loading" class="h-40 w-full" />
          <Table v-else>
            <TableHeader>
              <TableRow>
                <TableHead>Modell</TableHead>
                <TableHead class="text-right">Output</TableHead>
                <TableHead class="text-right">Antworten</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="model in stats.models" :key="model.model">
                <TableCell class="max-w-40 truncate font-mono text-xs" v-tooltip="model.model">{{ shortModel(model.model) }}</TableCell>
                <TableCell class="text-right tabular-nums">{{ formatTokens(model.output) }}</TableCell>
                <TableCell class="text-right tabular-nums">{{ formatNumber(model.messages) }}</TableCell>
              </TableRow>
              <TableRow v-if="stats.models.length === 0">
                <TableCell colspan="3" class="text-center text-muted-foreground">Keine Daten</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>

    <FolderUsageCard v-if="stats || !error" :stats="stats" :loading="loading" :days="days" />
  </section>
</template>
