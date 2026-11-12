<script setup lang="ts">
import { CircleAlertIcon, RefreshCwIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import type { Account, AccountUsage } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import AccountIdentityLine from '@/components/common/AccountIdentityLine.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { attempt } from '@/lib/errors'
import { accountKindLabel, formatRelative, formatUpcoming, planLabel } from '@/lib/format'
import { usageFillClass, usageLevel } from '@/lib/usage'
import type { HistoryKind } from '@/lib/usage-history'
import { cn } from '@/lib/utils'
import { useUsageStore } from '@/stores/usage'
import UsageHistoryChart from './UsageHistoryChart.vue'
import UsageMeter from './UsageMeter.vue'
import { useClock } from '@/composables/useClock'

const props = defineProps<{ account: Account; usage: AccountUsage | undefined }>()

const usageStore = useUsageStore()
const now = useClock(30_000)

const plan = computed(() => planLabel(props.account.identity.subscriptionType))
const hasLimits = computed(() => !!(props.usage?.fiveHour || props.usage?.sevenDay || props.usage?.scoped.length))
const sourceLabel = computed(() => {
  switch (props.usage?.source) {
    case 'live':
      return 'Live'
    case 'claude-cache':
      return 'Claude-Code-Cache'
    default:
      return null
  }
})
const problem = computed(() => {
  const u = props.usage
  if (!u || u.status === 'ok') return null
  return u.message
})
const extra = computed(() => props.usage?.extra ?? null)
const currency = computed(
  () => new Intl.NumberFormat('de', { style: 'currency', currency: extra.value?.currency || 'USD', maximumFractionDigits: 2 }),
)

const historyKind = ref<HistoryKind>('five_hour')
const historyKinds = [
  { value: 'five_hour', label: '5 Std.' },
  { value: 'seven_day', label: 'Woche' },
] as const
const history = computed(() => usageStore.histories[props.account.id] ?? null)
const historyReadings = computed(() => (historyKind.value === 'five_hour' ? history.value?.fiveHour : history.value?.sevenDay) ?? [])
const historyWindow = computed(() => (historyKind.value === 'five_hour' ? props.usage?.fiveHour : props.usage?.sevenDay) ?? null)
/** The curves show once there is anything to show: accounts without limits (API keys, setup tokens) have none. */
const hasHistory = computed(() => Boolean(history.value?.fiveHour.length || history.value?.sevenDay.length))

// Each new reading of the limits adds to the curves.
watch(
  () => props.usage?.fetchedAt,
  () => void usageStore.loadHistory(props.account.id),
  { immediate: true },
)

function refresh() {
  void attempt(() => usageStore.refresh(props.account.id), 'Aktualisieren fehlgeschlagen')
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex min-w-0 items-center gap-2">
        <AccountDot :color="account.color" class="size-2.5" />
        <span class="truncate">{{ account.name }}</span>
        <Badge v-if="plan" variant="secondary">{{ plan }}</Badge>
      </CardTitle>
      <CardDescription class="min-w-0">
        <AccountIdentityLine :identity="account.identity" :fallback="accountKindLabel(account.kind)" />
      </CardDescription>
      <CardAction class="flex items-center gap-1">
        <Badge v-if="sourceLabel" variant="outline">{{ sourceLabel }}</Badge>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Usage aktualisieren"
              :disabled="usageStore.isRefreshing(account.id)"
              @click="refresh"
            >
              <Spinner v-if="usageStore.isRefreshing(account.id)" />
              <RefreshCwIcon v-else />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Jetzt abrufen (höchstens einmal pro Minute)</TooltipContent>
        </Tooltip>
      </CardAction>
    </CardHeader>

    <CardContent class="flex flex-col gap-5">
      <template v-if="hasLimits && usage">
        <div class="grid gap-5 sm:grid-cols-2">
          <UsageMeter v-if="usage.fiveHour" :window="usage.fiveHour" />
          <UsageMeter v-if="usage.sevenDay" :window="usage.sevenDay" />
        </div>
        <template v-if="usage.scoped.length">
          <Separator />
          <div class="grid gap-4 sm:grid-cols-2">
            <UsageMeter v-for="window in usage.scoped" :key="window.key" :window="window" compact />
          </div>
        </template>
      </template>

      <template v-if="hasHistory">
        <Separator />
        <section class="flex flex-col gap-2" :aria-label="`Verlauf von ${account.name}`">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium">Verlauf</span>
            <SegmentedControl v-model="historyKind" :options="historyKinds" size="sm" />
          </div>
          <UsageHistoryChart :readings="historyReadings" :window="historyWindow" :kind="historyKind" :now="now" />
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span class="flex items-center gap-1.5">
              <span class="w-3 border-t-2" style="border-color: var(--chart-1)" />
              Ausgelastet
            </span>
            <span class="flex items-center gap-1.5">
              <span class="w-3 border-t-2 border-dashed" style="border-color: var(--chart-1)" />
              Prognose
            </span>
            <span class="flex items-center gap-1.5">
              <span class="h-3 border-l border-muted-foreground/45" />
              Reset
            </span>
          </div>
        </section>
      </template>

      <div v-if="extra?.enabled" class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between text-xs">
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
      <p v-else-if="!hasLimits" class="text-xs text-muted-foreground">Noch keine Limit-Daten vorhanden.</p>
    </CardContent>

    <CardFooter class="mt-auto justify-between gap-2 text-xs text-muted-foreground">
      <span>Stand: {{ usage?.fetchedAt ? formatRelative(usage.fetchedAt, now) : '–' }}</span>
      <span v-if="usage?.nextRefreshAt && Date.parse(usage.nextRefreshAt) > now">
        nächster Abruf {{ formatUpcoming(usage.nextRefreshAt, now) }}
      </span>
    </CardFooter>
  </Card>
</template>
