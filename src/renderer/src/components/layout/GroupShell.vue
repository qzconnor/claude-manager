<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GroupWorkspace from '@/components/terminal/GroupWorkspace.vue'
import { useWakeShown } from '@/composables/useWakeShown'
import { isPage } from '@/lib/workspace'
import { useTerminalsStore } from '@/stores/terminals'
import GroupTitleBar from './GroupTitleBar.vue'

/** The window with the tabs in groups like VS Code's editor groups; the pages open as tabs too. */
const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()

// Switched to groups on a page (the settings, usually): it opens as a tab in the first group, so the
// route can stay.
if (isPage(route.name)) terminals.openPage(route.name)

// The route follows the tab with the keyboard: its page, or the terminals. Code that asks for a page
// by its route (router.push({ name: 'settings' })) opens it as a tab, or brings its tab forward.
watch(
  () => terminals.focusedPage ?? 'terminals',
  (name) => {
    if (route.name !== name) void router.push({ name })
  },
  { immediate: true },
)
watch(
  () => route.name,
  (name) => {
    if (isPage(name)) terminals.openPage(name)
    else if (name === 'terminals' && terminals.focusedPage) {
      // Back to the terminal that had the keyboard last; without one the page stays.
      if (terminals.activeId) terminals.activate(terminals.activeId)
      else void router.replace({ name: terminals.focusedPage })
    }
  },
)

// The main process learns which terminals are on screen, those each group shows: their news counts
// as seen (notifications, unread dot).
watch(
  () => terminals.visibleIds.join(','),
  (ids) => window.api.terminals.viewing(ids ? ids.split(',') : []),
  { immediate: true },
)
useWakeShown(() => terminals.visibleIds)
</script>

<template>
  <div class="flex h-full flex-col">
    <GroupTitleBar />
    <!-- isolate keeps the pages' own z-indices below dialogs. -->
    <main class="relative isolate min-h-0 flex-1 overflow-hidden">
      <GroupWorkspace class="absolute inset-0" />
    </main>
  </div>
</template>
