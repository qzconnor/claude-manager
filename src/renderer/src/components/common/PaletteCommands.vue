<script setup lang="ts">
import {
  BellIcon,
  BellOffIcon,
  Columns2Icon,
  FilesIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows2Icon,
  SparklesIcon,
  SquareTerminalIcon,
  XIcon,
} from '@lucide/vue'
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { SETTINGS_TAB_ICONS } from '@/components/settings/settings-tabs'
import BrowserFavicon from '@/components/terminal/BrowserFavicon.vue'
import { useFileTreeToggle } from '@/composables/useFileTreeToggle'
import { useLauncher } from '@/composables/useLauncher'
import { useRecentFolders } from '@/composables/useRecentFolders'
import { SETTINGS } from '@/composables/useSettingsSearch'
import { useTerminalActions } from '@/composables/useTerminalActions'
import { attempt } from '@/lib/errors'
import { formatRelative, shortenPath } from '@/lib/format'
import { PAGE_INFO } from '@/lib/pages'
import type { SettingsEntry } from '@/lib/settings-index'
import { BROWSER_TAB, PAGES } from '@/lib/workspace'
import { NOTIFICATIONS_ROUTE, UPDATES_ROUTE } from '@/router'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUsageStore } from '@/stores/usage'
import AccountDot from './AccountDot.vue'
import PaletteInput from './PaletteInput.vue'

/** The commands mode of the quick open (`>`), like VS Code's command palette. */
const query = defineModel<string>('query', { required: true })
/** `keepFocus`: the action put the keyboard somewhere the closing dialog mustn't take it from. */
const emit = defineEmits<{ done: [keepFocus: boolean] }>()

const router = useRouter()
const app = useAppStore()
const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const sessions = useSessionsStore()
const usage = useUsageStore()
const settings = useSettingsStore()
const launcher = useLauncher()
const { closeGroup } = useTerminalActions()
const recent = useRecentFolders(8)
const fileTree = useFileTreeToggle()
/** The tree the command opens or closes, if the tab has one. */
const treeTarget = computed(() => fileTree.focusedTarget.value)

onMounted(() => recent.load())

const recentSessions = computed(() =>
  sessions.groups
    .flatMap((g) => g.sessions)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12),
)

/** Closes the quick open first so focus returns to the app before the action runs. */
function run(action: () => unknown, keepFocus = false) {
  emit('done', keepFocus)
  void action()
}

const notificationsOn = computed(() => settings.settings.notifications.enabled)
function toggleNotifications() {
  return attempt(
    () => settings.update({ notifications: { enabled: !notificationsOn.value } }),
    'Benachrichtigungen konnten nicht umgeschaltet werden',
  )
}

/** Shows a terminal's tab; in groups the route follows it by itself. */
function switchTo(id: string) {
  terminals.activate(id)
  if (router.currentRoute.value.name !== 'terminals') void router.push({ name: 'terminals' })
}

/** The settings page scrolls there and gives a row's control the keyboard. */
function openSetting(entry: SettingsEntry) {
  run(() => router.push({ name: 'settings', query: { tab: entry.tab, setting: entry.id } }), entry.kind === 'field')
}

/** The group with the keyboard, with the tabs in groups. */
const group = computed(() => (terminals.grouped ? terminals.activeGroup : null))
const canMoveTab = computed(() => !!group.value && group.value.tabs.length > 1 && !!terminals.focusedTab)
/** The browser tab has the keyboard, or shows the pages of the session with it: close it rather than open it. */
const closesBrowser = computed(
  () => terminals.focusedTab === BROWSER_TAB || terminals.browserShownFor(terminals.sessionFor(terminals.active)?.id),
)
</script>

<template>
  <Command class="rounded-none! p-0">
    <PaletteInput v-model="query" placeholder="Befehl eingeben…" hint="Strg+Umschalt+P" />
    <CommandList class="max-h-[min(30rem,calc(80vh-6rem))] p-1.5">
      <CommandEmpty>Kein Befehl passt.</CommandEmpty>

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
        <CommandItem
          value="new-session-worktree"
          filter-text="Neue Session in Worktree git branch parallel"
          @select="run(() => launcher.newSessionInWorktree(null, terminals.workingTerminal?.cwd || null))"
        >
          <FolderGit2Icon />
          Neue Session in Worktree…
        </CommandItem>
        <!-- In groups a browser always belongs to a session: the browser tab with the one with the keyboard. -->
        <CommandItem v-if="!terminals.grouped" value="browser" @select="run(() => launcher.browser())">
          <GlobeIcon />
          Browser öffnen
        </CommandItem>
        <CommandItem v-if="terminals.grouped && closesBrowser" value="browser-close" filter-text="Browser schließen Tab" @select="run(() => terminals.closeBrowserTab())">
          <XIcon />
          Browser schließen
        </CommandItem>
        <CommandItem v-else-if="terminals.grouped && terminals.sessionFor(terminals.active)" value="browser-beside" @select="run(() => launcher.browserFor(terminals.active))">
          <GlobeIcon />
          Browser öffnen
        </CommandItem>
        <template v-else-if="!terminals.grouped && terminals.active">
          <CommandItem
            value="browser-beside"
            @select="run(() => launcher.browser(null, { terminalId: terminals.active!.id, direction: 'row' }))"
          >
            <GlobeIcon />
            Browser daneben öffnen
          </CommandItem>
        </template>
        <template v-if="terminals.grouped">
          <CommandItem value="split-right" filter-text="Neue Session rechts teilen vertikal split Gruppe" @select="run(() => launcher.splitActive('row'))">
            <Columns2Icon />
            Neue Session rechts
            <CommandShortcut>Alt+Umschalt+Plus</CommandShortcut>
          </CommandItem>
          <CommandItem value="split-down" filter-text="Neue Session unten teilen horizontal split Gruppe" @select="run(() => launcher.splitActive('column'))">
            <Rows2Icon />
            Neue Session unten
            <CommandShortcut>Alt+Umschalt+Minus</CommandShortcut>
          </CommandItem>
        </template>
        <template v-else-if="terminals.active">
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
        <CommandItem
          v-if="canMoveTab"
          value="move-tab-right"
          filter-text="Tab in Gruppe rechts verschieben teilen"
          @select="run(() => terminals.dropTab(terminals.focusedTab!, group!.id, 'right'))"
        >
          <PanelRightIcon />
          Tab in Gruppe rechts verschieben
        </CommandItem>
        <CommandItem
          v-if="treeTarget"
          value="toggle-file-tree"
          filter-text="Dateibaum ein- ausblenden Dateien Explorer Ordner Tree"
          @select="run(() => fileTree.toggle(treeTarget))"
        >
          <FilesIcon />
          {{ fileTree.shown(treeTarget) ? 'Dateibaum schließen' : 'Dateibaum öffnen' }}
          <CommandShortcut>Strg+Umschalt+E</CommandShortcut>
        </CommandItem>
        <CommandItem v-if="group && terminals.groups.length > 1" value="close-group" @select="run(() => closeGroup(group!.id))">
          <XIcon />
          Gruppe schließen
        </CommandItem>
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
      <!-- In groups the pages open as tabs; in one tab bar the terminals are a page of their own. -->
      <CommandGroup :heading="terminals.grouped ? 'Seiten öffnen' : 'Navigation'">
        <CommandItem v-if="!terminals.grouped" value="go-terminals" @select="run(() => router.push({ name: 'terminals' }))">
          <SquareTerminalIcon />
          Terminals
        </CommandItem>
        <CommandItem
          v-for="page in PAGES"
          :key="page"
          :value="`go-${page}`"
          @select="run(() => router.push({ name: page }))"
        >
          <component :is="PAGE_INFO[page].icon" />
          {{ PAGE_INFO[page].label }}
          <CommandShortcut v-if="PAGE_INFO[page].shortcut">{{ PAGE_INFO[page].shortcut }}</CommandShortcut>
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
          @select="openSetting(entry)"
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
  </Command>
</template>
