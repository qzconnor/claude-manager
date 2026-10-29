<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import type { AccountIdentity } from '@shared/types'
import { identityLabel, organizationLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * „name@firma.de · Firma“ on one line. When space runs out the email is shortened, never the
 * organization: it is what tells two logins with the same email apart.
 */
const props = defineProps<{
  identity: AccountIdentity
  /** Shown when the login is not known, e.g. for tokens. */
  fallback?: string | null
  class?: HTMLAttributes['class']
}>()

const organization = computed(() => organizationLabel(props.identity))
const label = computed(() => identityLabel(props.identity))
</script>

<template>
  <span v-if="label" :class="cn('flex min-w-0', props.class)" :title="label">
    <span v-if="identity.email" class="truncate">{{ identity.email }}</span>
    <template v-if="organization">
      <span v-if="identity.email" aria-hidden="true" class="shrink-0 px-1">·</span>
      <span :class="cn('truncate', identity.email && 'max-w-[60%] shrink-0')">{{ organization }}</span>
    </template>
  </span>
  <span v-else-if="fallback" :class="cn('block truncate', props.class)">{{ fallback }}</span>
</template>
