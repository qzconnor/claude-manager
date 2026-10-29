<script setup lang="ts">
import {
  CalendarIcon,
  ChevronDownIcon,
  CopyIcon,
  CpuIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  MessagesSquareIcon,
  PlayIcon,
  TriangleAlertIcon,
} from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { SessionDetail, SessionSummary } from '@shared/types'
import AccountBadge from '@/components/common/AccountBadge.vue'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useLauncher } from '@/composables/useLauncher'
import { attempt } from '@/lib/errors'
import { formatBytes, formatDateTime, shortenPath } from '@/lib/format'
import { useAppStore } from '@/stores/app'
import TranscriptView from './TranscriptView.vue'

const props = defineProps<{
  summary: SessionSummary
  detail: SessionDetail | null
  loading: boolean
  error: string | null
}>()

const app = useAppStore()
const launcher = useLauncher()
const accountSwitch = useAccountSwitch()
const choicesOpen = ref(false)

function openFolder() {
  if (props.summary.cwd) void attempt(() => window.api.app.openPath(props.summary.cwd!), 'Ordner konnte nicht geöffnet werden')
}

async function copyId() {
  await navigator.clipboard.writeText(props.summary.id)
  toast.success('Session-ID kopiert')
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col">
    <header class="flex flex-col gap-3 border-b px-6 py-4">
      <div class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 flex-col gap-1.5">
          <h2 class="selectable font-heading text-base leading-snug font-semibold">{{ summary.title }}</h2>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <AccountBadge :account-id="summary.accountId" />
            <span v-if="summary.cwd" class="flex min-w-0 items-center gap-1" :title="summary.cwd">
              <FolderIcon class="size-3.5 shrink-0" />
              <span class="selectable truncate font-mono">{{ shortenPath(summary.cwd, app.info?.homeDir) }}</span>
            </span>
            <span v-if="summary.gitBranch" class="flex items-center gap-1">
              <GitBranchIcon class="size-3.5" />
              {{ summary.gitBranch }}
            </span>
            <span v-if="summary.model" class="flex items-center gap-1">
              <CpuIcon class="size-3.5" />
              {{ summary.model }}
            </span>
            <span class="flex items-center gap-1">
              <MessagesSquareIcon class="size-3.5" />
              {{ summary.messageCount }}{{ summary.messageCountExact ? '' : '+' }} · {{ formatBytes(summary.sizeBytes) }}
            </span>
            <span class="flex items-center gap-1">
              <CalendarIcon class="size-3.5" />
              {{ formatDateTime(summary.createdAt) }} – {{ formatDateTime(summary.updatedAt) }}
            </span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Spinner v-if="loading && detail" class="text-muted-foreground" />
          <ButtonGroup>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button variant="outline" size="icon-sm" aria-label="Session-ID kopieren" @click="copyId">
                  <CopyIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Session-ID kopieren</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button variant="outline" size="icon-sm" aria-label="Projektordner öffnen" :disabled="!summary.cwd" @click="openFolder">
                  <FolderOpenIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Projektordner öffnen</TooltipContent>
            </Tooltip>
          </ButtonGroup>
          <Button size="sm" variant="outline" @click="launcher.resume(summary, true)">
            <GitForkIcon data-icon="inline-start" />
            Abzweigen
          </Button>
          <ButtonGroup>
            <Button size="sm" @click="launcher.resume(summary)">
              <PlayIcon data-icon="inline-start" />
              Fortsetzen
            </Button>
            <DropdownMenu v-model:open="choicesOpen">
              <DropdownMenuTrigger as-child>
                <Button size="icon-sm" aria-label="Mit anderem Account fortsetzen">
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-72" @close-auto-focus.prevent>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Mit anderem Account fortsetzen</DropdownMenuLabel>
                </DropdownMenuGroup>
                <AccountChoiceItems
                  v-if="choicesOpen"
                  menu="dropdown"
                  :choices="accountSwitch.choices(summary.accountId, summary.accountId)"
                  @select="accountSwitch.continueSession(summary, $event)"
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>
      </div>
    </header>

    <div class="min-h-0 flex-1">
      <div v-if="error" class="p-6">
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Transcript konnte nicht geladen werden</AlertTitle>
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
      </div>
      <div v-else-if="!detail" class="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        <div v-for="i in 4" :key="i" class="flex flex-col gap-2">
          <Skeleton class="h-3 w-24" />
          <Skeleton class="h-16 w-full" />
        </div>
      </div>
      <Empty v-else-if="detail.messages.length === 0" class="size-full">
        <EmptyHeader>
          <EmptyTitle>Keine Nachrichten</EmptyTitle>
          <EmptyDescription>Diese Session enthält keine darstellbaren Nachrichten.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <TranscriptView
        v-else
        :messages="detail.messages"
        :truncated="detail.truncated"
        :account-id="detail.summary.accountId"
        :session-id="detail.summary.id"
      />
    </div>
  </div>
</template>
