<script setup lang="ts">
import type { SeparatorProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { cn } from 'cn'
import { Separator } from 'reka-ui'
import { useCommand } from '.'

const props = defineProps<SeparatorProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = reactiveOmit(props, 'class')

// Like cmdk: while searching, the groups that are left follow each other without lines
const { filterState } = useCommand()
</script>

<template>
  <Separator
    v-if="!filterState.search.trim()"
    data-slot="command-separator"
    v-bind="delegatedProps"
    :class="cn('bg-border -mx-1 h-px', props.class)"
  >
    <slot />
  </Separator>
</template>
