<script setup lang="ts">
import { ExternalLinkIcon, FileWarningIcon, FoldVerticalIcon, UnfoldVerticalIcon, XIcon } from '@lucide/vue'
import { useElementSize } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { FileDiff } from '@shared/types'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useFileTreeModel } from '@/composables/useFileTreeModel'
import { buildFontStack, useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { codeColor } from '@/lib/code-colors'
import { attempt, errorMessage } from '@/lib/errors'
import { fileLines, lineColumns, parsePatch, type DiffLine, type ParsedDiff } from '@/lib/file-diff'
import { fileIcon } from '@/lib/file-icons'
import { absolutePath, baseName, gitDecorations, parentPath, STATUS_CLASS, STATUS_LABEL, STATUS_LETTER } from '@/lib/file-tree'
import { hasLanguage, highlightDiff, languageOf, loadLanguage } from '@/lib/syntax'
import { cn } from '@/lib/utils'
import { SEPARATOR, useFileTreeStore } from '@/stores/file-tree'
import { useSettingsStore } from '@/stores/settings'

/**
 * The changes of a file since the last commit, as `git diff HEAD` sees them (staged and not), drawn
 * like an editor's diff in the colours of the terminal's theme, on its see-through background:
 * removed lines red, added ones green, each with one number (a removed one its old), the code highlighted.
 * It follows the file live: whenever it or git's state changes, the changes are asked again. A file
 * git doesn't know yet shows as all added, one without changes (or outside a repository) as it is.
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
const settings = useSettingsStore()
const { palette, containerBackground } = useTerminalAppearance()
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

async function load(): Promise<void> {
  const id = ++request
  const { root, path } = props
  loading.value = true
  try {
    const next = await window.api.files.diff(root, path, full.value)
    if (id !== request) return
    diff.value = Object.freeze(next)
    error.value = null
    if (next.patch && !next.tooLarge && !full.value && languageOf(path)) void loadWhole(id, root, path)
    else whole.value = null
  } catch (e) {
    if (id !== request) return
    diff.value = null
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

// Its folder is watched (on Linux only open folders are), and a change there or in git asks again.
let unpin = fileTree.pinDir(props.root, dir.value)
watch([() => props.root, dir], ([root, folder]) => {
  unpin()
  unpin = fileTree.pinDir(root, folder)
})

let reloadTimer: ReturnType<typeof setTimeout> | null = null
const offChanged = window.api.files.onChanged((root, dirs, git) => {
  if (root !== props.root || !(git || dirs.includes(dir.value))) return
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

type Mode = 'diff' | 'new' | 'unchanged' | 'plain' | 'binary' | 'tooLarge' | 'missing'

const mode = computed<Mode | null>(() => {
  const d = diff.value
  if (!d) return null
  if (d.tooLarge) return 'tooLarge'
  if (d.binary) return 'binary'
  if (d.patch) return 'diff'
  if (d.missing || d.text === null) return 'missing'
  if (!d.repo) return 'plain'
  return state.value?.status === 'untracked' || state.value?.status === 'added' ? 'new' : 'unchanged'
})

const EMPTY: ParsedDiff = { lines: [], added: 0, removed: 0 }
const parsed = computed<ParsedDiff>(() => {
  const d = diff.value
  if (!d) return EMPTY
  if (mode.value === 'diff') return parsePatch(d.patch)
  if (d.text !== null && (mode.value === 'new' || mode.value === 'unchanged' || mode.value === 'plain')) {
    return fileLines(d.text, mode.value === 'new' ? 'add' : 'context')
  }
  return EMPTY
})
const lines = computed(() => parsed.value.lines)

const notice = computed(() => {
  switch (mode.value) {
    case 'unchanged':
      return 'Keine Änderungen seit dem letzten Commit'
    case 'plain':
      return 'Kein Git-Repository'
    case 'new':
      return 'Neu, Git kennt sie noch nicht'
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

/**
 * The terminal's palette as variables: the code's colours (`.syntax` in main.css) and the lines' tints,
 * calmed for code (a terminal's blue can be too loud or too dark to read).
 */
const codeColors = computed(() => {
  const p = palette.value
  const code = (color: string) => codeColor(color, p.background)
  return { red: code(p.red), green: code(p.green), yellow: code(p.yellow), blue: code(p.blue), magenta: code(p.magenta), cyan: code(p.cyan) }
})
const themeStyle = computed(() => {
  const p = palette.value
  const c = codeColors.value
  const tint = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, transparent)`
  return {
    background: containerBackground.value,
    color: p.foreground,
    '--syn-red': c.red,
    '--syn-green': c.green,
    '--syn-yellow': c.yellow,
    '--syn-blue': c.blue,
    '--syn-magenta': c.magenta,
    '--syn-cyan': c.cyan,
    '--syn-comment': tint(p.foreground, 50),
    // A new file is all added: only lightly tinted, so it reads like code.
    '--diff-add': tint(c.green, mode.value === 'new' ? 6 : 15),
    '--diff-add-gutter': tint(c.green, 24),
    '--diff-del': tint(c.red, 15),
    '--diff-del-gutter': tint(c.red, 24),
    '--diff-hunk': tint(p.foreground, 6),
    '--diff-number': tint(p.foreground, 40),
    '--diff-add-number': c.green,
    '--diff-del-number': c.red,
  }
})

// ── Drawing only the visible lines ──

const TAB_SIZE = 4
/** Longer lines are cut, so one minified line doesn't make the view thousands of screens wide. */
const MAX_COLUMNS = 2000

const fontSize = computed(() => Math.max(10, Math.round(settings.settings.appearance.uiFontSize * 0.93)))
const rowHeight = computed(() => Math.round(fontSize.value * 1.55))
const fontFamily = computed(() => buildFontStack(settings.settings.terminal.fontFamily))
const OVERSCAN = 12

/** One number per line: a removed one its number in the old file, the others theirs in the new; a sign for a diff and a new file. */
const withSign = computed(() => mode.value === 'diff' || mode.value === 'new')
const numberWidth = computed(() => {
  let most = 1
  for (const line of lines.value) most = Math.max(most, line.old ?? 0, line.new ?? 0)
  return String(most).length
})
const columns = computed(() => {
  let most = 0
  for (const line of lines.value) most = Math.max(most, lineColumns(line.text, TAB_SIZE))
  return Math.min(most, MAX_COLUMNS)
})
/** The numbers, the sign and the gaps between them and at both ends (ch). */
const gutterWidth = computed(() => numberWidth.value + (withSign.value ? 2 : 0) + 2)

const scroller = ref<HTMLElement | null>(null)
const { height: viewHeight } = useElementSize(scroller)
const scrollTop = ref(0)

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
  text: string
  html: string | null
}

const visibleLines = computed<LineView[]>(() => {
  const height = rowHeight.value
  const first = Math.max(0, Math.floor(scrollTop.value / height) - OVERSCAN)
  const last = Math.min(lines.value.length, Math.ceil((scrollTop.value + viewHeight.value) / height) + OVERSCAN)
  const html = highlighted.value
  return lines.value.slice(first, last).map((line, i) => {
    const long = line.text.length > MAX_COLUMNS
    return {
      line,
      index: first + i,
      text: long ? `${line.text.slice(0, MAX_COLUMNS)} …` : line.text,
      html: long ? null : (html?.[first + i] ?? null),
    }
  })
})

// A new file, or the whole file asked for: its first change comes into view, a third down.
watch(lines, (list) => {
  if (!fresh || !diff.value) return
  fresh = false
  void nextTick(() => {
    const el = scroller.value
    if (!el) return
    const index = list.findIndex((line) => line.kind === 'add' || line.kind === 'del')
    const top = index <= 0 || !full.value ? 0 : Math.max(0, index * rowHeight.value - el.clientHeight / 3)
    el.scrollTop = top
    el.scrollLeft = 0
    onScroll()
  })
})

const ROW_CLASS: Record<DiffLine['kind'], string> = {
  context: '',
  add: 'bg-(--diff-add)',
  del: 'bg-(--diff-del)',
  hunk: 'bg-(--diff-hunk) text-(--syn-comment) italic',
}
const GUTTER_CLASS: Record<DiffLine['kind'], string> = {
  context: 'text-(--diff-number)',
  add: 'bg-(--diff-add-gutter) text-(--diff-add-number)',
  del: 'bg-(--diff-del-gutter) text-(--diff-del-number)',
  hunk: 'bg-(--diff-hunk) text-(--diff-number)',
}
const SIGN: Record<DiffLine['kind'], string> = { context: ' ', add: '+', del: '−', hunk: ' ' }

function openFile() {
  void attempt(() => window.api.app.openPath(absolute.value), 'Datei konnte nicht geöffnet werden')
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
        class="syntax relative min-h-0 flex-1 overflow-auto select-text"
        :style="{ fontFamily, fontSize: `${fontSize}px`, tabSize: TAB_SIZE }"
        @scroll.passive="onScroll"
      >
        <div
          class="relative min-w-full"
          :style="{ height: `${lines.length * rowHeight}px`, width: `calc(${gutterWidth + columns}ch + 24px)` }"
        >
          <div
            v-for="view in visibleLines"
            :key="view.index"
            class="absolute inset-x-0 top-0 flex whitespace-pre"
            :style="{ transform: `translateY(${view.index * rowHeight}px)`, height: `${rowHeight}px`, lineHeight: `${rowHeight}px` }"
          >
            <span
              :class="cn('sticky left-0 z-10 flex shrink-0 justify-end gap-[1ch] px-[1ch] tabular-nums select-none', GUTTER_CLASS[view.line.kind])"
              :style="{ width: `${gutterWidth}ch` }"
            >
              <span v-if="view.line.kind === 'hunk'" class="flex-1 text-left">⋯</span>
              <template v-else>
                <span class="text-right" :style="{ width: `${numberWidth}ch` }">{{ view.line.new ?? view.line.old ?? '' }}</span>
                <span v-if="withSign" class="w-[1ch]">{{ SIGN[view.line.kind] }}</span>
              </template>
            </span>
            <!-- Cut off where it passes below the numbers (see onScroll). -->
            <span
              v-if="view.html !== null"
              :class="cn('flex-1 pl-[1ch] [clip-path:inset(0_0_0_var(--scroll-left,0px))]', ROW_CLASS[view.line.kind])"
              v-html="view.html"
            />
            <span v-else :class="cn('flex-1 pl-[1ch] [clip-path:inset(0_0_0_var(--scroll-left,0px))]', ROW_CLASS[view.line.kind])">{{
              view.text
            }}</span>
          </div>
        </div>
        <p v-if="lines.length === 0" class="px-4 pt-3 text-center text-xs text-muted-foreground">Die Datei ist leer.</p>
      </div>
    </template>
  </section>
</template>
