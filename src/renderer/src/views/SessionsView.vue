<script setup lang="ts">
import { HistoryIcon, RefreshCwIcon, SearchIcon } from '@lucide/vue'
import { refDebounced } from '@vueuse/core'
import { computed, onActivated, onMounted, ref } from 'vue'
import type { SessionSummary } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import SessionDetailPanel from '@/components/sessions/SessionDetailPanel.vue'
import SessionGroupSection from '@/components/sessions/SessionGroupSection.vue'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionDetail, type SessionRef } from '@/composables/useSessionDetail'
import { attempt } from '@/lib/errors'
import { useAccountsStore } from '@/stores/accounts'
import { useSessionsStore } from '@/stores/sessions'
import { useClock } from '@/composables/useClock'

const sessions = useSessionsStore()
const accounts = useAccountsStore()
const now = useClock(60_000)

const search = ref('')
const query = refDebounced(search, 150)
const accountFilter = ref('all')
const selected = ref<SessionRef | null>(null)
const { detail, summary, loading, error } = useSessionDetail(selected)

function matches(session: SessionSummary, needle: string): boolean {
  if (!needle) return true
  return [session.title, session.firstPrompt, session.lastPrompt, session.cwd, session.gitBranch, session.id].some((v) =>
    v?.toLowerCase().includes(needle),
  )
}

const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  // Keep the account order of the accounts page.
  const order = new Map(accounts.accounts.map((a, i) => [a.id, i]))
  return sessions.groups
    .filter((g) => accountFilter.value === 'all' || g.accountId === accountFilter.value)
    .map((g) => ({ ...g, sessions: g.sessions.filter((s) => matches(s, needle)) }))
    .filter((g) => !needle || g.sessions.length > 0)
    .sort((a, b) => (order.get(a.accountId) ?? 99) - (order.get(b.accountId) ?? 99))
})

const total = computed(() => groups.value.reduce((sum, g) => sum + g.sessions.length, 0))

function select(session: SessionSummary) {
  selected.value = { accountId: session.accountId, sessionId: session.id }
}

const load = () => attempt(() => sessions.load(), 'Sessions konnten nicht geladen werden')
onMounted(load)
onActivated(() => {
  if (!sessions.loaded) void load()
})
</script>

<template>
  <div class="flex size-full min-h-0">
    <aside class="flex w-96 shrink-0 flex-col border-r">
      <div class="flex flex-col gap-2 border-b p-3">
        <div class="flex items-center gap-2">
          <InputGroup class="flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput v-model="search" placeholder="Sessions durchsuchen…" spellcheck="false" />
          </InputGroup>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon-sm" aria-label="Neu einlesen" :disabled="sessions.loading" @click="load">
                <Spinner v-if="sessions.loading" />
                <RefreshCwIcon v-else />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Neu einlesen</TooltipContent>
          </Tooltip>
        </div>
        <div class="flex items-center justify-between gap-2">
          <Select v-model="accountFilter">
            <SelectTrigger size="sm" class="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Alle Accounts</SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectItem v-for="account in accounts.accounts" :key="account.id" :value="account.id">
                  <AccountDot :color="account.color" />
                  {{ account.name }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ total }} Sessions</span>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <div v-if="!sessions.loaded" class="flex flex-col gap-3 p-2">
          <Skeleton v-for="i in 8" :key="i" class="h-12 w-full" />
        </div>
        <div v-else class="flex flex-col gap-3">
          <SessionGroupSection
            v-for="group in groups"
            :key="group.accountId"
            :account-id="group.accountId"
            :sessions="group.sessions"
            :error="group.error"
            :selected="selected"
            :now="now"
            @select="select"
          />
          <p v-if="query && total === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
            Keine Session passt zu „{{ query }}“.
          </p>
        </div>
      </div>
    </aside>

    <section class="min-w-0 flex-1">
      <SessionDetailPanel v-if="summary" :summary="summary" :detail="detail" :loading="loading" :error="error" />
      <Empty v-else class="size-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>Session auswählen</EmptyTitle>
          <EmptyDescription>
            Wähle links eine Session, um den Verlauf zu lesen. Doppelklick setzt sie direkt in einem neuen Tab fort.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  </div>
</template>
