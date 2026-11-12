<script setup lang="ts">
import { ChevronDownIcon, TimerIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import type { SessionLimit, TerminalInfo } from '@shared/types'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useClock } from '@/composables/useClock'
import { attempt } from '@/lib/errors'
import { formatClock, formatCountdown, formatReset } from '@/lib/format'
import { limitLabel } from '@/lib/usage'
import { useAccountsStore } from '@/stores/accounts'

/**
 * Shown while the tab's session stands at a usage limit: continue right away with another account, or
 * by itself at the reset, with a countdown. `limit` is null once the limit has reset and the session
 * is about to go on (`terminal.resume`).
 */
const props = defineProps<{ terminal: TerminalInfo; limit: SessionLimit | null }>()
const emit = defineEmits<{ dismiss: [] }>()

const accounts = useAccountsStore()
const accountSwitch = useAccountSwitch()
// Every second for the countdown.
const now = useClock(1000)
const busy = ref(false)

const accountName = computed(() => accounts.get(props.terminal.authAccountId)?.name ?? 'diesem Account')
const choices = computed(() => accountSwitch.choices(props.terminal.accountId, props.terminal.authAccountId, now.value))
const suggested = computed(() => choices.value.find((c) => !c.limited && !c.disabled))
const canSwitch = computed(() => Boolean(props.limit && props.terminal.sessionId) && choices.value.some((c) => !c.disabled))
const resume = computed(() => props.terminal.resume)
/** Whether the session can be asked to go on by itself at the reset. */
const canResume = computed(() => !resume.value && Boolean(props.limit?.resetsAt && props.terminal.sessionId))

async function switchTo(accountId: string) {
  busy.value = true
  try {
    await accountSwitch.continueTerminal(props.terminal, accountId)
  } finally {
    busy.value = false
  }
}

async function resumeAtReset(on: boolean) {
  busy.value = true
  try {
    await attempt(() => window.api.terminals.resumeAtReset(props.terminal.id, on), 'Konnte nicht geändert werden')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    role="status"
    class="glass flex max-w-full items-center gap-3 rounded-xl py-2 pr-2 pl-4 shadow-lg ring-1 ring-foreground/10"
  >
    <TimerIcon v-if="resume" class="size-4 shrink-0 text-warning" />
    <TriangleAlertIcon v-else class="size-4 shrink-0 text-warning" />
    <span class="min-w-0 truncate text-sm" v-tooltip="limit?.message">
      <template v-if="limit">{{ limitLabel(limit.type) }} von „{{ accountName }}“ erreicht</template>
      <template v-else>Limit von „{{ accountName }}“ zurückgesetzt</template>
      <span v-if="resume?.at" class="text-muted-foreground">
        ·
        <!-- The countdown changes every second: a screen reader hears the time instead. -->
        <span class="sr-only">geht um {{ formatClock(resume.at, now) }} weiter</span>
        <span aria-hidden="true">
          geht {{ Date.parse(resume.at) > now ? 'in' : 'gleich' }}
          <span v-if="Date.parse(resume.at) > now" class="tabular-nums">{{ formatCountdown(resume.at, now) }}</span>
          weiter
        </span>
      </span>
      <span v-else-if="resume" class="text-muted-foreground"> · geht weiter, sobald ein Account frei ist</span>
      <span v-else-if="limit?.resetsAt" class="text-muted-foreground"> · frei {{ formatReset(limit.resetsAt, now) }}</span>
    </span>
    <Button v-if="canResume" size="sm" variant="secondary" class="shrink-0" :disabled="busy" @click="resumeAtReset(true)">
      Am Reset fortsetzen
    </Button>
    <Button
      v-else-if="resume?.byUser"
      size="sm"
      variant="ghost"
      class="shrink-0"
      :disabled="busy"
      v-tooltip="'Die Session wartet dann wieder auf dich'"
      @click="resumeAtReset(false)"
    >
      Nicht fortsetzen
    </Button>
    <ButtonGroup v-if="canSwitch" class="shrink-0">
      <Button v-if="suggested" size="sm" variant="secondary" :disabled="busy" @click="switchTo(suggested.account.id)">
        Mit „{{ suggested.account.name }}“ fortsetzen
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            size="sm"
            variant="secondary"
            :disabled="busy"
            :aria-label="suggested ? 'Anderen Account wählen' : 'Account wählen'"
          >
            <span v-if="!suggested">Account wählen</span>
            <ChevronDownIcon :data-icon="suggested ? undefined : 'inline-end'" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-72" @close-auto-focus.prevent>
          <AccountChoiceItems menu="dropdown" :choices="choices" @select="switchTo" />
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
    <Button size="icon-sm" variant="ghost" class="shrink-0" aria-label="Hinweis ausblenden" @click="emit('dismiss')">
      <XIcon />
    </Button>
  </div>
</template>
