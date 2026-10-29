<script setup lang="ts">
import { ChevronDownIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import type { SessionLimit, TerminalInfo } from '@shared/types'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useClock } from '@/composables/useClock'
import { formatReset } from '@/lib/format'
import { limitLabel } from '@/lib/usage'
import { useAccountsStore } from '@/stores/accounts'

/** Shown while the tab's session stands at a usage limit: continue right away with another account. */
const props = defineProps<{ terminal: TerminalInfo; limit: SessionLimit }>()
const emit = defineEmits<{ dismiss: [] }>()

const accounts = useAccountsStore()
const accountSwitch = useAccountSwitch()
const now = useClock(30_000)
const busy = ref(false)

const accountName = computed(() => accounts.get(props.terminal.authAccountId)?.name ?? 'diesem Account')
const choices = computed(() => accountSwitch.choices(props.terminal.accountId, props.terminal.authAccountId, now.value))
const suggested = computed(() => choices.value.find((c) => !c.limited && !c.disabled))
const canSwitch = computed(() => Boolean(props.terminal.sessionId) && choices.value.some((c) => !c.disabled))

async function switchTo(accountId: string) {
  busy.value = true
  try {
    await accountSwitch.continueTerminal(props.terminal, accountId)
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
    <TriangleAlertIcon class="size-4 shrink-0 text-warning" />
    <span class="min-w-0 truncate text-sm" :title="limit.message">
      {{ limitLabel(limit.type) }} von „{{ accountName }}“ erreicht
      <span v-if="limit.resetsAt" class="text-muted-foreground">· frei {{ formatReset(limit.resetsAt, now) }}</span>
    </span>
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
