<script setup lang="ts">
import { computed } from 'vue'
import type { ChartConfig } from '@/components/ui/chart'
import { formatTokens } from '@/lib/format'

/** Tooltip for the token chart; rendered to static HTML by `componentToString`. */
const props = defineProps<{
  payload?: Record<string, unknown>
  config?: ChartConfig
  x?: number | Date
}>()

const dateFormat = new Intl.DateTimeFormat('de', { weekday: 'short', day: '2-digit', month: '2-digit' })

const label = computed(() => {
  const date = props.payload?.date
  return date instanceof Date ? dateFormat.format(date) : ''
})

const rows = computed(() =>
  Object.entries(props.config ?? {}).map(([key, item]) => ({
    key,
    label: typeof item.label === 'string' ? item.label : key,
    color: item.color,
    value: Number(props.payload?.[key] ?? 0),
  })),
)
const total = computed(() => rows.value.reduce((sum, r) => sum + r.value, 0))
</script>

<template>
  <div class="grid min-w-40 gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xl">
    <div class="font-medium">{{ label }}</div>
    <div v-for="row in rows" :key="row.key" class="flex items-center gap-2">
      <span class="size-2.5 shrink-0 rounded-xs" :style="{ backgroundColor: row.color }" />
      <span class="flex-1 text-muted-foreground">{{ row.label }}</span>
      <span class="font-mono font-medium tabular-nums">{{ formatTokens(row.value) }}</span>
    </div>
    <div class="flex items-center justify-between border-t pt-1.5">
      <span class="text-muted-foreground">Summe</span>
      <span class="font-mono font-medium tabular-nums">{{ formatTokens(total) }}</span>
    </div>
  </div>
</template>
