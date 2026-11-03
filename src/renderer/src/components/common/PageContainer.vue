<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <!-- Reserve the scrollbar's room on both edges: the centred page stays put whether it scrolls or not. -->
  <div class="size-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
    <div :class="cn('mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6', props.class)">
      <slot />
    </div>
  </div>
</template>
