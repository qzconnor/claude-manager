<script setup lang="ts">
import { ArrowRightIcon, CircleAlertIcon, RefreshCwIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AccountDot from '@/components/common/AccountDot.vue'
import AccountIdentityLine from '@/components/common/AccountIdentityLine.vue'
import UsageRing from '@/components/common/UsageRing.vue'
import UsageMeter from '@/components/dashboard/UsageMeter.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { useClock } from '@/composables/useClock'
import { attempt } from '@/lib/errors'
import { formatRelative, identityLabel, planLabel } from '@/lib/format'
import { clampPercent, usageFillClass, usageLevel } from '@/lib/usage'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useTerminalsStore } from '@/stores/terminals'
import { useUsageStore } from '@/stores/usage'

/**
 * Plan limits of the account behind the active terminal, shown in the title bar.
 * Hidden when no terminal is open or the account has no limit data (tokens, API keys).
 */
const router = useRouter()
const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const usageStore = useUsageStore()
const now = useClock(30_000)
const open = ref(false)

const account = computed(() => {
  const terminal = terminals.active
  return terminal ? accounts.get(terminal.authAccountId) : undefined
})
const usage = computed(() => (account.value ? usageStore.byAccount.get(account.value.id) : undefined))
const summary = computed(() => {
  const items: { key: string; short: string; percent: number }[] = []
  const u = usage.value
  if (u?.fiveHour) items.push({ key: 'five-hour', short: '5 Std.', percent: clampPercent(u.fiveHour.percent) })
  if (u?.sevenDay) items.push({ key: 'seven-day', short: 'Woche', percent: clampPercent(u.sevenDay.percent) })
  return items
})
const plan = computed(() => planLabel(account.value?.identity.subscriptionType))
const who = computed(() => (account.value ? identityLabel(account.value.identity) : null))
const label = computed(() => summary.value.map((item) => `${item.short} ${item.percent} %`).join(', '))
const extra = computed(() => (usage.value?.extra?.enabled ? usage.value.extra : null))
const currency = computed(
  () => new Intl.NumberFormat('de', { style: 'currency', currency: extra.value?.currency || 'USD', maximumFractionDigits: 2 }),
)
const problem = computed(() => (usage.value && usage.value.status !== 'ok' ? usage.value.message : null))

function refresh() {
  const id = account.value?.id
  if (id) void attempt(() => usageStore.refresh(id), 'Aktualisieren fehlgeschlagen')
}

function openDashboard() {
  open.value = false
  void router.push({ name: 'dashboard' })
}
</script>

<template>
  <Transition
    enter-from-class="opacity-0"
    leave-to-class="opacity-0"
    enter-active-class="transition-opacity duration-200"
    leave-active-class="transition-opacity duration-150"
  >
    <!-- Wrapper element: Transition needs one root, the popover renders trigger + portal. -->
    <div v-if="account && usage && summary.length" class="app-no-drag flex shrink-0">
      <Popover v-model:open="open">
        <PopoverTrigger as-child>
          <Button
            variant="outline"
            size="sm"
            class="app-no-drag gap-3 px-2.5 font-normal text-muted-foreground"
            :aria-label="`Nutzungslimits ${who ? `${account.name}, ${who}` : account.name}: ${label}`"
          >
            <span v-for="item in summary" :key="item.key" class="flex items-center gap-1.5">
              <UsageRing :percent="item.percent" :size="14" class="size-3.5" />
              <span>{{ item.short }}</span>
              <span class="font-medium text-foreground tabular-nums">{{ item.percent }}%</span>
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-80 gap-0 p-0" @open-auto-focus.prevent @close-auto-focus.prevent>
          <div class="flex flex-col gap-0.5 p-3 pb-2">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <span class="font-heading font-medium">Nutzungslimits</span>
                <Badge v-if="plan" variant="secondary">{{ plan }}</Badge>
              </div>
              <Button variant="ghost" size="xs" class="-mr-1 shrink-0" @click="openDashboard">
                Dashboard
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </div>
            <div class="flex min-w-0 items-center gap-1.5 text-xs">
              <AccountDot :color="account.color" />
              <span class="truncate">{{ account.name }}</span>
            </div>
            <AccountIdentityLine :identity="account.identity" class="pl-3.5 text-xs text-muted-foreground" />
          </div>

          <div class="flex flex-col gap-4 px-3 py-2">
            <UsageMeter v-if="usage.fiveHour" :window="usage.fiveHour" compact />
            <UsageMeter v-if="usage.sevenDay" :window="usage.sevenDay" compact />
            <UsageMeter v-for="window in usage.scoped" :key="window.key" :window="window" compact />
            <div v-if="extra" class="flex flex-col gap-1.5">
              <div class="flex items-baseline justify-between gap-3 text-xs">
                <span class="font-medium">Extra Usage</span>
                <span class="text-muted-foreground tabular-nums">
                  {{ extra.usedCredits !== null ? currency.format(extra.usedCredits) : '–' }}
                  <template v-if="extra.monthlyLimit !== null"> / {{ currency.format(extra.monthlyLimit) }}</template>
                </span>
              </div>
              <Progress
                v-if="extra.percent !== null"
                :model-value="Math.min(100, extra.percent)"
                :class="cn('h-1', usageFillClass[usageLevel(extra.percent)])"
              />
            </div>
            <p v-if="problem" class="flex items-start gap-2 text-xs text-muted-foreground">
              <CircleAlertIcon class="mt-px size-3.5 shrink-0" />
              <span>{{ problem }}</span>
            </p>
          </div>

          <Separator class="mt-1" />
          <div class="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-3 text-xs text-muted-foreground">
            <span class="truncate">
              Stand {{ formatRelative(usage.fetchedAt, now) }}
              <template v-if="usage.source === 'claude-cache'"> · aus Claude-Code-Cache</template>
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Usage aktualisieren"
              :disabled="usageStore.refreshing"
              @click="refresh"
            >
              <Spinner v-if="usageStore.refreshing" />
              <RefreshCwIcon v-else />
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  </Transition>
</template>
