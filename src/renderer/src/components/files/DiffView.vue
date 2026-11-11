<script setup lang="ts">
import {
  Columns2Icon,
  ExternalLinkIcon,
  FileWarningIcon,
  FoldVerticalIcon,
  MinusIcon,
  PlusIcon,
  Undo2Icon,
  UnfoldVerticalIcon,
  XIcon,
} from '@lucide/vue'
import { useElementSize, useResizeObserver } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { FileDiff } from '@shared/types'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDiffStyle } from '@/composables/useDiffStyle'
import { useFileTreeModel } from '@/composables/useFileTreeModel'
import { useGitActions } from '@/composables/useGitActions'
import { useOpenFile } from '@/composables/useOpenFile'
import { errorMessage } from '@/lib/errors'
import {
  DIFF_TAB_SIZE,
  diffColumns,
  diffLines,
  diffMode,
  isHeadRow,
  lineAtRow,
  numberDigits,
  parsePatch,
  sameDiff,
  sideBySide,
  splitOffsets,
  unchangedNote,
  type DiffLine,
  type ParsedDiff,
} from '@/lib/file-diff'
import { fileIcon } from '@/lib/file-icons'
import { absolutePath, baseName, gitDecorations, parentPath, STATUS_CLASS, STATUS_LABEL, STATUS_LETTER } from '@/lib/file-tree'
import { hasLanguage, highlightDiff, languageOf, loadLanguage } from '@/lib/syntax'
import { cn } from '@/lib/utils'
import { SEPARATOR, useFileTreeStore } from '@/stores/file-tree'
import DiffLineRow from './DiffLineRow.vue'
import ImageDiff from './ImageDiff.vue'

/**
 * The changes of a file since the last commit, as `git diff HEAD` sees them (staged and not), drawn
 * like an editor's diff in the colours of the terminal's theme, on its see-through background:
 * removed lines red, added ones green, each with one number (a removed one its old), the code highlighted.
 * It follows the file live: whenever it or git's state changes, the changes are asked again. A file
 * git doesn't know yet shows as all added, one without changes (or outside a repository) as it is.
 * The changes can also stand side by side, the old file left and the new one right, wrapped.
 */
const props = defineProps<{
  root: string
  /** The file in the root, `/`-separated. */
  path: string
  /** Shows a button that closes it (beside a terminal; as a tab it closes with its tab). */
  closable?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const fileTree = useFileTreeStore()
const openPath = useOpenFile()
const { colors, fontSize, rowHeight, fontFamily } = useDiffStyle()
// The tree of the folder: git's state for the file's mark, and the folders watched for changes.
const model = useFileTreeModel(() => props.root)

const name = computed(() => baseName(props.path))
const dir = computed(() => parentPath(props.path))
const icon = computed(() => fileIcon(props.path, { dir: false, link: false, broken: false }))
const absolute = computed(() => absolutePath(props.root, props.path, SEPARATOR))
const state = computed(() => gitDecorations(model.value.git).file(props.path))

// ── Loading, and again whenever the file or git's state changes ──

const diff = shallowRef<FileDiff | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
/** The whole file around the changes, not only a few lines of context. */
const full = ref(false)
/**
 * While only the changes show: the diff of the whole file, so they are highlighted in their file
 * (a line in a Vue file's script is TypeScript). It comes after them, so they show at once.
 */
const whole = shallowRef<readonly DiffLine[] | null>(null)
let request = 0
/** A file's first answer scrolls to its first change. */
let fresh = true
/** A line asked for (a hit of the content search), to scroll to once the whole file is there. */
let wanted: { root: string; path: string; line: number } | null = null
/** The index of the line marked for a moment. */
const markedIndex = ref<number | null>(null)
let markTimer: ReturnType<typeof setTimeout> | undefined
/** Which file (and whether whole) `diff` is of. */
let shown = ''

async function load(): Promise<void> {
  const id = ++request
  const { root, path } = props
  const of = `${root}\0${path}\0${full.value}`
  loading.value = true
  try {
    const next = await window.api.files.diff(root, path, full.value)
    if (id !== request) return
    error.value = null
    // The same as before (asked again after a commit, say): nothing is parsed, highlighted or loaded again.
    if (shown === of && diff.value && sameDiff(diff.value, next)) return
    diff.value = Object.freeze(next)
    shown = of
    if (next.patch && !next.tooLarge && !full.value && languageOf(path)) void loadWhole(id, root, path)
    else whole.value = null
  } catch (e) {
    if (id !== request) return
    diff.value = null
    shown = ''
    error.value = errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  } finally {
    if (id === request) loading.value = false
  }
}

async function loadWhole(id: number, root: string, path: string): Promise<void> {
  try {
    const all = await window.api.files.diff(root, path, true)
    if (id !== request) return
    whole.value = all.patch && !all.tooLarge ? Object.freeze(parsePatch(all.patch).lines) : null
  } catch {
    if (id === request) whole.value = null
  }
}

watch(
  () => [props.root, props.path] as const,
  () => {
    // The last file stays until the next one is there (a moment), so clicking through files doesn't flicker.
    error.value = null
    whole.value = null
    fresh = true
    void load()
  },
  { immediate: true },
)
watch(full, () => {
  fresh = true
  void load()
})

// ── A line asked for: a hit of the content search ──

// After the watches above: a new file's request isn't dropped by the one of the file, and the whole
// file asked for at once is loaded by the one of `full`.
watch(
  () => [fileTree.lineRequest, props.root, props.path] as const,
  ([request, root, path]) => {
    if (!request || request.root !== root || request.path !== path) return
    fileTree.lineRequest = null
    wanted = request
    // The whole file loads, and the line comes into view with it; already there, it scrolls at once.
    if (!full.value) full.value = true
    else if (diff.value && shown === `${root}\0${path}\0true`) void nextTick(() => scrollToLine(lines.value))
  },
  { immediate: true },
)

/** Scrolls to the line asked for, when it is one of this file; false when none is. */
function scrollToLine(list: readonly DiffLine[]): boolean {
  const target = wanted
  if (!target || target.root !== props.root || target.path !== props.path) return false
  wanted = null
  const el = scroller.value
  const index = list.findIndex((l) => (l.kind === 'context' || l.kind === 'add') && l.new === target.line)
  if (!el || index < 0) return true
  el.scrollTop = Math.max(0, lineTop(index) - el.clientHeight / 3)
  el.scrollLeft = 0
  onScroll()
  markedIndex.value = index
  clearTimeout(markTimer)
  markTimer = setTimeout(() => (markedIndex.value = null), 2000)
  return true
}
onBeforeUnmount(() => clearTimeout(markTimer))

// Its folder is watched (on Linux only open folders are): a change there, or of the repository (a commit), asks again.
let unpin = fileTree.pinDir(props.root, dir.value)
watch([() => props.root, dir], ([root, folder]) => {
  unpin()
  unpin = fileTree.pinDir(root, folder)
})

let reloadTimer: ReturnType<typeof setTimeout> | null = null
const offChanged = window.api.files.onChanged((root, dirs, _git, repo) => {
  if (root !== props.root || !(repo || dirs.includes(dir.value))) return
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void load()
  }, 120)
})
onBeforeUnmount(() => {
  unpin()
  offChanged()
  if (reloadTimer) clearTimeout(reloadTimer)
})

// ── What it shows ──

const mode = computed(() => (diff.value ? diffMode(diff.value, state.value?.status) : null))

const EMPTY: ParsedDiff = { lines: [], added: 0, removed: 0 }
const parsed = computed<ParsedDiff>(() => (diff.value && mode.value ? diffLines(diff.value, mode.value) : EMPTY))
const lines = computed(() => parsed.value.lines)

const notice = computed(() => {
  switch (mode.value) {
    case 'unchanged':
      return unchangedNote(diff.value?.patch) ?? 'Keine Änderungen seit dem letzten Commit'
    case 'plain':
      return 'Kein Git-Repository'
    case 'new':
      return state.value?.status === 'added' ? 'Neu, noch in keinem Commit' : 'Neu, Git kennt sie noch nicht'
    case 'diff':
      return parsed.value.eol ?? null
    default:
      return null
  }
})

// ── Highlighting ──

const language = computed(() => languageOf(props.path))
/** Counts the languages loaded since, so the highlighting is made again once its language is there. */
const loadedLanguages = ref(0)
watch(
  language,
  (lang) => {
    if (lang && !hasLanguage(lang)) {
      void loadLanguage(lang).then((ok) => {
        if (ok) loadedLanguages.value++
      })
    }
  },
  { immediate: true },
)
/** The lines as highlighted HTML (escaped by highlight.js); null for plain text. */
const highlighted = computed(() => {
  void loadedLanguages.value
  return language.value ? highlightDiff(lines.value, language.value, mode.value === 'diff' && !full.value ? whole.value : null) : null
})

// ── The theme's colours ──

// A new file is all added: only lightly tinted, so it reads like code.
const themeStyle = computed(() => (mode.value === 'new' ? { ...colors.value, '--diff-add': 'var(--diff-add-new)' } : colors.value))

// ── Drawing only the visible lines ──

const OVERSCAN = 12

/** One number per line: a removed one its number in the old file, the others theirs in the new; a sign for a diff and a new file. */
const withSign = computed(() => mode.value === 'diff' || mode.value === 'new')
const numberWidth = computed(() => numberDigits(lines.value))
const columns = computed(() => diffColumns(lines.value))
/** The numbers, the sign and the gaps between them and at both ends (ch). */
const gutterWidth = computed(() => numberWidth.value + (withSign.value ? 2 : 0) + 2)

const scroller = ref<HTMLElement | null>(null)
const { height: viewHeight } = useElementSize(scroller)
const scrollTop = ref(0)

// ── Side by side: the old file left, the new one right, both wrapped ──

/** Only a diff shows side by side; a new file, say, has no old side. */
const split = computed(() => fileTree.diffSplit && mode.value === 'diff')
const splitRows = computed(() => (split.value ? sideBySide(lines.value) : []))

/** A row of characters in the code's font, for how many fit in a side. */
const probe = ref<HTMLElement | null>(null)
const PROBE_CHARS = 100
const charWidth = ref(0)
/** The view's width without its scrollbar (px). */
const viewWidth = ref(0)
/** Measured as they change, and at once where a place is worked out right after the view is drawn. */
function measure() {
  if (scroller.value) viewWidth.value = scroller.value.clientWidth
  if (probe.value) charWidth.value = probe.value.getBoundingClientRect().width / PROBE_CHARS
}
useResizeObserver(scroller, measure)
useResizeObserver(probe, measure)

/** Columns a side holds: half the view less the numbers, the code's gaps and the line between the sides; a hair less, so a row never holds fewer than counted. */
const splitColumns = computed(() => {
  const ch = charWidth.value
  if (ch <= 0 || viewWidth.value <= 0) return 0
  return Math.max(1, Math.floor((viewWidth.value / 2 - 1) / ch - gutterWidth.value - 2 - 0.02))
})
/** Where the rows side by side start; null until the font is measured (a row each). */
const splitStarts = computed(() =>
  split.value && splitColumns.value > 0 ? splitOffsets(splitRows.value, lines.value, splitColumns.value) : null,
)
const contentHeight = computed(() => {
  if (!split.value) return lines.value.length * rowHeight.value
  const starts = splitStarts.value
  return (starts ? starts[splitRows.value.length]! : splitRows.value.length) * rowHeight.value
})

/** Where the line at `index` starts (px); side by side, the row it stands in. */
function lineTop(index: number): number {
  if (!split.value) return index * rowHeight.value
  measure()
  const row = splitRows.value.findIndex((r) => r.left === index || r.right === index)
  const starts = splitStarts.value
  return (row < 0 ? 0 : starts ? starts[row]! : row) * rowHeight.value
}

/** The line at the top of the view: on the right side where it has one. */
function lineAtTop(): number {
  const row = Math.floor(scrollTop.value / rowHeight.value)
  if (!split.value) return row
  const starts = splitStarts.value
  const at = splitRows.value[starts ? lineAtRow(starts, row) : row]
  return at?.right ?? at?.left ?? 0
}

/** Side by side or one below the other; the line at the top stays there. */
function toggleSplit() {
  const index = lineAtTop()
  fileTree.diffSplit = !fileTree.diffSplit
  void nextTick(() => {
    const el = scroller.value
    if (!el) return
    el.scrollTop = lineTop(index)
    el.scrollLeft = 0
    onScroll()
  })
}

/**
 * The numbers stay at the left edge while the lines scroll sideways. The background is see-through,
 * so instead of covering the lines the numbers cut them off where they pass below (`--scroll-left`).
 */
function onScroll() {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  el.style.setProperty('--scroll-left', `${el.scrollLeft}px`)
}

interface LineView {
  line: DiffLine
  index: number
  html: string | null
}

const visibleLines = computed<LineView[]>(() => {
  const height = rowHeight.value
  const first = Math.max(0, Math.floor(scrollTop.value / height) - OVERSCAN)
  const last = Math.min(lines.value.length, Math.ceil((scrollTop.value + viewHeight.value) / height) + OVERSCAN)
  const html = highlighted.value
  return lines.value.slice(first, last).map((line, i) => ({ line, index: first + i, html: html?.[first + i] ?? null }))
})

interface SplitView {
  /** The row's index. */
  key: number
  top: number
  rows: number
  /** A section's head, across both sides. */
  head: LineView | null
  /** The old file's line and the new one's; none where the row has a head, or a side no line. */
  sides: { side: 'left' | 'right'; view: LineView | null }[]
}

const visibleSplit = computed<SplitView[]>(() => {
  if (!split.value) return []
  const height = rowHeight.value
  const list = splitRows.value
  const starts = splitStarts.value
  const firstRow = Math.max(0, Math.floor(scrollTop.value / height) - OVERSCAN)
  const lastRow = Math.ceil((scrollTop.value + viewHeight.value) / height) + OVERSCAN
  const first = starts ? lineAtRow(starts, firstRow) : firstRow
  const last = Math.min(list.length, starts ? lineAtRow(starts, lastRow) + 1 : lastRow)
  const html = highlighted.value
  const all = lines.value
  const view = (index: number | null): LineView | null => (index === null ? null : { line: all[index]!, index, html: html?.[index] ?? null })
  const views: SplitView[] = []
  for (let i = first; i < last; i++) {
    const row = list[i]!
    const head = isHeadRow(row, all)
    views.push({
      key: i,
      top: (starts ? starts[i]! : i) * height,
      rows: starts ? starts[i + 1]! - starts[i]! : 1,
      head: head ? view(row.left) : null,
      sides: head
        ? []
        : [
            { side: 'left', view: view(row.left) },
            { side: 'right', view: view(row.right) },
          ],
    })
  }
  return views
})

// A new file, or the whole file asked for: its first change comes into view, a third down.
watch(lines, (list) => {
  // Lines of the file before (counted again as the new path's git state comes) don't count.
  if (!fresh || !diff.value || shown !== `${props.root}\0${props.path}\0${full.value}`) return
  fresh = false
  void nextTick(() => {
    const el = scroller.value
    if (!el) return
    if (scrollToLine(list)) return
    const index = list.findIndex((line) => line.kind === 'add' || line.kind === 'del')
    const top = index <= 0 || !full.value ? 0 : Math.max(0, lineTop(index) - el.clientHeight / 3)
    el.scrollTop = top
    el.scrollLeft = 0
    onScroll()
  })
})

function openFile() {
  void openPath(absolute.value)
}

// ── Staging and discarding ──

const gitActions = useGitActions()

/** Sections go one by one where the changes show as git wrote them; a new, deleted or moved file goes whole. */
const hunksApart = computed(
  () => mode.value === 'diff' && !full.value && !!diff.value?.repo && !/^(new file|deleted file|rename from) /m.test(diff.value.patch),
)
/** The number of each section by the index of its row. */
const hunkNumbers = computed(() => {
  const numbers = new Map<number, number>()
  lines.value.forEach((line, index) => {
    if (line.kind === 'hunk') numbers.set(index, numbers.size)
  })
  return numbers
})

async function onFile(action: 'stage' | 'unstage' | 'discard') {
  const { root, path } = props
  const done =
    action === 'stage'
      ? await gitActions.stage(root, path)
      : action === 'unstage'
        ? await gitActions.unstage(root, path)
        : !!state.value && (await gitActions.discard(root, path, state.value.status))
  if (done) void load()
}

async function onHunk(row: number, discard: boolean) {
  const number = hunkNumbers.value.get(row)
  const patch = diff.value?.patch
  if (number === undefined || !patch) return
  const { root, path } = props
  const done = discard ? await gitActions.discardHunk(root, path, patch, number) : await gitActions.stageHunk(root, path, patch, number)
  // Refused because the file changed meanwhile: its changes as they are now.
  void load()
  return done
}

const iconButton =
  'flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-accent aria-pressed:text-foreground'
</script>

<template>
  <section data-slot="file-diff" :aria-label="`Änderungen an ${name}`" class="flex min-h-0 min-w-0 flex-col" :style="themeStyle">
    <!-- The file, its state in git and what changed; how much of it to show. -->
    <header class="flex h-[34px] shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3 text-xs text-foreground">
      <component :is="icon.icon" :class="cn('size-[16px] shrink-0', icon.class)" />
      <span class="shrink-0 font-medium" v-tooltip="absolute">{{ name }}</span>
      <span v-if="dir" class="min-w-0 truncate text-muted-foreground" v-tooltip="absolute">{{ dir }}</span>
      <!-- Why the whole file shows, beside its name. -->
      <span v-if="notice" class="min-w-0 truncate text-muted-foreground/80" v-tooltip="notice">· {{ notice }}</span>
      <span class="flex-1" />
      <span
        v-if="state"
        :class="cn('shrink-0 font-mono text-[11px] font-semibold', STATUS_CLASS[state.status])"
        v-tooltip="STATUS_LABEL[state.status] + (state.staged ? ', vorgemerkt' : '')"
      >
        {{ STATUS_LETTER[state.status] }}
      </span>
      <span v-if="parsed.added || parsed.removed" class="shrink-0 font-mono text-[11px] tabular-nums">
        <span v-if="parsed.added" class="text-success">+{{ parsed.added }}</span>
        <span v-if="parsed.added && parsed.removed">&nbsp;</span>
        <span v-if="parsed.removed" class="text-destructive">−{{ parsed.removed }}</span>
      </span>
      <Spinner v-if="loading && diff" class="size-[12px] shrink-0 text-muted-foreground" />
      <!-- Like the buttons of a changed file in VS Code's source control. -->
      <template v-if="state">
        <Tooltip>
          <TooltipTrigger as-child>
            <button type="button" aria-label="Vormerken" :class="iconButton" @click="onFile('stage')">
              <PlusIcon class="size-[16px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Vormerken (git add)</TooltipContent>
        </Tooltip>
        <Tooltip v-if="state.staged">
          <TooltipTrigger as-child>
            <button type="button" aria-label="Nicht mehr vormerken" :class="iconButton" @click="onFile('unstage')">
              <MinusIcon class="size-[16px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Nicht mehr vormerken</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <button type="button" aria-label="Änderungen verwerfen" :class="iconButton" @click="onFile('discard')">
              <Undo2Icon class="size-[16px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{{ state.status === 'deleted' ? 'Wiederherstellen' : 'Änderungen verwerfen' }}</TooltipContent>
        </Tooltip>
      </template>
      <Tooltip v-if="mode === 'diff'">
        <TooltipTrigger as-child>
          <button type="button" aria-label="Nebeneinander zeigen" :aria-pressed="split" :class="iconButton" @click="toggleSplit">
            <Columns2Icon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ split ? 'Untereinander zeigen' : 'Vorher und nachher nebeneinander zeigen' }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="mode === 'diff'">
        <TooltipTrigger as-child>
          <button
            type="button"
            :aria-pressed="full"
            :aria-label="full ? 'Nur die Änderungen zeigen' : 'Ganze Datei zeigen'"
            :class="iconButton"
            @click="full = !full"
          >
            <FoldVerticalIcon v-if="full" class="size-[16px]" />
            <UnfoldVerticalIcon v-else class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ full ? 'Nur die Änderungen zeigen' : 'Ganze Datei zeigen' }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" aria-label="Datei öffnen" :class="iconButton" :disabled="mode === 'missing'" @click="openFile">
            <ExternalLinkIcon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Mit dem Standardprogramm öffnen</TooltipContent>
      </Tooltip>
      <Tooltip v-if="closable">
        <TooltipTrigger as-child>
          <button type="button" aria-label="Änderungen schließen" :class="iconButton" @click="emit('close')">
            <XIcon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Schließen</TooltipContent>
      </Tooltip>
    </header>

    <div v-if="error" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
      <FileWarningIcon class="size-[24px]" />
      <span class="font-medium text-foreground">Die Änderungen konnten nicht gelesen werden.</span>
      <span class="break-all">{{ error }}</span>
    </div>
    <div v-else-if="!diff" class="flex flex-1 justify-center pt-8">
      <Spinner class="size-[16px] text-muted-foreground" />
    </div>
    <ImageDiff v-else-if="mode === 'image'" :before="diff.image?.before ?? null" :after="diff.image?.after ?? null" />
    <div
      v-else-if="mode === 'binary' || mode === 'tooLarge' || mode === 'missing'"
      class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground"
    >
      <FileWarningIcon class="size-[24px]" />
      <span class="font-medium text-foreground">
        {{ mode === 'binary' ? 'Binärdatei, keine Textansicht.' : mode === 'tooLarge' ? 'Zu groß, um sie hier zu zeigen.' : 'Die Datei gibt es nicht.' }}
      </span>
      <button v-if="mode !== 'missing'" type="button" class="cursor-pointer text-foreground underline-offset-2 hover:underline" @click="openFile">
        Mit dem Standardprogramm öffnen
      </button>
    </div>
    <template v-else>
      <div
        ref="scroller"
        :class="cn('syntax relative min-h-0 flex-1 overflow-auto select-text', split && 'overflow-x-hidden')"
        :style="{ fontFamily, fontSize: `${fontSize}px`, tabSize: DIFF_TAB_SIZE }"
        @scroll.passive="onScroll"
      >
        <div aria-hidden="true" class="invisible absolute top-0 left-0 size-0 overflow-hidden">
          <span ref="probe" class="inline-block whitespace-pre">{{ '0'.repeat(PROBE_CHARS) }}</span>
        </div>
        <div
          class="relative min-w-full"
          :style="{ height: `${contentHeight}px`, width: split ? undefined : `calc(${gutterWidth + columns}ch + 24px)` }"
        >
          <template v-if="split">
            <template v-for="row in visibleSplit" :key="row.key">
              <DiffLineRow
                v-if="row.head"
                :line="row.head.line"
                :html="row.head.html"
                :top="row.top"
                :height="rowHeight"
                :gutter-width="gutterWidth"
                :number-width="numberWidth"
                :with-sign="withSign"
                :hunk-actions="hunksApart"
                @stage="onHunk(row.head.index, false)"
                @discard="onHunk(row.head.index, true)"
              />
              <template v-for="half in row.sides" :key="half.side">
                <DiffLineRow
                  v-if="half.view"
                  :class="half.side === 'right' && 'border-l'"
                  :side="half.side"
                  :line="half.view.line"
                  :html="half.view.html"
                  :top="row.top"
                  :height="rowHeight"
                  :rows="row.rows"
                  :gutter-width="gutterWidth"
                  :number-width="numberWidth"
                  :with-sign="withSign"
                  :marked="half.view.index === markedIndex"
                />
                <!-- No line on this side: lines only removed, or only added. Hatched, like VS Code's. -->
                <div
                  v-else
                  aria-hidden="true"
                  :class="cn('absolute top-0', half.side === 'right' && 'border-l')"
                  :style="{
                    left: half.side === 'left' ? '0px' : '50%',
                    right: half.side === 'left' ? '50%' : '0px',
                    transform: `translateY(${row.top}px)`,
                    height: `${row.rows * rowHeight}px`,
                    backgroundImage: 'repeating-linear-gradient(-45deg, var(--diff-filler) 0 1px, transparent 1px 7px)',
                  }"
                />
              </template>
            </template>
          </template>
          <template v-else>
            <DiffLineRow
              v-for="view in visibleLines"
              :key="view.index"
              :line="view.line"
              :html="view.html"
              :top="view.index * rowHeight"
              :height="rowHeight"
              :gutter-width="gutterWidth"
              :number-width="numberWidth"
              :with-sign="withSign"
              :marked="view.index === markedIndex"
              :hunk-actions="hunksApart && view.line.kind === 'hunk'"
              @stage="onHunk(view.index, false)"
              @discard="onHunk(view.index, true)"
            />
          </template>
        </div>
        <p v-if="lines.length === 0" class="px-4 pt-3 text-center text-xs text-muted-foreground">Die Datei ist leer.</p>
      </div>
    </template>
  </section>
</template>
