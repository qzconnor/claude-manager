<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import GitBranchChip from '@/components/common/GitBranchChip.vue'
import { useTerminalsStore } from '@/stores/terminals'

/** Git branch of the folder the active tab works in; hidden without git or outside a repository. */
const route = useRoute()
const terminals = useTerminalsStore()

/** Only while the terminals are shown, like the selected tab. A session in a worktree works in its folder. */
const cwd = computed(() => {
  const terminal = route.name === 'terminals' ? terminals.workingTerminal : null
  return terminal?.worktree?.path || terminal?.cwd || null
})
</script>

<template>
  <!-- The name is shown in full while there is room. When the title bar runs short, the branch gives
       way before the tabs (high shrink factor) down to 12rem, then the tabs scroll as before. -->
  <GitBranchChip :cwd="cwd" class="mr-2 min-w-48 shrink-1000 transition-opacity in-data-unfocused:opacity-75" />
</template>
