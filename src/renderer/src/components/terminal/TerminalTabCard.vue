<script setup lang="ts">
import {
  BellDotIcon,
  BellOffIcon,
  BotIcon,
  CircleStopIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  HardDriveIcon,
  Link2Icon,
  PencilIcon,
  ShrinkIcon,
  TagIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from '@lucide/vue'
import { computed } from 'vue'
import type { Account, TerminalInfo } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import AccountIdentityLine from '@/components/common/AccountIdentityLine.vue'
import { Button } from '@/components/ui/button'
import { useClock } from '@/composables/useClock'
import { activityDuration, activityLabel } from '@/lib/activity'
import { attentionLook } from '@/lib/attention'
import { accountKindLabel, formatReset } from '@/lib/format'
import { fileManagerLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { limitLabel } from '@/lib/usage'
import BrowserFavicon from './BrowserFavicon.vue'

/**
 * What the hover card of a tab shows: the full title and where the session runs. The title is the
 * session's (the one Claude gave it), also when the tab has a name of its own; that one is listed below.
 */
const props = defineProps<{
  terminal: TerminalInfo
  /** The account whose limits the tab uses. */
  account?: Account
  /** Set when the session lies with another account than the one it runs with. */
  sessionAccount?: Account
  /** A browser's session, named where the two don't lie side by side. */
  session?: TerminalInfo
}>()
defineEmits<{ openFolder: []; rename: [] }>()

const openLabel = `Im ${fileManagerLabel} öffnen`
const named = computed(() => props.terminal.fixedTitle && props.terminal.title !== props.terminal.autoTitle)
// A limit has its own line below.
const attention = computed(() =>
  props.terminal.attention && props.terminal.attention !== 'limit' ? attentionLook[props.terminal.attention] : null,
)
const folder = computed(() => props.terminal.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? props.terminal.cwd)

// What runs, as the session's hooks tell it. A tool only counts while Claude works: after a declined
// permission it stays behind.
const now = useClock(1000)
const activity = computed(() => {
  const running = props.terminal.busy ? props.terminal.activity : null
  return running ? { ...activityLabel(running), duration: activityDuration(running.since, now.value) } : null
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex gap-2">
      <p class="line-clamp-3 min-w-0 flex-1 leading-snug font-medium break-words">{{ terminal.autoTitle }}</p>
      <Button
        variant="ghost"
        size="icon-xs"
        class="-my-1 -mr-1 text-muted-foreground"
        aria-label="Tab umbenennen"
        v-tooltip="'Tab umbenennen'"
        @click="$emit('rename')"
      >
        <PencilIcon class="size-3.5" />
      </Button>
    </div>

    <div class="flex flex-col gap-2.5 text-xs">
      <!-- Rows of two lines have their symbol in the middle of them. -->
      <div v-if="named" class="flex items-center gap-2">
        <TagIcon class="size-3.5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="leading-4 font-medium break-words">{{ terminal.title }}</p>
          <p class="text-muted-foreground">Eigener Name des Tabs</p>
        </div>
      </div>

      <div v-if="account" class="flex items-center gap-2">
        <span class="flex w-3.5 shrink-0 justify-center">
          <AccountDot :color="account.color" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate leading-4 font-medium">{{ account.name }}</p>
          <AccountIdentityLine
            :identity="account.identity"
            :fallback="accountKindLabel(account.kind)"
            class="text-muted-foreground"
          />
        </div>
      </div>

      <template v-if="terminal.mode === 'browser'">
        <div class="flex gap-2">
          <BrowserFavicon :terminal-id="terminal.id" class="mt-px size-3.5 shrink-0 text-muted-foreground" />
          <p class="min-w-0 flex-1 break-all text-muted-foreground">{{ terminal.url === 'about:blank' ? 'Leere Seite' : terminal.url }}</p>
        </div>
        <div v-if="session" class="flex gap-2">
          <Link2Icon class="mt-px size-3.5 shrink-0 text-muted-foreground" />
          <p class="min-w-0 flex-1 break-words"><span class="text-muted-foreground">Gehört zu </span>{{ session.title }}</p>
        </div>
      </template>
      <div v-else class="flex items-center gap-2">
        <FolderIcon class="size-3.5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate leading-4 font-medium">{{ folder }}</p>
          <p class="break-all text-muted-foreground">{{ terminal.cwd }}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          class="-my-1 -mr-1 text-muted-foreground"
          :aria-label="openLabel"
          v-tooltip="openLabel"
          @click="$emit('openFolder')"
        >
          <FolderOpenIcon class="size-3.5" />
        </Button>
      </div>

      <div v-if="terminal.worktree" class="flex items-center gap-2">
        <FolderGit2Icon class="size-3.5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate leading-4 font-medium">Worktree {{ terminal.worktree.name }}</p>
          <p class="break-all text-muted-foreground">
            <template v-if="terminal.worktree.branch">Branch {{ terminal.worktree.branch }} · </template>{{ terminal.worktree.path }}
          </p>
        </div>
      </div>

      <div v-if="sessionAccount" class="flex gap-2 text-muted-foreground">
        <HardDriveIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">Session gespeichert bei „{{ sessionAccount.name }}“</p>
      </div>

      <div v-if="activity" class="flex items-center gap-2">
        <WrenchIcon class="size-3.5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate leading-4 font-medium">
            {{ activity.label }}<span v-if="activity.duration" class="font-normal text-muted-foreground"> · {{ activity.duration }}</span>
          </p>
          <p v-if="activity.detail" class="line-clamp-2 break-all text-muted-foreground">{{ activity.detail }}</p>
        </div>
      </div>

      <div v-if="terminal.subagents > 0" class="flex gap-2 text-muted-foreground">
        <BotIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">{{ terminal.subagents === 1 ? '1 Subagent läuft' : `${terminal.subagents} Subagents laufen` }}</p>
      </div>

      <div v-if="terminal.compacting" class="flex gap-2 text-muted-foreground">
        <ShrinkIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">Fasst den Verlauf zusammen …</p>
      </div>

      <div v-if="terminal.limit" class="flex gap-2 text-warning">
        <TriangleAlertIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">
          {{ limitLabel(terminal.limit.type) }} erreicht
          <template v-if="terminal.limit.resetsAt">· Reset {{ formatReset(terminal.limit.resetsAt) }}</template>
        </p>
      </div>

      <div v-if="attention" :class="cn('flex gap-2', attention.text)">
        <BellDotIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">{{ attention.label }}</p>
      </div>

      <div v-if="terminal.muted" class="flex gap-2 text-muted-foreground">
        <BellOffIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">Benachrichtigungen stummgeschaltet</p>
      </div>

      <div v-if="terminal.status === 'exited'" class="flex gap-2 text-muted-foreground">
        <CircleStopIcon class="mt-px size-3.5 shrink-0" />
        <p class="min-w-0 flex-1">
          Beendet<template v-if="terminal.exitCode !== null"> (Exit-Code {{ terminal.exitCode }})</template>
        </p>
      </div>
    </div>
  </div>
</template>
