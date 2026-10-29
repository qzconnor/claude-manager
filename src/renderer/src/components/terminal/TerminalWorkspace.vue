<script setup lang="ts">
import { useTerminalsStore } from '@/stores/terminals'
import TerminalEmptyState from './TerminalEmptyState.vue'
import TerminalPane from './TerminalPane.vue'

/**
 * Hosts every terminal at once and only toggles visibility, so xterm instances keep
 * their state while the user switches tabs or visits other pages.
 */
defineProps<{ visible: boolean }>()
const terminals = useTerminalsStore()
</script>

<template>
  <div class="relative size-full">
    <TerminalPane
      v-for="terminal in terminals.terminals"
      v-show="terminal.id === terminals.activeId"
      :key="terminal.id"
      class="absolute inset-0"
      :terminal="terminal"
      :active="visible && terminal.id === terminals.activeId"
    />
    <TerminalEmptyState v-if="terminals.terminals.length === 0" />
  </div>
</template>
