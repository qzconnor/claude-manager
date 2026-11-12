<script setup lang="ts" generic="T extends string">
import type { HTMLAttributes } from 'vue'
import { ToggleGroupItem, ToggleGroupRoot } from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * Pill-shaped single choice, styled like the TabsList so switches look the same everywhere.
 * Unlike a plain ToggleGroup the current value can't be deselected.
 */
const props = defineProps<{
  modelValue: T
  options: readonly { value: T; label: string }[]
  /** Stretch the control and its segments to the full width. */
  block?: boolean
  /** `sm`: as low as the bars of a pane (24px), with smaller text. */
  size?: 'sm'
  disabled?: boolean
  class?: HTMLAttributes['class']
}>()

const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

function onUpdate(value: unknown) {
  const match = props.options.find((o) => o.value === value)
  if (match && match.value !== props.modelValue) emit('update:modelValue', match.value)
}
</script>

<template>
  <ToggleGroupRoot
    type="single"
    data-slot="segmented-control"
    :model-value="modelValue"
    :disabled="disabled"
    :class="
      cn(
        'inline-flex items-center rounded-lg bg-muted text-muted-foreground',
        size === 'sm' ? 'h-[24px] p-[2px]' : 'h-8 p-0.75',
        block ? 'flex w-full' : 'w-fit',
        disabled && 'opacity-50',
        props.class,
      )
    "
    @update:model-value="onUpdate"
  >
    <ToggleGroupItem
      v-for="option in options"
      :key="option.value"
      :value="option.value"
      :class="
        cn(
          'inline-flex h-full min-w-0 cursor-pointer items-center justify-center rounded-md border border-transparent font-medium whitespace-nowrap text-foreground/60 transition-[color,background-color,box-shadow] outline-none',
          size === 'sm' ? 'px-2 text-xs' : 'px-2.5 text-sm',
          'hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed dark:text-muted-foreground dark:hover:text-foreground',
          'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30 dark:data-[state=on]:text-foreground',
          block && 'flex-1',
        )
      "
    >
      {{ option.label }}
    </ToggleGroupItem>
  </ToggleGroupRoot>
</template>
