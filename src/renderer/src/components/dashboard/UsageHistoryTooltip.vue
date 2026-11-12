<script setup lang="ts">
import { computed } from 'vue'
import { formatHistoryTime, type HistoryKind, type HistoryPoint } from '@/lib/usage-history'

/** Tooltip for the curve of a limit; rendered to static HTML by `componentToString`. */
const props = defineProps<{ payload?: HistoryPoint; kind: HistoryKind }>()

const time = computed(() => (props.payload ? formatHistoryTime(props.kind, props.payload.time) : ''))
const row = computed(() => {
  const point = props.payload
  if (!point) return null
  if (point.reset) return { label: 'Reset', value: null, dashed: false }
  if (point.used !== undefined) return { label: 'Ausgelastet', value: point.used, dashed: false }
  if (point.forecast !== undefined)
    return { label: point.forecast >= 100 ? 'Voll (Prognose)' : 'Prognose zum Reset', value: point.forecast, dashed: true }
  return null
})
</script>

<template>
  <div class="grid min-w-36 gap-1 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xl">
    <div class="font-medium">{{ time }}</div>
    <div v-if="row" class="flex items-center gap-2">
      <span
        v-if="row.value !== null"
        class="w-3 shrink-0 border-t-2"
        :class="row.dashed && 'border-dashed'"
        style="border-color: var(--chart-1)"
      />
      <span class="flex-1 text-muted-foreground">{{ row.label }}</span>
      <span v-if="row.value !== null" class="font-medium tabular-nums">{{ Math.round(row.value) }}&nbsp;%</span>
    </div>
  </div>
</template>
