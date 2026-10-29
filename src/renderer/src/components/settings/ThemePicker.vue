<script setup lang="ts">
import { CheckIcon } from '@lucide/vue'
import { THEMES } from '@/themes/themes'
import type { AppTheme } from '@/themes/types'
import { cn } from '@/lib/utils'

const model = defineModel<string>({ required: true })

function swatches(theme: AppTheme): string[] {
  const t = theme.terminal
  return [t.red, t.yellow, t.green, t.cyan, t.blue, t.magenta]
}
</script>

<template>
  <div role="radiogroup" aria-label="Theme" class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
    <button
      v-for="theme in THEMES"
      :key="theme.id"
      type="button"
      role="radio"
      :aria-checked="model === theme.id"
      :class="
        cn(
          'group/theme flex flex-col overflow-hidden rounded-xl text-left ring-1 ring-foreground/10 transition outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          model === theme.id ? 'ring-2 ring-primary' : 'hover:ring-foreground/25',
        )
      "
      @click="model = theme.id"
    >
      <!-- Preview: the theme's own colors, independent of the active theme. -->
      <div class="flex h-20 flex-col gap-2 p-3" :style="{ background: theme.colors.background }">
        <div class="flex items-center gap-1.5">
          <span class="h-2 w-10 rounded-full" :style="{ background: theme.colors.primary }" />
          <span class="h-2 w-6 rounded-full opacity-60" :style="{ background: theme.colors.mutedForeground }" />
        </div>
        <div class="flex flex-1 items-end gap-1 rounded-md p-1.5" :style="{ background: theme.colors.surface }">
          <span v-for="color in swatches(theme)" :key="color" class="size-3 rounded-full" :style="{ background: color }" />
        </div>
      </div>
      <div class="flex items-center justify-between gap-2 border-t bg-card px-3 py-2">
        <span class="truncate text-sm font-medium">{{ theme.name }}</span>
        <CheckIcon v-if="model === theme.id" class="size-4 text-primary" />
        <span v-else class="text-xs text-muted-foreground">{{ theme.mode === 'dark' ? 'Dunkel' : 'Hell' }}</span>
      </div>
    </button>
  </div>
</template>
