<script setup lang="ts">
import { computed } from 'vue'
import AppLogo from '@/components/common/AppLogo.vue'
import TerminalTabs from '@/components/terminal/TerminalTabs.vue'
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
  <header
    :class="
      cn(
        'app-drag flex h-(--titlebar-height) shrink-0 items-center pr-(--caption-buttons-width) transition-opacity',
        !app.windowState.focused && 'opacity-75',
      )
    "
  >
    <!-- Centred over the nav rail; the tabs start right at its edge, so the logo has the same space on both sides.
         Above the wide sidebar it stays centred over the icons (8 px rail padding + 10 px button padding). -->
    <div
      :class="
        cn(
          'flex shrink-0 items-center',
          tabsInSidebar ? 'w-(--sidebar-width) gap-2.5 pl-4' : 'w-13 justify-center',
        )
      "
    >
      <AppLogo class="size-6" />
      <span v-if="tabsInSidebar" class="truncate text-sm font-medium">Claude Manager</span>
    </div>
    <TerminalTabs v-if="!tabsInSidebar" class="min-w-0" />
    <div class="h-full min-w-8 flex-1" />
    <TitleBarUsage class="mr-2" />
  </header>
</template>
