<script setup lang="ts">
import { computed } from 'vue'
import AppLogo from '@/components/common/AppLogo.vue'
import TabSearch from '@/components/terminal/TabSearch.vue'
import TerminalTabs from '@/components/terminal/TerminalTabs.vue'
import TitleBarBranch from './TitleBarBranch.vue'
import TitleBarNotifications from './TitleBarNotifications.vue'
import TitleBarSplit from './TitleBarSplit.vue'
import TitleBarUsage from './TitleBarUsage.vue'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'

/**
 * Custom title bar with Windows-Terminal-like tabs, unless they are in the sidebar. The native
 * caption buttons are drawn by Electron's titleBarOverlay on the right, so that area is kept free.
 */
const app = useAppStore()
const settings = useSettingsStore()
const tabsInSidebar = computed(() => settings.settings.appearance.tabPosition === 'sidebar')
</script>

<template>
  <!-- An unfocused window fades the title bar's content but not the selected tab's background,
       which has to keep the page's colour to stay joined to it. -->
  <header
    :data-unfocused="!app.windowState.focused || undefined"
    class="app-drag flex h-(--titlebar-height) shrink-0 items-center pr-(--caption-buttons-width)"
  >
    <!-- Centred over the nav rail; the tabs start right at its edge, so the logo has the same space on both sides,
         and it moves down with the tabs to sit on their centre line.
         Above the wide sidebar it stays centred over the icons (8 px rail padding + 10 px button padding). -->
    <div
      :class="
        cn(
          'flex shrink-0 items-center transition-opacity in-data-unfocused:opacity-75',
          tabsInSidebar ? 'w-(--sidebar-width) gap-2.5 pl-4' : 'w-13 justify-center self-stretch pt-1.5',
        )
      "
    >
      <AppLogo class="size-6" />
      <!-- Line box as tall as the logo, so the text sits on the same centre line as the icon. -->
      <span v-if="tabsInSidebar" class="truncate text-base leading-6 font-semibold">Claude Manager</span>
    </div>
    <TerminalTabs v-if="!tabsInSidebar" class="min-w-0" />
    <div class="h-full min-w-8 flex-1" />
    <!-- Outside the group on the right, so it can shrink on its own. -->
    <TitleBarBranch />
    <div class="mr-2 flex items-center gap-2 transition-opacity in-data-unfocused:opacity-75">
      <TitleBarSplit />
      <TitleBarUsage />
      <!-- At the end of the tab bar like in a browser; in the sidebar it heads the tabs instead. -->
      <TabSearch v-if="!tabsInSidebar" />
      <TitleBarNotifications />
    </div>
  </header>
</template>
