<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" :class="cn('size-5', props.class)">
    <rect x="1.5" y="1.5" width="29" height="29" rx="8" class="fill-primary" />
    <path d="M9 11.5l5 4.5-5 4.5" class="stroke-primary-foreground" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M16.5 21h6.5" class="stroke-primary-foreground" stroke-width="2.6" stroke-linecap="round" />
  </svg>
</template>
