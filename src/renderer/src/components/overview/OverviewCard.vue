<script setup lang="ts">
import { BotIcon, CircleStopIcon, MessageCircleQuestionIcon, ShieldQuestionIcon, ShrinkIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { TerminalInfo } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import UsageRing from '@/components/common/UsageRing.vue'
import { Spinner } from '@/components/ui/spinner'
import { activityDuration, activityLabel } from '@/lib/activity'
import { contextGauge, modelName, shortTokens } from '@/lib/context'
import { formatRelative, formatReset } from '@/lib/format'
import { overviewState } from '@/lib/overview'
import { clampPercent, limitLabel, usageLevel, usageTextClass } from '@/lib/usage'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'
import { useUsageStore } from '@/stores/usage'

/**
 * A tab in the overview: where it runs, what Claude does or waits for, the beginning of the last
 * answer and prompt, how full the context is and the account's 5-hour limit. A click goes to the tab.
 */
const props = defineProps<{ terminal: TerminalInfo; now: number }>()
const emit = defineEmits<{ open: [] }>()

const accounts = useAccountsStore()
const usageStore = useUsageStore()

const state = computed(() => overviewState(props.terminal))
const account = computed(() => accounts.get(props.terminal.authAccountId))
const folder = computed(() => props.terminal.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? props.terminal.cwd)
const model = computed(() => modelName(props.terminal.context?.model ?? null))
const session = computed(() => props.terminal.mode === 'session')

/** What Claude waits for: a permission, a question, a plan, or the reset of a limit. */
const waiting = computed(() => {
  if (state.value !== 'waiting') return null
  const { limit, turn } = props.terminal
  if (limit) {
    return {
      icon: TriangleAlertIcon,
      title: `${limitLabel(limit.type)} erreicht`,
      detail: limit.resetsAt ? `Reset ${formatReset(limit.resetsAt, props.now)}` : limit.message,
      code: false,
    }
  }
  const tool = turn?.tool ?? null
  if (tool === 'AskUserQuestion') return { icon: MessageCircleQuestionIcon, title: 'Claude hat eine Frage', detail: turn?.detail ?? null, code: false }
  if (tool === 'ExitPlanMode') {
    return { icon: MessageCircleQuestionIcon, title: 'Claude wartet auf die Freigabe des Plans', detail: turn?.detail ?? null, code: false }
  }
  return {
    icon: ShieldQuestionIcon,
    title: tool ? `Claude braucht deine Erlaubnis für ${tool}` : 'Claude braucht deine Erlaubnis',
    detail: turn?.detail ?? null,
    code: tool === 'Bash' || tool === 'PowerShell',
  }
})

/** What runs: the tool the hooks tell, otherwise just that Claude works. */
const working = computed(() => {
  if (state.value !== 'working') return null
  const { activity, subagents, compacting } = props.terminal
  const extra = [compacting ? 'fasst den Verlauf zusammen' : null, subagents ? `${subagents} Subagent${subagents === 1 ? '' : 's'}` : null]
  if (activity) {
    const { label, detail } = activityLabel(activity)
    return { label, detail, duration: activityDuration(activity.since, props.now), extra: extra.filter(Boolean).join(' · ') }
  }
  return { label: compacting ? 'Fasst den Verlauf zusammen' : 'Claude arbeitet', detail: null, duration: null, extra: extra[1] ?? '' }
})

const idleText = computed(() => {
  const { mode, turn, exitCode, status } = props.terminal
  if (status === 'exited') return exitCode === null ? 'Beendet' : `Beendet mit Code ${exitCode}`
  if (mode === 'shell') return 'Shell'
  if (mode === 'login') return 'Anmeldung bei Claude'
  return turn?.detail ?? (turn ? 'Fertig' : 'Bereit für den ersten Prompt')
})

const context = computed(() => {
  const { context } = props.terminal
  if (!session.value || !context || context.tokens === null || state.value === 'ended') return null
  const gauge = contextGauge(context)
  return {
    percent: Math.round(gauge.percent),
    level: usageLevel(gauge.percent),
    label: `Kontext: ${shortTokens(context.tokens)} von ${shortTokens(gauge.limit)}`,
  }
})

const limit = computed(() => {
  if (!session.value || state.value === 'ended') return null
  const window = account.value ? usageStore.byAccount.get(account.value.id)?.fiveHour : null
  return window ? { percent: clampPercent(window.percent), label: `5-Stunden-Limit von ${account.value!.name}: ${clampPercent(window.percent)} %` } : null
})

const ended = computed(() => (props.terminal.turn ? formatRelative(props.terminal.turn.at, props.now) : null))
</script>

<template>
  <button
    type="button"
    :class="
      cn(
        'group flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border bg-card p-4 text-left text-card-foreground transition-colors outline-none hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        state === 'waiting' && 'border-warning/50 hover:border-warning',
        state === 'ended' && 'opacity-70',
      )
    "
    @click="emit('open')"
  >
    <div class="flex min-w-0 items-start gap-2.5">
      <AccountDot :color="account?.color" class="mt-1.5" />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-medium">{{ terminal.title }}</span>
        <span class="truncate text-xs text-muted-foreground">
          {{ folder }}<template v-if="model"> · {{ model }}</template>
        </span>
      </div>
      <span
        v-if="terminal.attention && state !== 'waiting'"
        class="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
        v-tooltip="'Noch nicht angesehen'"
      />
    </div>

    <div class="flex min-h-[3.75rem] min-w-0 flex-col gap-1 text-sm">
      <template v-if="waiting">
        <span class="flex items-center gap-1.5 font-medium text-warning">
          <component :is="waiting.icon" class="size-4 shrink-0" />
          <span class="truncate">{{ waiting.title }}</span>
        </span>
        <span
          v-if="waiting.detail"
          :class="cn('line-clamp-2 text-xs break-words text-muted-foreground', waiting.code && 'font-mono')"
        >
          {{ waiting.detail }}
        </span>
      </template>
      <template v-else-if="working">
        <span class="flex min-w-0 items-center gap-1.5 font-medium">
          <Spinner class="size-3.5 shrink-0 text-primary" />
          <span class="truncate">{{ working.label }}</span>
          <span v-if="working.duration" class="shrink-0 text-xs font-normal text-muted-foreground">{{ working.duration }}</span>
        </span>
        <span v-if="working.detail" class="truncate font-mono text-xs text-muted-foreground">{{ working.detail }}</span>
        <span v-if="working.extra" class="flex items-center gap-1 text-xs text-muted-foreground">
          <BotIcon v-if="terminal.subagents" class="size-3.5" />
          <ShrinkIcon v-else class="size-3.5" />
          {{ working.extra }}
        </span>
      </template>
      <template v-else>
        <span :class="cn('line-clamp-3 break-words', terminal.turn?.detail ? 'text-foreground/90' : 'text-muted-foreground')">
          <CircleStopIcon v-if="state === 'ended'" class="mr-1 inline size-3.5 align-[-2px]" />
          {{ idleText }}
        </span>
      </template>
    </div>

    <p v-if="terminal.prompt" class="truncate text-xs text-muted-foreground">
      <span class="font-medium text-foreground/70">Du:</span>
      {{ terminal.prompt }}
    </p>

    <div v-if="context || limit || ended" class="mt-auto flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
      <span v-if="context" class="flex items-center gap-1.5" v-tooltip="context.label">
        <!-- Green, orange, red like the gauge in the title bar. -->
        <span class="h-1.5 w-12 overflow-hidden rounded-full bg-foreground/15">
          <span :class="cn('block h-full rounded-full bg-current', usageTextClass[context.level])" :style="{ width: `${context.percent}%` }" />
        </span>
        <span class="tabular-nums">{{ context.percent }} %</span>
      </span>
      <span v-if="limit" class="flex items-center gap-1" v-tooltip="limit.label">
        <UsageRing :percent="limit.percent" :size="14" />
        <span class="tabular-nums">{{ limit.percent }} %</span>
      </span>
      <span v-if="ended" class="ml-auto shrink-0">{{ ended }}</span>
    </div>
  </button>
</template>
