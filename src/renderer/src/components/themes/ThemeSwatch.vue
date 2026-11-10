<script setup lang="ts">
import type { ThemeContent } from '@shared/themes/types'

/** The small picture of a theme in its own colors, as the theme picker shows it. */
const props = defineProps<{ theme: Pick<ThemeContent, 'colors' | 'terminal'> }>()

const swatches = () => {
  const t = props.theme.terminal
  return [t.red, t.yellow, t.green, t.cyan, t.blue, t.magenta]
}
</script>

<template>
  <div class="flex h-20 flex-col gap-2 p-3" :style="{ background: theme.colors.background }">
    <div class="flex items-center gap-1.5">
      <span class="h-2 w-10 rounded-full" :style="{ background: theme.colors.primary }" />
      <span class="h-2 w-6 rounded-full opacity-60" :style="{ background: theme.colors.mutedForeground }" />
    </div>
    <div class="flex flex-1 items-end gap-1 rounded-md p-1.5" :style="{ background: theme.colors.surface }">
      <span v-for="(color, i) in swatches()" :key="i" class="size-3 rounded-full" :style="{ background: color }" />
    </div>
  </div>
</template>
