<script setup lang="ts">
import {
  BellIcon,
  BellOffIcon,
  Columns2Icon,
  FolderIcon,
  FolderOpenIcon,
  GaugeIcon,
  GlobeIcon,
  HistoryIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows2Icon,
  SettingsIcon,
  SparklesIcon,
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
import { SETTINGS_TAB_ICONS } from '@/components/settings/settings-tabs'
import BrowserFavicon from '@/components/terminal/BrowserFavicon.vue'
import { useLauncher } from '@/composables/useLauncher'
import { useRecentFolders } from '@/composables/useRecentFolders'
import { SETTINGS } from '@/composables/useSettingsSearch'
import { formatRelative, shortenPath } from '@/lib/format'
import { attempt } from '@/lib/errors'
import type { SettingsEntry } from '@/lib/settings-index'
import { NOTIFICATIONS_ROUTE, UPDATES_ROUTE } from '@/router'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useUsageStore } from '@/stores/usage'
import AccountDot from './AccountDot.vue'

const ui = useUiStore()
const router = useRouter()
const app = useAppStore()
const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const sessions = useSessionsStore()
const usage = useUsageStore()
const settings = useSettingsStore()
const launcher = useLauncher()
const recent = useRecentFolders(8)

const recentSessions = computed(() =>
  sessions.groups
    .flatMap((g) => g.sessions)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12),
)

watch(
  () => ui.paletteOpen,
  (open) => {
    if (open) recent.load()
  },
)

/** Close the palette first so focus returns to the app before the action runs. */
function run(action: () => unknown) {
  ui.paletteOpen = false
  void action()
}

const notificationsOn = computed(() => settings.settings.notifications.enabled)
function toggleNotifications() {
  return attempt(
    () => settings.update({ notifications: { enabled: !notificationsOn.value } }),
    'Benachrichtigungen konnten nicht umgeschaltet werden',
  )
}

function switchTo(id: string) {
  terminals.activate(id)
  void router.push({ name: 'terminals' })
}

/** The settings page scrolls there and gives a row's control the keyboard, which the closing palette mustn't take back. */
let keepFocus = false
function openSetting(entry: SettingsEntry) {
  keepFocus = entry.kind === 'field'
  return router.push({ name: 'settings', query: { tab: entry.tab, setting: entry.id } })
}
function onCloseAutoFocus(event: Event) {
  if (!keepFocus) return
  keepFocus = false
  event.preventDefault()
}
</script>

<template>
  <CommandDialog
    v-model:open="ui.paletteOpen"
    title="Befehlspalette"
    description="Aktion, Tab, Session oder Einstellung suchen"
    class="sm:max-w-xl"
    @close-auto-focus="onCloseAutoFocus"
  >
    <CommandInput placeholder="Aktion, Tab, Session oder Einstellung suchen…" />
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
        <CommandItem value="browser" @select="run(() => launcher.browser())">
          <GlobeIcon />
          Browser öffnen
        </CommandItem>
        <template v-if="terminals.active">
          <CommandItem
            value="browser-beside"
            @select="run(() => launcher.browser(null, { terminalId: terminals.active!.id, direction: 'row' }))"
          >
            <GlobeIcon />
            Browser daneben öffnen
          </CommandItem>
          <CommandItem value="split-right" @select="run(() => launcher.split(terminals.active!, 'row'))">
            <Columns2Icon />
            Vertikal teilen
            <CommandShortcut>Alt+Umschalt+Plus</CommandShortcut>
          </CommandItem>
          <CommandItem value="split-down" @select="run(() => launcher.split(terminals.active!, 'column'))">
            <Rows2Icon />
            Horizontal teilen
            <CommandShortcut>Alt+Umschalt+Minus</CommandShortcut>
          </CommandItem>
        </template>
        <CommandItem value="refresh-usage" @select="run(() => usage.refresh())">
          <RefreshCwIcon />
          Usage aktualisieren
        </CommandItem>
        <CommandItem value="toggle-notifications" @select="run(toggleNotifications)">
          <BellOffIcon v-if="notificationsOn" />
          <BellIcon v-else />
          {{ notificationsOn ? 'Benachrichtigungen ausschalten' : 'Benachrichtigungen einschalten' }}
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />
      <CommandGroup heading="Navigation">
        <CommandItem value="go-terminals" @select="run(() => router.push({ name: 'terminals' }))">
          <SquareTerminalIcon />
          Terminals
        </CommandItem>
        <CommandItem value="go-dashboard" @select="run(() => router.push({ name: 'dashboard' }))">
          <GaugeIcon />
          Usage-Dashboard
        </CommandItem>
        <CommandItem value="go-sessions" @select="run(() => router.push({ name: 'sessions' }))">
          <HistoryIcon />
          Sessions
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
        <CommandItem value="go-notifications" @select="run(() => router.push(NOTIFICATIONS_ROUTE))">
          <BellIcon />
          Benachrichtigungs-Einstellungen
        </CommandItem>
        <CommandItem value="go-updates" @select="run(() => router.push(UPDATES_ROUTE))">
          <SparklesIcon />
          Updates und Versionshinweise
        </CommandItem>
      </CommandGroup>

      <!-- Every card and row of the settings, only while searching: too many to list otherwise. -->
      <CommandGroup heading="Einstellungen" search-only>
        <CommandItem
          v-for="entry in SETTINGS"
          :key="entry.id"
          :value="`setting-${entry.id}`"
          :filter-text="entry.text"
          search-only
          @select="run(() => openSetting(entry))"
        >
          <component :is="SETTINGS_TAB_ICONS[entry.tab]" />
          <span class="min-w-0 truncate">{{ entry.label }}</span>
          <CommandShortcut class="max-w-[50%] truncate tracking-normal">{{ entry.path.join(' › ') }}</CommandShortcut>
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

      <template v-if="recent.folders.value.length">
        <CommandSeparator />
        <CommandGroup heading="Zuletzt genutzte Ordner">
          <CommandItem
            v-for="folder in recent.folders.value"
            :key="folder.path"
            :value="`folder-${folder.path}`"
            @select="run(() => launcher.newSession(undefined, folder.path))"
          >
            <FolderIcon />
            <span class="min-w-0 truncate">Neue Session in {{ folder.name }}</span>
            <CommandShortcut class="max-w-[45%] truncate tracking-normal">
              {{ folder.parent && shortenPath(folder.parent, app.info?.homeDir) }}
            </CommandShortcut>
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
            <BrowserFavicon v-if="terminal.mode === 'browser'" :terminal-id="terminal.id" class="size-4" />
            <AccountDot v-else :color="accounts.get(terminal.authAccountId)?.color" />
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
