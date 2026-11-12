<script setup lang="ts">
import {
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayersIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from '@lucide/vue'
import { injectDropdownMenuRootContext } from 'reka-ui'
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import AccountDot from '@/components/common/AccountDot.vue'
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useLauncher } from '@/composables/useLauncher'
import { useRecentFolders } from '@/composables/useRecentFolders'
import { tabSetTabLabel } from '@shared/tab-sets'
import { formatRelative, shortenPath } from '@/lib/format'
import { shellLabel } from '@/lib/platform'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useTabSetsStore } from '@/stores/tab-sets'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/** Folders the menu offers to start in right away. */
const RECENT_FOLDERS = 6

// The menu behind the new-session chevron; side and alignment fall through to the content.
const router = useRouter()
const app = useAppStore()
const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const tabSets = useTabSetsStore()
const ui = useUiStore()
const launcher = useLauncher()
const root = injectDropdownMenuRootContext()
const recent = useRecentFolders(RECENT_FOLDERS)

watch(root.open, (open) => {
  if (open) recent.load()
})

/** Token / API-key accounts can't use `claude auth login`. */
const loginAccounts = computed(() => accounts.accounts.filter((a) => a.kind === 'oauth' || a.kind === 'system'))

/**
 * A folder is a submenu with the other accounts and the shell, but a click (or Enter) on it starts a
 * session there with the standard account right away. Runs in the capture phase, before the trigger
 * opens its submenu: `preventDefault` stops that for clicks, keys need stopping outright.
 */
function startIn(event: Event, path: string) {
  event.preventDefault()
  event.stopImmediatePropagation()
  root.onOpenChange(false)
  void launcher.newSession(undefined, path)
}

function onFolderKey(event: KeyboardEvent, path: string) {
  if (event.key === 'Enter' || event.key === ' ') startIn(event, path)
}

/** Like a folder: a click (or Enter) on a tab set opens it, its submenu has the rest. */
function openSet(event: Event, id: string) {
  event.preventDefault()
  event.stopImmediatePropagation()
  root.onOpenChange(false)
  void tabSets.open(id)
}

function onSetKey(event: KeyboardEvent, id: string) {
  if (event.key === 'Enter' || event.key === ' ') openSet(event, id)
}

/** Login tabs can't be in a set. */
const canSaveSet = computed(() => terminals.terminals.some((t) => t.mode !== 'login'))
</script>

<template>
  <DropdownMenuContent class="w-72" @close-auto-focus.prevent>
    <DropdownMenuLabel>Neue Claude-Session</DropdownMenuLabel>
    <DropdownMenuGroup>
      <DropdownMenuItem v-for="account in accounts.accounts" :key="account.id" @select="launcher.newSession(account.id)">
        <AccountDot :color="account.color" />
        <span class="truncate">{{ account.name }}</span>
        <DropdownMenuShortcut v-if="account.id === launcher.defaultAccountId()">Vorgabe</DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuGroup>
    <template v-if="recent.folders.value.length">
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Zuletzt genutzte Ordner</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuSub v-for="folder in recent.folders.value" :key="folder.path">
          <DropdownMenuSubTrigger
            v-tooltip.left="folder.path"
            :text-value="folder.name"
            @click.capture="startIn($event, folder.path)"
            @keydown.capture="onFolderKey($event, folder.path)"
          >
            <FolderIcon />
            <span class="max-w-[55%] shrink-0 truncate">{{ folder.name }}</span>
            <span class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
              {{ folder.parent && shortenPath(folder.parent, app.info?.homeDir) }}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="w-64">
            <DropdownMenuLabel>Claude-Session mit</DropdownMenuLabel>
            <DropdownMenuItem
              v-for="account in accounts.accounts"
              :key="account.id"
              @select="launcher.newSession(account.id, folder.path)"
            >
              <AccountDot :color="account.color" />
              <span class="truncate">{{ account.name }}</span>
              <DropdownMenuShortcut v-if="account.id === launcher.defaultAccountId()">Vorgabe</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="launcher.newSessionInWorktree(null, folder.path)">
              <FolderGit2Icon />
              In neuem Worktree…
            </DropdownMenuItem>
            <DropdownMenuItem @select="launcher.shell(launcher.defaultAccountId(), folder.path)">
              <SquareTerminalIcon />
              {{ shellLabel }} hier öffnen
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuGroup>
    </template>
    <template v-if="tabSets.sets.length">
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Tab-Sets</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuSub v-for="set in tabSets.sets" :key="set.id">
          <DropdownMenuSubTrigger
            v-tooltip.left="set.tabs.map(tabSetTabLabel).join(' · ')"
            :text-value="set.name"
            @click.capture="openSet($event, set.id)"
            @keydown.capture="onSetKey($event, set.id)"
          >
            <LayersIcon />
            <span class="min-w-0 flex-1 truncate">{{ set.name }}</span>
            <span class="text-xs text-muted-foreground tabular-nums">{{ set.tabs.length }}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="w-52">
            <DropdownMenuItem @select="tabSets.open(set.id)">
              <PlayIcon />
              Öffnen
            </DropdownMenuItem>
            <DropdownMenuItem @select="ui.tabSetRequest = { mode: 'edit', id: set.id }">
              <PencilIcon />
              Bearbeiten…
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" @select="tabSets.remove(set.id)">
              <Trash2Icon />
              Löschen
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuGroup>
    </template>
    <DropdownMenuSeparator />
    <DropdownMenuGroup>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <FolderOpenIcon />
          In Ordner starten…
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-56">
          <DropdownMenuItem
            v-for="account in accounts.accounts"
            :key="account.id"
            @select="launcher.newSessionInFolder(account.id)"
          >
            <AccountDot :color="account.color" />
            <span class="truncate">{{ account.name }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <SquareTerminalIcon />
          {{ shellLabel }} mit Account
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-56">
          <DropdownMenuItem v-for="account in accounts.accounts" :key="account.id" @select="launcher.shell(account.id)">
            <AccountDot :color="account.color" />
            <span class="truncate">{{ account.name }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub v-if="loginAccounts.length">
        <DropdownMenuSubTrigger>
          <KeyRoundIcon />
          Anmelden
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-56">
          <DropdownMenuItem v-for="account in loginAccounts" :key="account.id" @select="launcher.login(account.id)">
            <AccountDot :color="account.color" />
            <span class="truncate">{{ account.name }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuGroup>
    <DropdownMenuSeparator />
    <DropdownMenuGroup>
      <!-- In groups a browser always belongs to a session: the browser tab with the one with the keyboard; not while it shows its pages. -->
      <template v-if="terminals.grouped">
        <DropdownMenuItem v-if="!terminals.browserShownFor(terminals.sessionFor(terminals.active)?.id)" :disabled="!terminals.sessionFor(terminals.active)" @select="launcher.browserFor(terminals.active)">
          <GlobeIcon />
          Browser öffnen
        </DropdownMenuItem>
      </template>
      <DropdownMenuItem v-else @select="launcher.browser()">
        <GlobeIcon />
        Browser öffnen
      </DropdownMenuItem>
      <DropdownMenuItem @select="router.push({ name: 'sessions' })">
        <HistoryIcon />
        Session fortsetzen…
      </DropdownMenuItem>
      <DropdownMenuItem :disabled="!canSaveSet" @select="ui.tabSetRequest = { mode: 'create' }">
        <LayersIcon />
        Offene Tabs als Tab-Set speichern…
      </DropdownMenuItem>
      <DropdownMenuSub v-if="terminals.recentlyClosed.length">
        <DropdownMenuSubTrigger>
          <RotateCcwIcon />
          Zuletzt geschlossen
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-72">
          <DropdownMenuItem v-for="entry in terminals.recentlyClosed" :key="entry.id" @select="launcher.reopen(entry)">
            <SquareTerminalIcon v-if="entry.mode === 'shell'" />
            <AccountDot v-else :color="accounts.get(entry.authAccountId)?.color ?? accounts.get(entry.accountId)?.color" />
            <span class="min-w-0 flex-1 truncate">{{ entry.title }}</span>
            <DropdownMenuShortcut class="tracking-normal">{{ formatRelative(new Date(entry.closedAt).toISOString()) }}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuGroup>
  </DropdownMenuContent>
</template>
