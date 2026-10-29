<script setup lang="ts">
import { VisAxis, VisStackedBar, VisXYContainer } from '@unovis/vue'
import { computed } from 'vue'
import type { DailyTokenStats } from '@shared/types'
import {
  ChartContainer,
  ChartCrosshair,
  ChartLegendContent,
  ChartTooltip,
  componentToString,
  type ChartConfig,
} from '@/components/ui/chart'
import { formatTokens } from '@/lib/format'
import TokenChartTooltip from './TokenChartTooltip.vue'

const props = defineProps<{ days: DailyTokenStats[]; includeCacheRead: boolean }>()

type SeriesKey = 'output' | 'input' | 'cacheCreation' | 'cacheRead'
interface Row extends Record<SeriesKey, number> {
  index: number
  date: Date
}

const baseConfig = {
  output: { label: 'Output', color: 'var(--chart-1)' },
  input: { label: 'Input', color: 'var(--chart-2)' },
  cacheCreation: { label: 'Cache-Write', color: 'var(--chart-3)' },
} satisfies ChartConfig
const fullConfig = {
  ...baseConfig,
  cacheRead: { label: 'Cache-Read', color: 'var(--chart-4)' },
} satisfies ChartConfig

// componentToString uses useId(), so both variants are created during setup.
const baseTooltip = componentToString(baseConfig, TokenChartTooltip)
const fullTooltip = componentToString(fullConfig, TokenChartTooltip)

const config = computed<ChartConfig>(() => (props.includeCacheRead ? fullConfig : baseConfig))
const keys = computed(() => Object.keys(config.value) as SeriesKey[])
const tooltip = computed(() => (props.includeCacheRead ? fullTooltip : baseTooltip))

const rows = computed<Row[]>(() =>
  props.days.map((d, index) => {
    const [year, month, day] = d.date.split('-').map(Number)
    return {
      index,
      date: new Date(year, month - 1, day),
      output: d.output,
      input: d.input,
      cacheCreation: d.cacheCreation,
      cacheRead: d.cacheRead,
    }
  }),
)

const y = computed(() => keys.value.map((key) => (d: Row) => d[key]))
const colors = computed(() => keys.value.map((key) => config.value[key]?.color ?? 'var(--chart-1)'))

const dayFormat = new Intl.DateTimeFormat('de', { day: '2-digit', month: '2-digit' })
const tickValues = computed(() => {
  const n = rows.value.length
  const step = Math.max(1, Math.ceil(n / 8))
  return rows.value.filter((_, i) => (n - 1 - i) % step === 0).map((r) => r.index)
})
const formatX = (index: number) => {
  const row = rows.value[Math.round(index)]
  return row ? dayFormat.format(row.date) : ''
}
</script>

<template>
  <ChartContainer :config="config" class="aspect-auto h-72 w-full" cursor>
    <VisXYContainer :data="rows" :padding="{ top: 8 }" :margin="{ left: 4, right: 4 }">
      <VisStackedBar
        :x="(d: Row) => d.index"
        :y="y"
        :color="colors"
        :rounded-corners="3"
        :bar-padding="0.25"
      />
      <VisAxis
        type="x"
        :x="(d: Row) => d.index"
        :tick-values="tickValues"
        :tick-format="formatX"
        :tick-line="false"
        :domain-line="false"
        :grid-line="false"
      />
      <VisAxis
        type="y"
        :num-ticks="4"
        :tick-format="(v: number) => formatTokens(v)"
        :tick-line="false"
        :domain-line="false"
      />
      <ChartTooltip />
      <!-- VisCrosshair forwards raw attrs without camelizing them, so `yStacked` must stay camelCase. -->
      <ChartCrosshair :x="(d: Row) => d.index" :yStacked="y" :template="tooltip" color="#0000" />
    </VisXYContainer>
    <ChartLegendContent />
  </ChartContainer>
</template>
