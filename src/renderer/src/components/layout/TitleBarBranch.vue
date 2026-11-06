<script setup lang="ts">
import { GitBranchIcon, GitCommitHorizontalIcon } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { GitBranch } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useTerminalsStore } from '@/stores/terminals'

/** Git branch of the folder the active tab works in; hidden without git or outside a repository. */
const route = useRoute()
const app = useAppStore()
const terminals = useTerminalsStore()

/** Only while the terminals are shown, like the selected tab. */
const cwd = computed(() => (route.name === 'terminals' ? terminals.workingTerminal?.cwd || null : null))
const branch = ref<GitBranch | null>(null)

// Answers for a tab that is no longer active are dropped.
let request = 0
async function load(dir: string | null) {
  const current = ++request
  const next = dir ? await window.api.git.branch(dir).catch(() => null) : null
  if (current === request) branch.value = next
}

watch(cwd, (dir) => void load(dir), { immediate: true })
// Main watches the repository for checkouts; this also catches a folder that became one.
watch(
  () => app.windowState.focused,
  (focused) => {
    if (focused) void load(cwd.value)
  },
)
const off = window.api.git.onBranchChanged((dir, next) => {
  if (dir === cwd.value) branch.value = next
})
onBeforeUnmount(off)

const tooltip = computed(() =>
  branch.value?.detached
    ? `Kein Branch ausgecheckt (Commit ${branch.value.name}) · ${cwd.value}`
    : `Git-Branch ${branch.value?.name} · ${cwd.value}`,
)
</script>

<template>
  <Transition
    enter-from-class="opacity-0"
    leave-to-class="opacity-0"
    enter-active-class="transition-opacity duration-200"
    leave-active-class="transition-opacity duration-150"
  >
    <!-- Wrapper element: Transition needs one root, the tooltip renders trigger + portal.
         The name is shown in full while there is room. When the title bar runs short, the branch gives
         way before the tabs (high shrink factor) down to 12rem, then the tabs scroll as before. -->
    <div
      v-if="branch"
      class="mr-2 flex min-w-48 shrink-1000 justify-end transition-opacity in-data-unfocused:opacity-75"
    >
      <Tooltip>
        <TooltipTrigger as-child>
          <!-- Looks like the usage button next to it, but is only a label. -->
          <div
            class="app-no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-border bg-background/40 px-2.5 text-[0.8rem] text-muted-foreground dark:border-input dark:bg-input/30"
          >
            <GitCommitHorizontalIcon v-if="branch.detached" class="size-3.5 shrink-0" />
            <GitBranchIcon v-else class="size-3.5 shrink-0" />
            <span :class="cn('truncate font-medium text-foreground', branch.detached && 'font-mono')">
              {{ branch.name }}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>{{ tooltip }}</TooltipContent>
      </Tooltip>
    </div>
  </Transition>
</template>
