<script setup lang="ts">
import { CircleAlertIcon, CircleCheckIcon, ClockAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { Account } from '@shared/types'
import { cn } from '@/lib/utils'

const props = defineProps<{ account: Account }>()

const status = computed(() => {
  const { authState, kind } = props.account
  if (authState === 'ok') {
    return { icon: CircleCheckIcon, tone: 'text-success', text: kind === 'token' || kind === 'apiKey' ? 'Secret hinterlegt' : 'Angemeldet' }
  }
  if (authState === 'expired') {
    return { icon: ClockAlertIcon, tone: 'text-warning', text: 'Access-Token abgelaufen – Claude Code erneuert ihn beim nächsten Start' }
  }
  return {
    icon: CircleAlertIcon,
    tone: 'text-destructive',
    text: kind === 'token' || kind === 'apiKey' ? 'Kein gültiges Secret gespeichert' : 'Nicht angemeldet',
  }
})
</script>

<template>
  <span :class="cn('flex items-center gap-1.5 text-xs', status.tone)">
    <component :is="status.icon" class="size-3.5 shrink-0" />
    <span class="min-w-0">{{ status.text }}</span>
  </span>
</template>
