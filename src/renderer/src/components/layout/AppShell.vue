<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { useTerminalsStore } from '@/stores/terminals'
import ClassicShell from './ClassicShell.vue'
import GroupShell from './GroupShell.vue'

/**
 * The window: the tabs in one tab bar (title bar or sidebar) or in groups like VS Code's editor groups,
 * after the setting `appearance.tabPosition`.
 */
const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()

// Programs in the terminals hear when the theme turns dark or light (Claude Code's "Auto" theme).
const { dark: terminalDark } = useTerminalAppearance()
watch(terminalDark, (dark) => window.api.terminals.colorScheme(dark), { immediate: true })

// Terminals opened through the local API with `activate: true`, `cm` or a click on a notification.
// In groups the route follows the tab by itself.
const offActivate = window.api.terminals.onActivate((id) => {
  terminals.activate(id)
  if (!terminals.grouped && route.name !== 'terminals') void router.push({ name: 'terminals' })
})
onBeforeUnmount(offActivate)

// A session at a limit went on with another account by itself (setting `claude.autoSwitch`).
const accountSwitch = useAccountSwitch()
const offAutoSwitch = window.api.terminals.onAutoSwitch((event) => accountSwitch.announceAutoSwitch(event))
onBeforeUnmount(offAutoSwitch)

// A click on the warning about a limit.
const offUsageShow = window.api.usage.onShow(() => void router.push({ name: 'dashboard' }))
onBeforeUnmount(offUsageShow)
</script>

<template>
  <GroupShell v-if="terminals.grouped" />
  <ClassicShell v-else />
</template>
