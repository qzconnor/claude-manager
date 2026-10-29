<script setup lang="ts">
import {
  FolderOpenIcon,
  GaugeIcon,
  HistoryIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  SquareTerminalIcon,
  UsersIcon,
} from '@lucide/vue'
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { useLauncher } from '@/composables/useLauncher'
import { formatRelative } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'
import { useSessionsStore } from '@/stores/sessions'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useUsageStore } from '@/stores/usage'
import AccountDot from './AccountDot.vue'

const ui = useUiStore()
const router = useRouter()
const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const sessions = useSessionsStore()
const usage = useUsageStore()
const launcher = useLauncher()

const recentSessions = computed(() =>
  sessions.groups
    .flatMap((g) => g.sessions)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12),
)

watch(
  () => ui.paletteOpen,
  (open) => {
    if (open && !sessions.loaded) void sessions.load()
  },
)

/** Close the palette first so focus returns to the app before the action runs. */
function run(action: () => unknown) {
  ui.paletteOpen = false
  void action()
}

function switchTo(id: string) {
  terminals.activate(id)
  void router.push({ name: 'terminals' })
}
</script>

<template>
  <CommandDialog
    v-model:open="ui.paletteOpen"
    title="Befehlspalette"
    description="Aktion, Tab oder Session suchen"
    class="sm:max-w-xl"
  >
    <CommandInput placeholder="Aktion, Tab oder Session suchen…" />
    <!-- The dialog starts at 1/3 of the window height, so the list may use the rest minus the input. -->
    <CommandList class="max-h-[min(26rem,calc(66vh_-_5rem))]">
      <CommandEmpty>Keine Treffer.</CommandEmpty>

      <CommandGroup heading="Aktionen">
        <CommandItem value="new-session" @select="run(() => launcher.newSession())">
          <PlusIcon />
          Neue Session
          <CommandShortcut>Strg+Umschalt+T</CommandShortcut>
        </CommandItem>
        <CommandItem value="new-session-folder" @select="run(() => launcher.newSessionInFolder())">
          <FolderOpenIcon />
          Neue Session in Ordner…
        </CommandItem>
        <CommandItem value="refresh-usage" @select="run(() => usage.refresh())">
          <RefreshCwIcon />
          Usage aktualisieren
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />
      <CommandGroup heading="Navigation">
        <CommandItem value="go-terminals" @select="run(() => router.push({ name: 'terminals' }))">
          <SquareTerminalIcon />
          Terminals
        </CommandItem>
        <CommandItem value="go-sessions" @select="run(() => router.push({ name: 'sessions' }))">
          <HistoryIcon />
          Sessions
        </CommandItem>
        <CommandItem value="go-dashboard" @select="run(() => router.push({ name: 'dashboard' }))">
          <GaugeIcon />
          Usage-Dashboard
        </CommandItem>
        <CommandItem value="go-accounts" @select="run(() => router.push({ name: 'accounts' }))">
          <UsersIcon />
          Accounts
        </CommandItem>
        <CommandItem value="go-settings" @select="run(() => router.push({ name: 'settings' }))">
          <SettingsIcon />
          Einstellungen
          <CommandShortcut>Strg+,</CommandShortcut>
        </CommandItem>
      </CommandGroup>

      <template v-if="accounts.accounts.length > 1">
        <CommandSeparator />
        <CommandGroup heading="Neue Session mit Account">
          <CommandItem
            v-for="account in accounts.accounts"
            :key="account.id"
            :value="`account-${account.id}`"
            @select="run(() => launcher.newSession(account.id))"
          >
            <AccountDot :color="account.color" />
            Neue Session · {{ account.name }}
          </CommandItem>
        </CommandGroup>
      </template>

      <template v-if="terminals.terminals.length">
        <CommandSeparator />
        <CommandGroup heading="Offene Tabs">
          <CommandItem
            v-for="terminal in terminals.terminals"
            :key="terminal.id"
            :value="`tab-${terminal.id}`"
            @select="run(() => switchTo(terminal.id))"
          >
            <AccountDot :color="accounts.get(terminal.authAccountId)?.color" />
            <span class="truncate">{{ terminal.title }}</span>
          </CommandItem>
        </CommandGroup>
      </template>

      <template v-if="recentSessions.length">
        <CommandSeparator />
        <CommandGroup heading="Letzte Sessions fortsetzen">
          <CommandItem
            v-for="session in recentSessions"
            :key="`${session.accountId}:${session.id}`"
            :value="`session-${session.accountId}-${session.id}`"
            @select="run(() => launcher.resume(session))"
          >
            <AccountDot :color="accounts.get(session.accountId)?.color" />
            <span class="truncate">{{ session.title }}</span>
            <CommandShortcut>{{ formatRelative(session.updatedAt) }}</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </template>
    </CommandList>
  </CommandDialog>
</template>
