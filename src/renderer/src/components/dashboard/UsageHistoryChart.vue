<script setup lang="ts">
import { VisAxis, VisLine, VisPlotline, VisScatter, VisXYContainer } from '@unovis/vue'
import { computed } from 'vue'
import type { UsageReading, UsageWindow } from '@shared/types'
import { ChartContainer, ChartCrosshair, ChartTooltip, componentToString, type ChartConfig } from '@/components/ui/chart'
import { formatHistoryTick, historyChart, historySummary, type HistoryKind, type HistoryPoint } from '@/lib/usage-history'
import UsageHistoryTooltip from './UsageHistoryTooltip.vue'

/**
 * The curve of a limit over the last day or two weeks: a solid line for the readings, broken at each
 * reset (also marked by a vertical line), and a dashed one for where the window heads.
 */
const props = defineProps<{ readings: UsageReading[]; window: UsageWindow | null; kind: HistoryKind; now: number }>()

const config = {
  used: { label: 'Ausgelastet', color: 'var(--chart-1)' },
  forecast: { label: 'Prognose', color: 'var(--chart-1)' },
} satisfies ChartConfig

// componentToString uses useId(), so both variants are created during setup.
const tooltips = {
  five_hour: componentToString(config, UsageHistoryTooltip, { kind: 'five_hour' }),
  seven_day: componentToString(config, UsageHistoryTooltip, { kind: 'seven_day' }),
}

const chart = computed(() => historyChart(props.readings, props.window, props.kind, props.now))
const summary = computed(() => historySummary(chart.value, props.kind))

const x = (d: HistoryPoint) => d.time
const y = [(d: HistoryPoint) => d.used, (d: HistoryPoint) => d.forecast]
const colors = [config.used.color, config.forecast.color]
const dashes = (_: HistoryPoint[], index: number) => (index === 1 ? [4, 4] : undefined)
/** The latest reading gets a dot: the curve ends there, and a single reading shows at all. */
const latestPoint = computed(() => chart.value.points.findLast((p) => p.used !== undefined))
const dotY = (d: HistoryPoint) => (d === latestPoint.value ? d.used : undefined)
const formatX = (time: number) => formatHistoryTick(props.kind, time)
</script>

<template>
  <p v-if="chart.latest === null" class="flex h-36 items-center justify-center text-center text-xs text-muted-foreground">
    Keine Messwerte in diesem Zeitraum. Die App sammelt sie, solange sie läuft.
  </p>
  <div v-else role="img" :aria-label="summary">
    <ChartContainer :config="config" class="aspect-auto h-36 w-full" cursor aria-hidden="true">
      <VisXYContainer
        :data="chart.points"
        :x-domain="[chart.from, chart.to]"
        :y-domain="[0, 100]"
        :padding="{ top: 8 }"
        :margin="{ left: 4, right: 4 }"
      >
        <VisPlotline
          v-for="reset in chart.resets"
          :key="reset"
          axis="x"
          :value="reset"
          :line-width="1"
          :duration="0"
          color="color-mix(in oklch, var(--muted-foreground) 45%, transparent)"
        />
        <VisLine :x="x" :y="y" :color="colors" :line-width="2" :line-dash-array="dashes" :duration="0" />
        <VisScatter :x="x" :y="dotY" :size="8" :color="config.used.color" stroke-color="var(--card)" :stroke-width="2" :duration="0" />
        <VisAxis
          type="x"
          :tick-values="chart.ticks"
          :tick-format="formatX"
          :tick-line="false"
          :domain-line="false"
          :grid-line="false"
          :duration="0"
        />
        <VisAxis
          type="y"
          :tick-values="[0, 50, 100]"
          :tick-format="(v: number) => `${v} %`"
          :tick-line="false"
          :domain-line="false"
          :duration="0"
        />
        <ChartTooltip />
        <ChartCrosshair :x="x" :y="y" :template="tooltips[kind]" color="#0000" />
      </VisXYContainer>
    </ChartContainer>
  </div>
</template>
