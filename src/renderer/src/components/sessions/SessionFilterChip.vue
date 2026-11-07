<script setup lang="ts">
import { ChevronDownIcon } from '@lucide/vue'
import { computed, type Component } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface FilterOption {
  value: string
  label: string
  /** Shorter label for the button, e.g. „Über 10 MB“. */
  short?: string
  color?: string | null
}

/**
 * A filter of the session list: a button that names what it filters by or, once set, its value,
 * and then stands out. Its menu offers „all“ (`all`) and groups of options, e.g. newer / older than.
 */
const props = defineProps<{
  icon: Component
  /** What the filter is about, e.g. „Zeitraum“: the label while unset and for screen readers. */
  name: string
  allLabel: string
  groups: FilterOption[][]
}>()
const model = defineModel<string>({ required: true })

const current = computed(() => props.groups.flat().find((o) => o.value === model.value) ?? null)
const value = computed(() => (current.value ? (current.value.short ?? current.value.label) : null))
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="outline"
        size="sm"
        :aria-label="value ? `${name}: ${value}` : name"
        :class="
          cn(
            'min-w-0 shrink font-normal',
            value
              ? 'border-primary/40 bg-primary/10 hover:bg-primary/15 aria-expanded:bg-primary/15 dark:border-primary/30 dark:bg-primary/10 dark:hover:bg-primary/15'
              : 'text-muted-foreground',
          )
        "
      >
        <component :is="icon" data-icon="inline-start" :class="value ? 'text-foreground' : 'text-muted-foreground'" />
        <span class="truncate">{{ value ?? name }}</span>
        <ChevronDownIcon data-icon="inline-end" class="text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="w-auto min-w-48">
      <DropdownMenuRadioGroup v-model="model">
        <DropdownMenuRadioItem value="all">{{ allLabel }}</DropdownMenuRadioItem>
        <template v-for="options in groups" :key="options[0]?.value">
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem v-for="option in options" :key="option.value" :value="option.value">
            <slot name="option" :option="option">{{ option.label }}</slot>
          </DropdownMenuRadioItem>
        </template>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
