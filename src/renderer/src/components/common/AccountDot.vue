<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ color: string | null | undefined; class?: HTMLAttributes['class'] }>()
</script>

<template>
  <span
    aria-hidden="true"
    :class="cn('inline-block size-2 shrink-0 rounded-full ring-2 ring-foreground/10', props.class)"
    :style="{ backgroundColor: color ?? 'var(--muted-foreground)' }"
  />
</template>
