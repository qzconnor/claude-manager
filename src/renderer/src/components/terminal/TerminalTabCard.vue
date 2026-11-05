<script setup lang="ts">
import { CircleStopIcon, FolderIcon, FolderOpenIcon, HardDriveIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { Account, TerminalInfo } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import AccountIdentityLine from '@/components/common/AccountIdentityLine.vue'
import { Button } from '@/components/ui/button'
import { accountKindLabel, formatReset } from '@/lib/format'
import { fileManagerLabel } from '@/lib/platform'
import { limitLabel } from '@/lib/usage'

/** What the hover card of a tab shows: the full title and where the session runs. */
const props = defineProps<{
  terminal: TerminalInfo
  /** The account whose limits the tab uses. */
  account?: Account
  /** Set when the session lies with another account than the one it runs with. */
  sessionAccount?: Account
}>()
defineEmits<{ openFolder: [] }>()

const openLabel = `Im ${fileManagerLabel} öffnen`
const folder = computed(() => props.terminal.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? props.terminal.cwd)
</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="line-clamp-3 leading-snug font-medium break-words">{{ terminal.title }}</p>

    <div class="flex flex-col gap-2.5 text-xs">
      <div v-if="account" class="flex gap-2">
        <span class="flex h-4 w-3.5 shrink-0 items-center justify-center">
          <AccountDot :color="account.color" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate leading-4 font-medium">{{ account.name }}</p>
          <AccountIdentityLine
            :identity="account.identity"
            :fallback="accountKindLabel(account.kind)"
            class="text-muted-foreground"
          />
        </div>
      </div>

      <div class="flex gap-2">
        <FolderIcon class="mt-px size-3.5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate leading-4 font-medium">{{ folder }}</p>
          <p class="break-all text-muted-foreground">{{ terminal.cwd }}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          class="-my-1 -mr-1 text-muted-foreground"
          :aria-label="openLabel"
          :title="openLabel"
          @click="$emit('openFolder')"
        >
          <FolderOpenIcon class="size-3.5" />
        </Button>
      </div>

      <div v-if="sessionAccount" class="flex gap-2 text-muted-foreground">
        <HardDriveIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">Session gespeichert bei „{{ sessionAccount.name }}“</p>
      </div>

      <div v-if="terminal.limit" class="flex gap-2 text-warning">
        <TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">
          {{ limitLabel(terminal.limit.type) }} erreicht
          <template v-if="terminal.limit.resetsAt">· Reset {{ formatReset(terminal.limit.resetsAt) }}</template>
        </p>
      </div>

      <div v-if="terminal.status === 'exited'" class="flex gap-2 text-muted-foreground">
        <CircleStopIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">
          Beendet<template v-if="terminal.exitCode !== null"> (Exit-Code {{ terminal.exitCode }})</template>
        </p>
      </div>
    </div>
  </div>
</template>
