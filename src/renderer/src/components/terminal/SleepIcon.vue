<script setup lang="ts">
import { LoaderCircleIcon, MoonIcon, TriangleAlertIcon } from '@lucide/vue'
import type { TerminalSleep } from '@shared/types'
import { cn } from '@/lib/utils'

/** The symbol of a tab of the last run that waits to start: it waits, starts, or didn't start (see `TerminalInfo.sleep`). */
const props = defineProps<{ sleep: TerminalSleep | null; class?: string }>()
</script>

<template>
  <TriangleAlertIcon v-if="sleep?.error" role="img" aria-label="Startete nicht" :class="cn('size-3.5 text-warning', props.class)" />
  <LoaderCircleIcon v-else-if="sleep?.waking" role="status" aria-label="Startet" :class="cn('size-3.5 animate-spin', props.class)" />
  <MoonIcon v-else role="img" aria-label="Startet, sobald der Tab gezeigt wird" :class="cn('size-3.5 opacity-70', props.class)" />
</template>
