<script setup lang="ts">
import { computed } from 'vue'
import type { UsageWindow } from '@shared/types'
import { Progress } from '@/components/ui/progress'
import { formatReset } from '@/lib/format'
import { clampPercent, forecastHint, usageFillClass, usageLevel, usageTextClass, windowIdle } from '@/lib/usage'
import { cn } from '@/lib/utils'
import { useClock } from '@/composables/useClock'

const props = defineProps<{
  window: UsageWindow
  /** Smaller variant for account cards. */
  compact?: boolean
}>()

const now = useClock(30_000)
const percent = computed(() => clampPercent(props.window.percent))
const level = computed(() => usageLevel(percent.value))
const hint = computed(() => forecastHint(props.window, now.value))
const reset = computed(() =>
  windowIdle(props.window) ? 'Beginnt mit der nächsten Nachricht' : `Reset ${formatReset(props.window.resetsAt, now.value)}`,
)
</script>

<template>
  <div class="flex flex-col gap-1.5" :data-level="level">
    <div class="flex items-baseline justify-between gap-3">
      <span :class="cn('truncate font-medium', compact ? 'text-xs' : 'text-sm')">{{ window.label }}</span>
      <span
        :class="
          cn(
            'shrink-0 font-semibold tabular-nums',
            compact ? 'text-xs' : 'text-lg',
            level !== 'low' && usageTextClass[level],
          )
        "
      >
        {{ percent }}&nbsp;%
      </span>
    </div>
    <Progress
      :model-value="percent"
      :class="cn(compact ? 'h-1' : 'h-2', usageFillClass[level])"
    />
    <!-- Where the room runs short, the forecast goes to a line of its own. -->
    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <span>{{ reset }}</span>
      <span
        v-if="hint"
        v-tooltip="hint.title"
        :class="cn('shrink-0 tabular-nums', hint.warn && cn('font-medium', usageTextClass.high))"
      >
        {{ hint.text }}
      </span>
    </div>
  </div>
</template>
