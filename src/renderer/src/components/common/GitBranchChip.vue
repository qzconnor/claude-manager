<script setup lang="ts">
import { FolderGit2Icon, GitBranchIcon, GitCommitHorizontalIcon } from '@lucide/vue'
import { computed, type HTMLAttributes } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useGitBranch } from '@/composables/useGitBranch'
import { attempt } from '@/lib/errors'
import { cn } from '@/lib/utils'

/**
 * Git branch of the folder `cwd` as a chip, with the worktree icon when the folder is a linked worktree;
 * a click opens the repository's web page in the default browser. Hidden without a folder, without git
 * and outside a repository.
 */
const props = defineProps<{
  cwd: string | null
  /** For the wrapper that fades in and out: the place the chip takes in its bar. */
  class?: HTMLAttributes['class']
}>()

const repo = useGitBranch(() => props.cwd)
const branch = computed(() => repo.value?.branch ?? null)
/** Page of the repository on GitHub, GitLab …; null without a remote that has one. */
const webUrl = computed(() => repo.value?.webUrl ?? null)

/** Main checkout when the folder is a linked worktree of its repository; null otherwise. */
const mainWorktree = computed(() => repo.value?.mainWorktree ?? null)

const label = computed(() => {
  const head = branch.value?.detached
    ? `Kein Branch ausgecheckt (Commit ${branch.value.name}) · ${props.cwd}`
    : `Git-Branch ${branch.value?.name} · ${props.cwd}`
  return mainWorktree.value ? `${head}\nWorktree von ${mainWorktree.value}` : head
})
const tooltip = computed(() =>
  webUrl.value ? `${label.value}\nKlicken öffnet ${webUrl.value.replace(/^https?:\/\//, '')}` : label.value,
)

function openRepository() {
  const url = webUrl.value
  if (url) void attempt(() => window.api.app.openExternal(url), 'Repository konnte nicht geöffnet werden')
}
</script>

<template>
  <Transition
    enter-from-class="opacity-0"
    leave-to-class="opacity-0"
    enter-active-class="transition-opacity duration-200"
    leave-active-class="transition-opacity duration-150"
  >
    <!-- Wrapper element: Transition needs one root, the tooltip renders trigger + portal. -->
    <div v-if="branch" :class="cn('flex justify-end', props.class)">
      <Tooltip>
        <TooltipTrigger as-child>
          <!-- Looks like the usage button in the title bar; a label only while the repository has no web page. -->
          <component
            :is="webUrl ? 'button' : 'div'"
            :type="webUrl ? 'button' : undefined"
            :aria-label="webUrl ? `${label}, Repository im Browser öffnen` : undefined"
            :class="
              cn(
                'app-no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-border bg-background/40 px-2.5 text-[0.8rem] text-muted-foreground outline-none dark:border-input dark:bg-input/30',
                webUrl &&
                  'transition-all hover:bg-muted hover:text-foreground active:translate-y-px focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:hover:bg-input/50',
              )
            "
            @click="openRepository"
          >
            <!-- In a worktree its icon wins: a detached HEAD still shows by the hash in mono. -->
            <FolderGit2Icon v-if="mainWorktree" class="size-3.5 shrink-0" />
            <GitCommitHorizontalIcon v-else-if="branch.detached" class="size-3.5 shrink-0" />
            <GitBranchIcon v-else class="size-3.5 shrink-0" />
            <span :class="cn('truncate font-medium text-foreground', branch.detached && 'font-mono')">
              {{ branch.name }}
            </span>
          </component>
        </TooltipTrigger>
        <TooltipContent class="whitespace-pre-line">{{ tooltip }}</TooltipContent>
      </Tooltip>
    </div>
  </Transition>
</template>
