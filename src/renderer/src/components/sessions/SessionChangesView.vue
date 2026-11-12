<script setup lang="ts">
import { FileDiffIcon, FileMinusIcon, FilePlusIcon, InfoIcon, RefreshCwIcon, RotateCcwIcon, TriangleAlertIcon } from '@lucide/vue'
import { useThrottleFn } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import type { FileChangeKind, SessionChanges, SessionChangeTexts, SessionFileChange } from '@shared/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { useDiffStyle } from '@/composables/useDiffStyle'
import { errorMessage } from '@/lib/errors'
import { formatDateTime, formatRelative } from '@/lib/format'
import { changePath, changeTotals, noteLabel } from '@/lib/session-changes'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import TurnDiffView from './TurnDiffView.vue'

/**
 * What Claude changed in the files of a session, prompt by prompt, from Claude Code's file history: a
 * list of the prompts with their files, and the diff of the file picked. For each prompt it shows what
 * `/rewind` to it would set back.
 */
const props = defineProps<{
  accountId: string
  sessionId: string
  folder: string | null
  updatedAt: string
}>()

const app = useAppStore()
const settings = useSettingsStore()

const changes = ref<SessionChanges | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
let asked = 0

async function load() {
  const request = ++asked
  loading.value = true
  try {
    const found = await window.api.sessions.changes(props.accountId, props.sessionId)
    if (request !== asked) return
    changes.value = found
    error.value = null
    if (!selected.value) {
      const latest = found.turns.at(-1)
      if (latest?.files[0]) select(latest.id, latest.files[0], 'turn')
    } else {
      void loadTexts()
    }
  } catch (cause) {
    if (request === asked) error.value = errorMessage(cause)
  } finally {
    if (request === asked) loading.value = false
  }
}

/** The latest prompt first. */
const turns = computed(() => [...(changes.value?.turns ?? [])].reverse())

// ── /rewind ──

interface Rewind {
  files: SessionFileChange[] | null
  error: string | null
}
/** The prompt whose `/rewind` is shown, and what it would do, by prompt. */
const rewindOpen = ref<string | null>(null)
const rewinds = reactive(new Map<string, Rewind>())

async function loadRewind(turnId: string) {
  const rewind: Rewind = {
    files: rewinds.get(turnId)?.files ?? null,
    error: null,
  }
  rewinds.set(turnId, rewind)
  try {
    const files = await window.api.sessions.rewindPreview(props.accountId, props.sessionId, turnId)
    rewinds.set(turnId, { files, error: null })
  } catch (cause) {
    rewinds.set(turnId, { files: null, error: errorMessage(cause) })
  }
}

function toggleRewind(turnId: string) {
  rewindOpen.value = rewindOpen.value === turnId ? null : turnId
  if (rewindOpen.value) void loadRewind(turnId)
}

// ── The file picked ──

interface Picked {
  turnId: string
  change: SessionFileChange
  kind: 'turn' | 'rewind'
}
const selected = ref<Picked | null>(null)
const texts = ref<SessionChangeTexts | null>(null)
const textsError = ref<string | null>(null)
let textsAsked = 0

function select(turnId: string, change: SessionFileChange, kind: 'turn' | 'rewind') {
  selected.value = { turnId, change, kind }
  texts.value = null
  void loadTexts()
}

async function loadTexts() {
  const picked = selected.value
  if (!picked) return
  const request = ++textsAsked
  textsError.value = null
  try {
    const found = await window.api.sessions.changeTexts(props.accountId, props.sessionId, picked.turnId, picked.change.path, picked.kind)
    if (request === textsAsked) texts.value = found
  } catch (cause) {
    if (request === textsAsked) textsError.value = errorMessage(cause)
  }
}

const isSelected = (turnId: string, change: SessionFileChange, kind: 'turn' | 'rewind') =>
  selected.value?.turnId === turnId && selected.value.change.path === change.path && selected.value.kind === kind

watch(
  () => [props.accountId, props.sessionId],
  () => {
    changes.value = null
    error.value = null
    selected.value = null
    texts.value = null
    rewindOpen.value = null
    rewinds.clear()
    void load()
  },
  { immediate: true },
)
// A session at work: its changes go on. Each look reads the whole transcript, so at most every few
// seconds, and once more after the last change.
const reload = useThrottleFn(
  () => {
    void load()
    if (rewindOpen.value) void loadRewind(rewindOpen.value)
  },
  5000,
  true,
)
watch(
  () => props.updatedAt,
  () => void reload(),
)

const ICON: Record<FileChangeKind, typeof FileDiffIcon> = {
  added: FilePlusIcon,
  modified: FileDiffIcon,
  deleted: FileMinusIcon,
}
const KIND_CLASS: Record<FileChangeKind, string> = {
  added: 'text-success',
  modified: 'text-muted-foreground',
  deleted: 'text-destructive',
}
/** In a `/rewind`, a file „added“ comes back and one „deleted“ goes again. */
const KIND_LABEL: Record<'turn' | 'rewind', Record<FileChangeKind, string>> = {
  turn: { added: 'neu', modified: 'geändert', deleted: 'gelöscht' },
  rewind: {
    added: 'kommt zurück',
    modified: 'wird zurückgesetzt',
    deleted: 'wird gelöscht',
  },
}

const shown = (change: SessionFileChange) => changePath(change.path, props.folder, app.info?.homeDir)
const separatorOf = (path: string) => (path.includes('\\') ? '\\' : '/')

// Code in the terminal's colours and font, as the file diff shows it.
const { colors, fontFamily } = useDiffStyle()
const codeStyle = computed(() => {
  const { background, color, ...vars } = colors.value
  const size = Math.max(10, Math.round(settings.settings.appearance.uiFontSize * 0.8125))
  return {
    ...vars,
    '--code-bg': background,
    '--code-fg': color,
    '--code-font': fontFamily.value,
    '--code-size': `${size}px`,
  }
})

const rowClass =
  'group/row flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50'
</script>

<template>
  <!-- Side by side where there is room, else the list above the diff. -->
  <div class="@container size-full min-h-0" :style="codeStyle">
    <div class="flex size-full min-h-0 flex-col @3xl:flex-row">
      <aside
        class="flex max-h-[45%] min-h-0 shrink-0 flex-col border-b @3xl:max-h-none @3xl:w-[22rem] @3xl:border-r @3xl:border-b-0 @5xl:w-[26rem]"
        aria-label="Änderungen nach Prompt"
      >
        <div class="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
          <span v-if="changes" class="min-w-0 flex-1 truncate">
            {{ changes.files }}
            {{ changes.files === 1 ? 'Datei' : 'Dateien' }} in
            {{ changes.turns.length }}
            {{ changes.turns.length === 1 ? 'Prompt' : 'Prompts' }} geändert
          </span>
          <span v-else class="flex-1" />
          <Spinner v-if="loading" class="size-3.5" />
          <InfoIcon
            class="size-3.5 shrink-0"
            tabindex="0"
            aria-label="Woher die Änderungen kommen"
            v-tooltip="
              'Aus Claude Codes Checkpoints, wie /rewind sie nutzt: Was Claude mit Edit und Write ändert. Änderungen über Shell-Befehle fehlen, Änderungen anderer an diesen Dateien zählen zum Prompt danach.'
            "
          />
          <Button
            variant="ghost"
            size="icon-xs"
            class="size-[24px]"
            aria-label="Neu laden"
            v-tooltip="'Neu laden'"
            :disabled="loading"
            @click="load"
          >
            <RefreshCwIcon />
          </Button>
        </div>

        <div v-if="error" class="p-4">
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Änderungen konnten nicht geladen werden</AlertTitle>
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>
        </div>
        <Empty v-else-if="changes && !changes.turns.length" class="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileDiffIcon /></EmptyMedia>
            <EmptyTitle>Keine Änderungen</EmptyTitle>
            <EmptyDescription>
              Claude hat in dieser Session keine Dateien geändert, oder Claude Code hat dazu keinen Verlauf (Checkpoints aus).
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div v-else-if="changes" class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <section v-for="turn in turns" :key="turn.id" class="flex flex-col gap-0.5 pb-3">
            <div class="flex flex-col gap-0.5 px-2 pt-1 pb-1">
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <time :datetime="turn.at ?? undefined" v-tooltip="formatDateTime(turn.at)">{{ formatRelative(turn.at) }}</time>
                <span v-if="turn.latest" v-tooltip="'Verglichen mit den Dateien, wie sie jetzt sind'">· bis jetzt</span>
                <span class="ml-auto font-mono tabular-nums">
                  <span class="text-success">+{{ changeTotals(turn.files).added }}</span>
                  <span class="text-destructive"> −{{ changeTotals(turn.files).removed }}</span>
                </span>
              </div>
              <p class="line-clamp-2 text-sm [overflow-wrap:anywhere]" :class="!turn.prompt && 'text-muted-foreground italic'">
                {{ turn.prompt ?? 'Prompt ohne Text' }}
              </p>
            </div>

            <button
              v-for="change in turn.files"
              :key="change.path"
              type="button"
              :class="cn(rowClass, isSelected(turn.id, change, 'turn') && 'bg-accent')"
              :aria-current="isSelected(turn.id, change, 'turn') || undefined"
              v-tooltip="`${change.path} · ${KIND_LABEL.turn[change.kind]}`"
              @click="select(turn.id, change, 'turn')"
            >
              <component :is="ICON[change.kind]" :class="cn('size-4 shrink-0', KIND_CLASS[change.kind])" />
              <span class="min-w-0 flex-1 truncate">
                {{ shown(change).name }}
                <span v-if="shown(change).dir" class="text-xs text-muted-foreground">{{ shown(change).dir }}</span>
              </span>
              <span v-if="change.note" class="shrink-0 text-xs text-muted-foreground">{{ noteLabel(change.note) }}</span>
              <span v-else class="shrink-0 font-mono text-xs tabular-nums">
                <span v-if="change.added" class="text-success">+{{ change.added }}</span>
                <span v-if="change.removed" class="text-destructive"> −{{ change.removed }}</span>
              </span>
            </button>

            <button
              type="button"
              :class="
                cn(rowClass, 'mt-0.5 text-xs text-muted-foreground hover:text-foreground', rewindOpen === turn.id && 'text-foreground')
              "
              :aria-expanded="rewindOpen === turn.id"
              @click="toggleRewind(turn.id)"
            >
              <RotateCcwIcon class="size-3.5 shrink-0" />
              Was <code class="font-mono">/rewind</code> hierhin zurücksetzt
            </button>
            <div v-if="rewindOpen === turn.id" class="ml-3.5 flex flex-col gap-0.5 border-l pl-2">
              <p class="px-2 pt-1 text-xs text-muted-foreground">
                „Code wiederherstellen“ auf diesen Prompt bringt die Dateien auf den Stand, bevor Claude ihn bearbeitet hat:
              </p>
              <div v-if="rewinds.get(turn.id)?.error" class="px-2 text-xs text-destructive">
                {{ rewinds.get(turn.id)!.error }}
              </div>
              <div v-else-if="!rewinds.get(turn.id)?.files" class="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                <Spinner class="size-3.5" />
                Wird verglichen …
              </div>
              <p v-else-if="!rewinds.get(turn.id)!.files!.length" class="px-2 py-1 text-xs text-muted-foreground">
                Nichts, die Dateien sind schon so.
              </p>
              <button
                v-for="change in rewinds.get(turn.id)?.files ?? []"
                :key="change.path"
                type="button"
                :class="cn(rowClass, isSelected(turn.id, change, 'rewind') && 'bg-accent')"
                :aria-current="isSelected(turn.id, change, 'rewind') || undefined"
                v-tooltip="`${change.path} · ${KIND_LABEL.rewind[change.kind]}`"
                @click="select(turn.id, change, 'rewind')"
              >
                <component :is="ICON[change.kind]" :class="cn('size-4 shrink-0', KIND_CLASS[change.kind])" />
                <span class="min-w-0 flex-1 truncate">
                  {{ shown(change).name }}
                  <span v-if="shown(change).dir" class="text-xs text-muted-foreground">{{ shown(change).dir }}</span>
                </span>
                <span v-if="change.note" class="shrink-0 text-xs text-muted-foreground">{{ noteLabel(change.note) }}</span>
                <span v-else class="shrink-0 font-mono text-xs tabular-nums">
                  <span v-if="change.added" class="text-success">+{{ change.added }}</span>
                  <span v-if="change.removed" class="text-destructive"> −{{ change.removed }}</span>
                </span>
              </button>
            </div>
          </section>
        </div>
        <div v-else class="flex flex-1 items-center justify-center p-6">
          <Spinner class="text-muted-foreground" />
        </div>
      </aside>

      <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-(--code-bg)" aria-label="Diff">
        <template v-if="selected">
          <header class="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-xs">
            <component :is="ICON[selected.change.kind]" :class="cn('size-4 shrink-0', KIND_CLASS[selected.change.kind])" />
            <span class="selectable min-w-0 truncate font-mono text-foreground" v-tooltip="selected.change.path">
              {{ shown(selected.change).dir ? `${shown(selected.change).dir}${separatorOf(selected.change.path)}` : '' }}{{ shown(selected.change).name }}
            </span>
            <span class="text-muted-foreground">{{ KIND_LABEL[selected.kind][selected.change.kind] }}</span>
            <span v-if="selected.kind === 'rewind'" class="text-muted-foreground"
              >· − wie jetzt, + nach <code class="font-mono">/rewind</code></span
            >
            <span v-if="!selected.change.note" class="ml-auto font-mono tabular-nums">
              <span class="text-success">+{{ selected.change.added }}</span>
              <span class="text-destructive"> −{{ selected.change.removed }}</span>
            </span>
          </header>
          <div class="min-h-0 flex-1 overflow-auto py-1">
            <p v-if="textsError" class="px-4 py-3 text-xs text-destructive">
              {{ textsError }}
            </p>
            <div v-else-if="!texts" class="flex items-center justify-center p-6">
              <Spinner class="text-muted-foreground" />
            </div>
            <p v-else-if="texts.note" class="px-4 py-3 text-xs text-muted-foreground">
              {{
                texts.note === 'binary'
                  ? 'Eine Binärdatei: Ihr Inhalt lässt sich nicht als Text vergleichen.'
                  : texts.note === 'tooLarge'
                    ? 'Die Datei ist zu groß, um sie hier zu vergleichen.'
                    : 'Claude Code hat diesen Stand der Datei nicht mehr (alte Sicherungen löscht es).'
              }}
            </p>
            <TurnDiffView v-else :before="texts.before" :after="texts.after" :path="selected.change.path" />
          </div>
        </template>
        <Empty v-else-if="changes?.turns.length" class="flex-1">
          <EmptyHeader>
            <EmptyTitle>Datei wählen</EmptyTitle>
            <EmptyDescription>Links eine Datei anklicken, um zu sehen, was sich an ihr geändert hat.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    </div>
  </div>
</template>
