<script setup lang="ts">
import {
  CalendarIcon,
  ChevronDownIcon,
  CopyIcon,
  CpuIcon,
  EllipsisIcon,
  FileDiffIcon,
  FileDownIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  HardDriveIcon,
  MessagesSquareIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  SquareTerminalIcon,
  TagIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { SessionDetail, SessionSummary } from '@shared/types'
import AccountBadge from '@/components/common/AccountBadge.vue'
import AccountChoiceItems from '@/components/common/AccountChoiceItems.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Spinner } from '@/components/ui/spinner'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useLauncher } from '@/composables/useLauncher'
import { useSessionActions } from '@/composables/useSessionActions'
import { useSessionRemoval } from '@/composables/useSessionRemoval'
import { modelName } from '@/lib/context'
import { attempt } from '@/lib/errors'
import { formatBytes, formatPeriod, shortenPath } from '@/lib/format'
import { sessionFolder } from '@/lib/session-tree'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import SessionChangesView from './SessionChangesView.vue'
import TranscriptView from './TranscriptView.vue'

const props = defineProps<{
  summary: SessionSummary
  detail: SessionDetail | null
  loading: boolean
  loadingOlder?: boolean
  error: string | null
}>()
defineEmits<{ loadOlder: [] }>()

const app = useAppStore()
const ui = useUiStore()
const terminals = useTerminalsStore()
const launcher = useLauncher()
const accountSwitch = useAccountSwitch()
const removal = useSessionRemoval()
const actions = useSessionActions()
const choicesOpen = ref(false)
/** The conversation, or what Claude changed in the files; stays when another session is shown. */
const pane = ref<'messages' | 'changes'>('messages')

/** The project's folder: for a session in a worktree, the folder it was started in. */
const folder = computed(() => sessionFolder(props.summary))

/**
 * The tab the session runs in right now, or waits to start in (it starts once shown): „Fortsetzen“
 * shows it instead of starting the session again.
 */
const tab = computed(
  () =>
    terminals.terminals.find(
      (t) =>
        t.mode === 'session' &&
        t.status !== 'exited' &&
        t.accountId === props.summary.accountId &&
        t.sessionId === props.summary.id,
    ) ?? null,
)

const model = computed(() => (props.summary.model ? (modelName(props.summary.model) ?? props.summary.model) : null))
const messages = computed(() => {
  const count = props.summary.messageCount
  const exact = props.summary.messageCountExact
  return `${count.toLocaleString('de')}${exact ? '' : '+'} ${count === 1 && exact ? 'Nachricht' : 'Nachrichten'}`
})

function openFolder() {
  if (folder.value) void attempt(() => window.api.app.openPath(folder.value!), 'Ordner konnte nicht geöffnet werden')
}

function rename() {
  ui.sessionRenameRequest = { sessionId: props.summary.id, title: props.summary.title, name: props.summary.name }
}

async function copyId() {
  await navigator.clipboard.writeText(props.summary.id)
  toast.success('Session-ID kopiert')
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col">
    <header class="flex flex-col gap-3 border-b px-6 py-4 lg:px-10">
      <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div class="group/title flex min-w-0 flex-1 basis-72 items-start gap-1">
          <h2 class="selectable min-w-0 font-heading text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
            {{ summary.title }}
          </h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Umbenennen"
            v-tooltip="'Umbenennen'"
            class="mt-[2px] size-[24px] shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100"
            @click="rename"
          >
            <PencilIcon />
          </Button>
          <!-- Pinned it stays to be seen, otherwise it comes with the pencil. -->
          <Button
            variant="ghost"
            size="icon-xs"
            :aria-label="summary.pinned ? 'Nicht mehr anheften' : 'Anheften'"
            :aria-pressed="summary.pinned"
            v-tooltip="summary.pinned ? 'Angeheftet · Nicht mehr anheften' : 'Oben in der Liste anheften'"
            :class="
              cn(
                'mt-[2px] size-[24px] shrink-0',
                summary.pinned ? 'text-primary' : 'text-muted-foreground opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100',
              )
            "
            @click="actions.togglePin(summary)"
          >
            <PinIcon />
          </Button>
        </div>

        <!-- Going on with the session first, what else can be done with it behind „…“. -->
        <div class="flex shrink-0 items-center gap-2">
          <Spinner v-if="loading && detail" class="text-muted-foreground" />
          <Button size="sm" variant="outline" v-tooltip="'Als neue Session abzweigen'" @click="launcher.resume(summary, true)">
            <GitForkIcon data-icon="inline-start" />
            Abzweigen
          </Button>
          <ButtonGroup>
            <Button size="sm" @click="launcher.resume(summary)">
              <SquareTerminalIcon v-if="tab" data-icon="inline-start" />
              <PlayIcon v-else data-icon="inline-start" />
              {{ tab ? 'Zum Tab' : 'Fortsetzen' }}
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
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="icon-sm" aria-label="Weitere Aktionen" v-tooltip="'Weitere Aktionen'">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
              <DropdownMenuGroup>
                <DropdownMenuItem @select="rename">
                  <PencilIcon />
                  Umbenennen…
                </DropdownMenuItem>
                <DropdownMenuItem @select="actions.togglePin(summary)">
                  <PinOffIcon v-if="summary.pinned" />
                  <PinIcon v-else />
                  {{ summary.pinned ? 'Nicht mehr anheften' : 'Anheften' }}
                </DropdownMenuItem>
                <DropdownMenuItem @select="actions.editTags(summary)">
                  <TagIcon />
                  Tags bearbeiten…
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem :disabled="!folder" @select="openFolder">
                  <FolderOpenIcon />
                  Projektordner öffnen
                </DropdownMenuItem>
                <DropdownMenuItem @select="copyId">
                  <CopyIcon />
                  Session-ID kopieren
                </DropdownMenuItem>
                <DropdownMenuItem @select="actions.exportMarkdown(summary)">
                  <FileDownIcon />
                  Als Markdown exportieren…
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="removal.remove([summary])">
                <Trash2Icon />
                Löschen…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <!-- Where the session ran, then what it holds. -->
      <div class="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <AccountBadge :account-id="summary.accountId" />
          <Badge v-if="tab" variant="secondary" class="gap-1.5">
            <Spinner v-if="tab.busy" class="size-3" />
            <span v-else class="size-1.5 rounded-full bg-primary" />
            {{ tab.busy ? 'Claude arbeitet' : 'Offen in einem Tab' }}
          </Badge>
          <button
            v-if="folder"
            type="button"
            class="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            v-tooltip="`${folder} · Öffnen`"
            @click="openFolder"
          >
            <FolderIcon class="size-3.5 shrink-0" />
            <span class="truncate font-mono">{{ shortenPath(folder, app.info?.homeDir) }}</span>
          </button>
          <span v-if="summary.worktree" class="flex min-w-0 items-center gap-1" v-tooltip="`Worktree in ${summary.worktree.path}`">
            <FolderGit2Icon class="size-3.5 shrink-0" />
            <span class="selectable truncate">Worktree {{ summary.worktree.name }}</span>
          </span>
          <span v-if="summary.gitBranch" class="flex min-w-0 items-center gap-1">
            <GitBranchIcon class="size-3.5 shrink-0" />
            <span class="selectable truncate">{{ summary.gitBranch }}</span>
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span v-if="model" class="flex items-center gap-1" v-tooltip="summary.model">
            <CpuIcon class="size-3.5 shrink-0" />
            {{ model }}
          </span>
          <span class="flex items-center gap-1">
            <MessagesSquareIcon class="size-3.5 shrink-0" />
            {{ messages }}
          </span>
          <span class="flex items-center gap-1">
            <HardDriveIcon class="size-3.5 shrink-0" />
            {{ formatBytes(summary.sizeBytes) }}
          </span>
          <span class="flex items-center gap-1">
            <CalendarIcon class="size-3.5 shrink-0" />
            {{ formatPeriod(summary.createdAt, summary.updatedAt) }}
          </span>
          <!-- The tags open their editor; without any, the menu adds them. -->
          <button
            v-if="summary.tags.length"
            type="button"
            class="flex min-w-0 flex-wrap items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            v-tooltip="'Tags bearbeiten'"
            :aria-label="`Tags: ${summary.tags.join(', ')} · bearbeiten`"
            @click="actions.editTags(summary)"
          >
            <TagIcon class="size-3.5 shrink-0" />
            <Badge v-for="tag in summary.tags" :key="tag" variant="secondary" class="font-normal">{{ tag }}</Badge>
          </button>
        </div>
      </div>

      <Tabs v-model="pane" class="-mb-4">
        <TabsList variant="line" class="h-8 gap-4 p-0">
          <TabsTrigger value="messages" class="flex-none px-0 pb-2">
            <MessagesSquareIcon />
            Verlauf
          </TabsTrigger>
          <TabsTrigger value="changes" class="flex-none px-0 pb-2">
            <FileDiffIcon />
            Änderungen
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </header>

    <div class="min-h-0 flex-1">
      <SessionChangesView
        v-if="pane === 'changes'"
        :account-id="summary.accountId"
        :session-id="summary.id"
        :folder="folder"
        :updated-at="summary.updatedAt"
      />
      <div v-else-if="error" class="p-6">
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Transcript konnte nicht geladen werden</AlertTitle>
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
      </div>
      <div v-else-if="!detail" class="flex flex-col gap-6 px-6 py-6 lg:px-10">
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
        :total="detail.total"
        :loading-older="loadingOlder"
        :account-id="detail.summary.accountId"
        :session-id="detail.summary.id"
        @load-older="$emit('loadOlder')"
      />
    </div>
  </div>
</template>
