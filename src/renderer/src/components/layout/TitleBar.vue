<script setup lang="ts">
import AppLogo from '@/components/common/AppLogo.vue'
import TerminalTabs from '@/components/terminal/TerminalTabs.vue'
import TitleBarUsage from './TitleBarUsage.vue'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'

/**
 * Custom title bar with Windows-Terminal-like tabs. The native caption buttons are drawn by
 * Electron's titleBarOverlay on the right, so that area is kept free.
 */
const app = useAppStore()
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
    <!-- Centred over the nav rail; the tabs start right at its edge, so the logo has the same space on both sides. -->
    <div class="flex w-13 shrink-0 items-center justify-center">
      <AppLogo class="size-6" />
    </div>
    <TerminalTabs class="min-w-0" />
    <div class="h-full min-w-8 flex-1" />
    <TitleBarUsage class="mr-2" />
  </header>
</template>
