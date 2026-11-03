<script setup lang="ts">
import { GaugeIcon, HistoryIcon, SearchIcon, SettingsIcon, UsersIcon } from '@lucide/vue'
import { computed, type Component } from 'vue'
import TerminalTabs from '@/components/terminal/TerminalTabs.vue'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { UPDATES_ROUTE } from '@/router'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { useUpdatesStore } from '@/stores/updates'
import NavRailButton from './NavRailButton.vue'

interface NavItem {
  name: string
  label: string
  icon: Component
  tooltip?: string
}

// No entry for the terminals: their tabs lead there, in the title bar or in the sidebar.
const primary: NavItem[] = [
  { name: 'sessions', label: 'Sessions', icon: HistoryIcon },
  { name: 'dashboard', label: 'Usage-Dashboard', icon: GaugeIcon },
  { name: 'accounts', label: 'Accounts', icon: UsersIcon },
]

const settings = useSettingsStore()
const ui = useUiStore()
const updates = useUpdatesStore()

/** With the tabs in the sidebar the rail widens, labels its icons and lists the tabs below them. */
const expanded = computed(() => settings.settings.appearance.tabPosition === 'sidebar')

/**
 * The updates are a tab of the settings: a waiting update pulses on their button, release notes
 * still unread after an update get a dot. Either way the button then opens the updates tab.
 */
const updatesPending = computed(() => updates.hasUpdate || updates.unseen)
const settingsTooltip = computed(() =>
  updates.hasUpdate
    ? `Einstellungen (Strg+,) · Version ${updates.state.next} ist verfügbar`
    : updates.unseen
      ? `Einstellungen (Strg+,) · Neu in Version ${updates.state.current}`
      : 'Einstellungen (Strg+,)',
)
</script>

<template>
  <nav
    :class="
      cn(
        'flex shrink-0 flex-col pt-1 pb-3',
        expanded ? 'w-(--sidebar-width) px-2' : 'w-13 items-center justify-between',
      )
    "
    aria-label="Hauptnavigation"
  >
    <div :class="cn('flex flex-col gap-1', !expanded && 'items-center')">
      <RouterLink
        v-for="item in primary"
        :key="item.name"
        v-slot="{ href, navigate, isActive }"
        :to="{ name: item.name }"
        custom
      >
        <NavRailButton
          :label="item.label"
          :icon="item.icon"
          :tooltip="item.tooltip"
          :expanded="expanded"
          :href="href"
          :active="isActive"
          @click="navigate"
        />
      </RouterLink>
    </div>

    <template v-if="expanded">
      <Separator class="my-2" />
      <TerminalTabs vertical class="min-h-0 flex-1" />
      <Separator class="my-2" />
    </template>

    <div :class="cn('flex flex-col gap-1', !expanded && 'items-center')">
      <NavRailButton
        label="Befehlspalette"
        :icon="SearchIcon"
        tooltip="Befehlspalette (Strg+Umschalt+P)"
        :expanded="expanded"
        @click="ui.paletteOpen = true"
      />
      <RouterLink v-slot="{ href, navigate, isActive }" :to="updatesPending ? UPDATES_ROUTE : { name: 'settings' }" custom>
        <NavRailButton
          label="Einstellungen"
          :icon="SettingsIcon"
          :tooltip="settingsTooltip"
          :expanded="expanded"
          :href="href"
          :active="isActive"
          @click="navigate"
        >
          <span v-if="updates.hasUpdate" :class="cn('flex size-2', expanded ? 'relative mr-1' : 'absolute top-1 right-1')">
            <span class="absolute size-full animate-ping rounded-full bg-success opacity-75" />
            <span class="relative size-2 rounded-full bg-success" />
          </span>
          <span
            v-else-if="updates.unseen"
            :class="cn('size-2 rounded-full bg-success', expanded ? 'mr-1' : 'absolute top-1 right-1')"
          />
        </NavRailButton>
      </RouterLink>
    </div>
  </nav>
</template>
