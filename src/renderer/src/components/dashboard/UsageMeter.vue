<script setup lang="ts">
import { computed } from 'vue'
import type { UsageWindow } from '@shared/types'
import { Progress } from '@/components/ui/progress'
import { formatReset } from '@/lib/format'
import { clampPercent, usageFillClass, usageLevel, usageTextClass, windowIdle } from '@/lib/usage'
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
        {{ percent }}%
      </span>
    </div>
    <Progress
      :model-value="percent"
      :class="cn(compact ? 'h-1' : 'h-2', usageFillClass[level])"
    />
    <span class="text-xs text-muted-foreground">{{ reset }}</span>
  </div>
</template>
