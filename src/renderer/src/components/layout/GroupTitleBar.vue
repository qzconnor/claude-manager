<script setup lang="ts">
import AppLogo from '@/components/common/AppLogo.vue'
import { useAppStore } from '@/stores/app'
import TitleBarNotifications from './TitleBarNotifications.vue'
import TitleBarPages from './TitleBarPages.vue'
import TitleBarSearch from './TitleBarSearch.vue'
import TitleBarUsage from './TitleBarUsage.vue'

/**
 * Custom title bar like VS Code's: the search in the middle (the command center), the app's pages and
 * the usage on the right. The tabs live in the groups below, and each group's bar names the branch of
 * the tab it shows: the groups can show different repositories. The native caption buttons are drawn
 * by Electron's titleBarOverlay on the right, so that area is kept free. In a narrow window the right
 * side keeps its width: the search moves left (the app's name goes) and then gets narrower.
 */
const app = useAppStore()
</script>

<template>
  <header
    :data-unfocused="!app.windowState.focused || undefined"
    class="app-drag grid h-(--titlebar-height) shrink-0 grid-cols-[minmax(2.5rem,1fr)_minmax(11rem,min(32rem,38vw))_minmax(max-content,1fr)] items-center gap-2 pr-(--caption-buttons-width)"
  >
    <div class="@container flex min-w-0 items-center gap-2.5 pl-3.5 transition-opacity in-data-unfocused:opacity-75">
      <AppLogo class="size-6 shrink-0" />
      <!-- Line box as tall as the logo, so the text sits on the same centre line as the icon; gone where it doesn't fit whole. -->
      <span class="truncate text-base leading-6 font-semibold @max-[11.5rem]:hidden">Claude Manager</span>
    </div>
    <TitleBarSearch class="transition-opacity in-data-unfocused:opacity-75" />
    <div class="flex min-w-0 items-center justify-end">
      <div class="mr-2 flex items-center gap-1 transition-opacity in-data-unfocused:opacity-75">
        <TitleBarUsage class="mr-1" />
        <TitleBarPages />
        <TitleBarNotifications />
      </div>
    </div>
  </header>
</template>
