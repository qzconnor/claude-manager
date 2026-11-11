<script lang="ts">
import type { FileDiff } from '@shared/types'
import type { DiffLine, DiffMode, ParsedDiff } from '@/lib/file-diff'

interface Entry {
  diff: FileDiff | null
  error: string | null
  mode: DiffMode | null
  parsed: ParsedDiff
  hash: string | null
  columns: number
  digits: number
  /**
   * The diff of the whole file, so its changes are highlighted in their file (a line in a Vue file's
   * script is TypeScript). For a file shown the first time it comes after them, so they show at once.
   */
  whole: readonly DiffLine[] | null
  /** The highlighted lines, and how many languages were loaded when they were made. */
  html: (string | null)[] | null
  htmlFor: number
  /** Where its lines start wrapped (`wrapOffsets`), and at how many columns they were counted. */
  offsets: Uint32Array | null
  wrapWidth: number
}

/**
 * What a review keeps while its tab is hidden (it is drawn only while shown), by folder: the diffs,
 * so they are there at once, the files folded or unfolded by hand, and where it was scrolled to.
 */
interface Kept {
  entries: Map<string, Entry>
  flipped: string[]
  top: number
  left: number
}
const kept = new Map<string, Kept>()
/** Folders kept, the least recently left dropped first. */
const MAX_KEPT = 4
</script>

<script setup lang="ts">
import { ArrowDownIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, FileDiffIcon, WrapTextIcon, XIcon } from '@lucide/vue'
import { useElementSize } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowReactive, watch } from 'vue'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDiffStyle } from '@/composables/useDiffStyle'
import { useFileTreeModel } from '@/composables/useFileTreeModel'
import { useOpenFile } from '@/composables/useOpenFile'
import { errorMessage } from '@/lib/errors'
import {
  DIFF_TAB_SIZE,
  diffColumns,
  diffHash,
  diffLines,
  diffMode,
  lineAtRow,
  numberDigits,
  parsePatch,
  wrapOffsets,
  type SeenState,
} from '@/lib/file-diff'
import { absolutePath, changedFiles, folderName, gitDecorations, parentPath, treeOrder, untrackedFolders } from '@/lib/file-tree'
import { hasLanguage, highlightDiff, languageOf, loadLanguage } from '@/lib/syntax'
import { SEPARATOR, useFileTreeStore } from '@/stores/file-tree'
import ChangesFileHeader from './ChangesFileHeader.vue'
import DiffLineRow from './DiffLineRow.vue'

/**
 * All changes of a folder since the last commit, file below file, to review them in one go like a
 * pull request: each file with its head (which stays at the top while its lines pass), its lines drawn
 * like those of a single file's changes. A file marked as seen folds, so the next one follows; one that
 * changes after is to be looked at again. It follows the folder live, as Claude goes on working.
 */
const props = defineProps<{
  root: string
  /** Shows a button that closes it (beside a terminal; as a tab it closes with its tab). */
  closable?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const fileTree = useFileTreeStore()
const openPath = useOpenFile()
const { colors, fontSize, rowHeight, fontFamily } = useDiffStyle()
// The tree of the folder: git's state, the list of its files, and its folders watched.
const model = useFileTreeModel(() => props.root)
const rootName = computed(() => folderName(props.root))
const git = computed(() => model.value.git)
const decorations = computed(() => gitDecorations(git.value))
/** Whether git was asked once: until then no repository may just mean not known yet. */
const checked = ref(false)
watch(
  () => props.root,
  (root) => {
    checked.value = false
    void window.api.files
      .status(root)
      .catch(() => null)
      .finally(() => {
        if (root === props.root) checked.value = true
      })
  },
  { immediate: true },
)

// ── The changed files ──

/** Files in folders that are new as a whole come from the list of all files. */
watch(
  () => untrackedFolders(git.value).length > 0 && !model.value.searchLoading && (!model.value.search || model.value.searchStale),
  (load) => {
    if (load) void fileTree.loadSearch(model.value)
  },
  { immediate: true },
)
/**
 * The most files the review shows. Each one costs a call of git and a card; far more new files are
 * mostly a folder that belongs in .gitignore (node_modules, a build), not changes to review.
 */
const MAX_FILES = 500
/** All changed files in the order of the tree. */
const allPaths = computed(() => treeOrder(changedFiles(git.value, model.value.search?.paths)))
/** Those the review shows. */
const paths = computed(() => (allPaths.value.length > MAX_FILES ? allPaths.value.slice(0, MAX_FILES) : allPaths.value))
const notShown = computed(() => allPaths.value.length - paths.value.length)
/** Folders git sees as new as a whole: with too many files, likely the cause. */
const newFolders = computed(() => untrackedFolders(git.value).slice(0, 3).join(', '))

// ── Their diffs, a few at a time, and again when they change ──

const NO_LINES: ParsedDiff = { lines: [], added: 0, removed: 0 }

const restored = kept.get(props.root)
kept.delete(props.root)
const entries = shallowReactive(new Map<string, Entry>(restored?.entries))
const queue = new Set<string>()
let running = 0
/** Diffs asked for at once. */
const CONCURRENCY = 4

function pump(): void {
  while (running < CONCURRENCY && queue.size > 0) {
    const path = queue.values().next().value!
    queue.delete(path)
    running++
    void load(path).finally(() => {
      running--
      pump()
    })
  }
}

async function load(path: string): Promise<void> {
  const root = props.root
  try {
    const diff = await window.api.files.diff(root, path, false)
    if (root !== props.root || !paths.value.includes(path)) return
    const mode = diffMode(diff, decorations.value.file(path)?.status)
    const hash = diffHash(diff)
    const before = entries.get(path)
    // Unchanged: nothing is drawn or highlighted again.
    if (before?.hash === hash && before.mode === mode) return
    const parsed = diffLines(diff, mode)
    const inFile = mode === 'diff' && !!diff.patch && !diff.tooLarge && !!languageOf(path)
    // A file on show already waits for the whole one, so its lines don't flash up without colours.
    const whole = inFile && before ? await wholeOf(root, path) : null
    if (root !== props.root || !paths.value.includes(path)) return
    entries.set(path, {
      diff: Object.freeze(diff),
      error: null,
      mode,
      parsed,
      hash,
      columns: diffColumns(parsed.lines),
      digits: numberDigits(parsed.lines),
      whole,
      html: null,
      htmlFor: -1,
      offsets: null,
      wrapWidth: 0,
    })
    if (!inFile || before) return
    // A new one shows at once, highlighted hunk by hunk, and again in its file once that is there.
    const later = await wholeOf(root, path)
    const entry = entries.get(path)
    if (later && root === props.root && entry?.hash === hash) entries.set(path, { ...entry, whole: later, html: null, htmlFor: -1 })
  } catch (error) {
    if (root !== props.root) return
    const message = errorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    entries.set(path, { diff: null, error: message, mode: null, parsed: NO_LINES, hash: null, columns: 0, digits: 1, whole: null, html: null, htmlFor: -1, offsets: null, wrapWidth: 0 })
  }
}

/** The diff of the whole file for its highlighting; null without (the changes are highlighted hunk by hunk). */
async function wholeOf(root: string, path: string): Promise<readonly DiffLine[] | null> {
  try {
    const all = await window.api.files.diff(root, path, true)
    return all.patch && !all.tooLarge ? Object.freeze(parsePatch(all.patch).lines) : null
  } catch {
    return null
  }
}

watch(
  () => [props.root, paths.value.join('\n')],
  ([root], before) => {
    if (before && root !== before[0]) {
      entries.clear()
      queue.clear()
    }
    const now = new Set(paths.value)
    for (const path of entries.keys()) if (!now.has(path)) entries.delete(path)
    for (const path of queue) if (!now.has(path)) queue.delete(path)
    for (const path of paths.value) if (!entries.has(path)) queue.add(path)
    pump()
  },
  { immediate: true },
)
// Kept while hidden: asked again, as files may have changed meanwhile.
if (restored) {
  for (const path of entries.keys()) queue.add(path)
  pump()
}

// The folders of the files are watched (on Linux only open folders are); a change there, or in git, asks again.
const pins = new Map<string, () => void>()
watch(
  () => [props.root, [...new Set(paths.value.map(parentPath))].join('\n')] as const,
  ([root, list], before) => {
    if (before && root !== before[0]) {
      for (const unpin of pins.values()) unpin()
      pins.clear()
    }
    const dirs = new Set(list ? list.split('\n') : [])
    for (const [dir, unpin] of pins) {
      if (dirs.has(dir)) continue
      unpin()
      pins.delete(dir)
    }
    for (const dir of dirs) if (!pins.has(dir)) pins.set(dir, fileTree.pinDir(root, dir))
  },
  { immediate: true },
)

const stale = new Set<string>()
let reloadTimer: ReturnType<typeof setTimeout> | null = null
const offChanged = window.api.files.onChanged((root, dirs, gitChanged) => {
  if (root !== props.root) return
  for (const path of paths.value) if (gitChanged || dirs.includes(parentPath(path))) stale.add(path)
  if (stale.size === 0 || reloadTimer) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    for (const path of stale) queue.add(path)
    stale.clear()
    pump()
  }, 150)
})
onBeforeUnmount(() => {
  offChanged()
  if (reloadTimer) clearTimeout(reloadTimer)
  for (const unpin of pins.values()) unpin()
  queue.clear()
})

// ── Highlighting ──

/** Counts the languages loaded since, so a file is highlighted again once its language is there. */
const loadedLanguages = ref(0)
const asked = new Set<string>()
watch(
  () => [...new Set(paths.value.map(languageOf))].join(','),
  () => {
    for (const lang of new Set(paths.value.map(languageOf))) {
      if (!lang || hasLanguage(lang) || asked.has(lang)) continue
      asked.add(lang)
      void loadLanguage(lang).then((ok) => {
        if (ok) loadedLanguages.value++
      })
    }
  },
  { immediate: true },
)

/** A file's lines as highlighted HTML, made once it is in view and kept. */
function htmlOf(path: string, entry: Entry): (string | null)[] | null {
  const loaded = loadedLanguages.value
  if (entry.htmlFor !== loaded) {
    const lang = languageOf(path)
    entry.html = lang ? highlightDiff(entry.parsed.lines, lang, entry.mode === 'diff' ? entry.whole : null) : null
    entry.htmlFor = loaded
  }
  return entry.html
}

// ── Seen, and folded ──

function seenState(path: string): SeenState {
  const mark = fileTree.seenOf(props.root, path)
  if (!mark) return 'no'
  const hash = entries.get(path)?.hash
  return !hash || hash === mark ? 'yes' : 'changed'
}

/** Files folded or unfolded by hand, against what they are by default: folded when seen. */
const flipped = reactive(new Set<string>(restored?.flipped))
const isCollapsed = (path: string) => (seenState(path) === 'yes') !== flipped.has(path)
function setCollapsed(path: string, collapsed: boolean) {
  if (collapsed === (seenState(path) === 'yes')) flipped.delete(path)
  else flipped.add(path)
}

const seenCount = computed(() => paths.value.filter((path) => seenState(path) === 'yes').length)
const allCollapsed = computed(() => paths.value.length > 0 && paths.value.every(isCollapsed))
function toggleAll() {
  const collapse = !allCollapsed.value
  for (const path of paths.value) setCollapsed(path, collapse)
}

function toggleSeen(path: string) {
  const hash = entries.get(path)?.hash ?? null
  flipped.delete(path)
  fileTree.setSeen(props.root, path, seenState(path) === 'yes' ? null : hash)
  // Folded with its head at or above the top: the head goes to the top, the next file right below.
  void nextTick(() => {
    const block = layout.value.blocks.find((b) => b.path === path)
    const el = scroller.value
    if (block && el && block.top - RING < el.scrollTop) el.scrollTop = Math.max(0, block.top - RING)
  })
}

/** Scrolls to the next file not seen yet below the top, else the first one from the start. */
function nextUnseen() {
  const el = scroller.value
  if (!el) return
  const blocks = layout.value.blocks.filter((b) => seenState(b.path) !== 'yes')
  const next = blocks.find((b) => b.top - RING > el.scrollTop + 1) ?? blocks[0]
  if (next) el.scrollTop = Math.max(0, next.top - RING)
}

// ── Laying out the files ──

/**
 * Each file is a card (px): its head, its lines, and some space below them so the rounded corners
 * have none under them; between the cards some space, at the sides `INSET`, and `PAD` at the end and
 * above the view, so the lines end there and a head held at the top keeps its distance too.
 */
const HEAD = 34
const BOTTOM = 6
const GAP = 10
const PAD = 8
/** The cards' rings lie outside them: the top one starts this far below the view's edge (px), so its ring shows. */
const RING = 1
const INSET = 8

interface Block {
  path: string
  /** Its card's top, where its head is; its lines start below it. */
  top: number
  bodyTop: number
  /** Its card's bottom. */
  end: number
  entry: Entry | undefined
  collapsed: boolean
  /** Its lines, none while folded or when it has a note instead. */
  lines: readonly DiffLine[]
  note: string | null
  withSign: boolean
  gutterWidth: number
  /** Where its lines start in rows while they wrap; null while they scroll sideways. */
  offsets: Uint32Array | null
}

/** Why a file shows no lines. */
function noteOf(entry: Entry | undefined): string | null {
  if (!entry) return 'Wird geladen…'
  if (entry.error) return `Die Änderungen konnten nicht gelesen werden: ${entry.error}`
  switch (entry.mode) {
    case 'binary':
      return 'Binärdatei, keine Textansicht.'
    case 'tooLarge':
      return 'Zu groß, um sie hier zu zeigen.'
    case 'missing':
      return 'Die Datei gibt es nicht mehr.'
    case 'unchanged':
      return 'Keine Änderungen mehr seit dem letzten Commit.'
    default:
      return entry.parsed.lines.length === 0 ? 'Die Datei ist leer.' : null
  }
}

const scroller = ref<HTMLElement | null>(null)
const { width: viewWidth, height: viewHeight } = useElementSize(scroller)

/** Long lines wrap (the default, saved), or the view scrolls sideways. */
const wrap = computed(() => fileTree.diffWrap)
/** A character's width in the code's font (px), measured on a row of them. */
const probe = ref<HTMLElement | null>(null)
const { width: probeWidth } = useElementSize(probe)
const PROBE_CHARS = 100
const charWidth = computed(() => probeWidth.value / PROBE_CHARS)

/** Where a file's lines start wrapped in its card; counted again once the card is wider or narrower. */
function offsetsOf(entry: Entry, gutterWidth: number): Uint32Array | null {
  const ch = charWidth.value
  if (!wrap.value || ch <= 0 || viewWidth.value <= 0) return null
  // The card less the numbers and the code's gaps at both ends; a hair less, so a row never holds fewer than counted.
  const columns = Math.max(1, Math.floor((viewWidth.value - INSET * 2) / ch - gutterWidth - 2 - 0.02))
  if (!entry.offsets || entry.wrapWidth !== columns) {
    entry.offsets = wrapOffsets(entry.parsed.lines, columns)
    entry.wrapWidth = columns
  }
  return entry.offsets
}

const layout = computed(() => {
  const row = rowHeight.value
  const blocks: Block[] = []
  let top = RING
  let widest = 0
  for (const path of paths.value) {
    const entry = entries.get(path)
    const collapsed = isCollapsed(path)
    const note = collapsed ? null : noteOf(entry)
    const lines = collapsed || note || !entry ? [] : entry.parsed.lines
    const withSign = entry?.mode === 'diff' || entry?.mode === 'new'
    const gutterWidth = (entry?.digits ?? 1) + (withSign ? 2 : 0) + 2
    const bodyTop = top + HEAD
    const offsets = entry && lines.length ? offsetsOf(entry, gutterWidth) : null
    const rows = offsets ? offsets[lines.length]! : lines.length
    const end = collapsed ? bodyTop : bodyTop + (note ? row * 2 : rows * row + BOTTOM)
    if (lines.length && !offsets) widest = Math.max(widest, gutterWidth + (entry?.columns ?? 0))
    blocks.push({ path, top, bodyTop, end, entry, collapsed, lines, note, withSign, gutterWidth, offsets })
    top = end + GAP
  }
  return { blocks, height: top - GAP + PAD, widest }
})

// ── Drawing only what is in view ──

const scrollTop = ref(0)
/** Drawn beyond the view, so scrolling doesn't show gaps (px). */
const OVERSCAN = 400

/**
 * As in a single file's changes, the numbers cut the lines off where they pass below them; and the
 * lines end at the right side of their cards (`--clip-right`).
 */
function onScroll() {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  el.style.setProperty('--scroll-left', `${el.scrollLeft}px`)
  el.style.setProperty('--clip-right', `${Math.max(0, el.scrollWidth - el.scrollLeft - el.clientWidth) + INSET}px`)
}
watch([() => layout.value.widest, viewWidth, wrap], () => void nextTick(onScroll), { flush: 'post' })

// Back where it was when its tab was left.
let restoreScroll = restored ? { top: restored.top, left: restored.left } : null
watch(
  scroller,
  (el) => {
    if (!el || !restoreScroll) return
    el.scrollTop = restoreScroll.top
    el.scrollLeft = restoreScroll.left
    restoreScroll = null
    onScroll()
  },
  { flush: 'post' },
)
onBeforeUnmount(() => {
  kept.set(props.root, {
    entries: new Map(entries),
    flipped: [...flipped],
    top: scroller.value?.scrollTop ?? 0,
    left: scroller.value?.scrollLeft ?? 0,
  })
  for (const root of kept.keys()) if (kept.size > MAX_KEPT) kept.delete(root)
})

const visible = computed(() => {
  const row = rowHeight.value
  const from = scrollTop.value - OVERSCAN
  const to = scrollTop.value + viewHeight.value + OVERSCAN
  const blocks: Block[] = []
  const lines: { key: string; block: Block; line: DiffLine; html: string | null; top: number; rows: number; clip: number }[] = []
  const held = stuck.value
  const heldBottom = held ? scrollTop.value + RING + HEAD + held.offset : 0
  for (const block of layout.value.blocks) {
    if (block.end < from) continue
    if (block.top > to) break
    blocks.push(block)
    if (block.lines.length === 0 || !block.entry || to < block.bodyTop) continue
    const { offsets } = block
    const firstRow = Math.max(0, Math.floor((from - block.bodyTop) / row))
    const lastRow = Math.ceil((to - block.bodyTop) / row)
    const first = offsets ? lineAtRow(offsets, firstRow) : firstRow
    const last = Math.min(block.lines.length, offsets ? lineAtRow(offsets, lastRow) + 1 : lastRow)
    const html = first < last ? htmlOf(block.path, block.entry) : null
    for (let i = first; i < last; i++) {
      const top = lineTop(block, i)
      const rows = offsets ? offsets[i + 1]! - offsets[i]! : 1
      // Below the head held at the top the lines end, so none shows beside its rounded corners.
      const clip = held?.block === block ? Math.max(0, heldBottom - top) : 0
      if (clip >= rows * row) continue
      lines.push({ key: `${block.path}\n${i}`, block, line: block.lines[i]!, html: html?.[i] ?? null, top, rows, clip })
    }
  }
  return { blocks, lines }
})

/** The card of the file whose head is held at the top starts below it there, its ring joining the head's. */
function cardClip(block: Block): string | undefined {
  const held = stuck.value
  if (held?.block !== block) return undefined
  return `inset(${scrollTop.value + RING + HEAD + held.offset - block.top}px -4px -4px -4px)`
}

/** Where a line of a file starts (px). */
function lineTop(block: Block, index: number): number {
  return block.bodyTop + (block.offsets ? block.offsets[index]! : index) * rowHeight.value
}

/** A place in the review: a line of a file (-1: its head), and how far into it (px). */
interface Anchor {
  path: string
  line: number
  offset: number
}
function anchorAt(y: number): Anchor | null {
  const block = layout.value.blocks.find((b) => b.end > y)
  if (!block) return null
  if (y < block.bodyTop || block.lines.length === 0) return { path: block.path, line: -1, offset: y - block.top }
  const row = Math.floor((y - block.bodyTop) / rowHeight.value)
  const line = block.offsets ? lineAtRow(block.offsets, row) : Math.min(block.lines.length - 1, row)
  return { path: block.path, line, offset: y - lineTop(block, line) }
}
function placeOf(anchor: Anchor): number | null {
  const block = layout.value.blocks.find((b) => b.path === anchor.path)
  if (!block) return null
  if (anchor.line < 0 || anchor.line >= block.lines.length) return block.top + anchor.offset
  return lineTop(block, anchor.line) + Math.min(anchor.offset, rowHeight.value - 1)
}

/** Wraps long lines or not; the line below the head at the top stays where it is. */
function toggleWrap() {
  const el = scroller.value
  const anchor = el ? anchorAt(el.scrollTop + HEAD) : null
  fileTree.diffWrap = !fileTree.diffWrap
  if (!el || !anchor) return
  void nextTick(() => {
    const place = placeOf(anchor)
    if (place === null) return
    el.scrollTop = Math.max(0, place - HEAD)
    onScroll()
  })
}

/** The head of the file whose lines pass the top of the view stays there, until the end of its card pushes it out. */
const stuck = computed(() => {
  // Where a head stands at the top: as far below the edge as the first card.
  const top = scrollTop.value + RING
  const block = layout.value.blocks.find((b) => !b.collapsed && b.top < top && b.end > top)
  return block ? { block, offset: Math.min(0, block.end - top - HEAD) } : null
})

// ── Totals ──

const totals = computed(() => {
  let added = 0
  let removed = 0
  for (const path of paths.value) {
    const parsed = entries.get(path)?.parsed
    added += parsed?.added ?? 0
    removed += parsed?.removed ?? 0
  }
  return { added, removed }
})
const loading = computed(() => paths.value.some((path) => !entries.has(path)))

const absolute = (path: string) => absolutePath(props.root, path, SEPARATOR)

function openFile(path: string) {
  void openPath(absolute(path))
}

const iconButton =
  'flex size-[24px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-accent aria-pressed:text-foreground'
</script>

<template>
  <section data-slot="changes-review" :aria-label="`Alle Änderungen in ${rootName}`" class="flex min-h-0 min-w-0 flex-col" :style="colors">
    <!-- The folder, how far the review is, and its actions. -->
    <header class="flex h-[34px] shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3 text-xs text-foreground">
      <FileDiffIcon class="size-[16px] shrink-0 text-muted-foreground" />
      <span class="shrink-0 font-medium">Alle Änderungen</span>
      <span class="min-w-0 truncate text-muted-foreground" v-tooltip="root">{{ rootName }}</span>
      <span v-if="paths.length" class="shrink-0 text-muted-foreground tabular-nums">
        · {{ seenCount }} von {{ paths.length }} gesehen<template v-if="git?.truncated || notShown"> · nicht alle</template>
      </span>
      <span class="flex-1" />
      <span v-if="totals.added || totals.removed" class="shrink-0 font-mono text-[11px] tabular-nums">
        <span v-if="totals.added" class="text-success">+{{ totals.added }}</span>
        <span v-if="totals.added && totals.removed">&nbsp;</span>
        <span v-if="totals.removed" class="text-destructive">−{{ totals.removed }}</span>
      </span>
      <Spinner v-if="loading" class="size-[12px] shrink-0 text-muted-foreground" />
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" aria-label="Lange Zeilen umbrechen" :aria-pressed="wrap" :class="iconButton" @click="toggleWrap">
            <WrapTextIcon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ wrap ? 'Lange Zeilen nicht umbrechen' : 'Lange Zeilen umbrechen' }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" aria-label="Nächste ungesehene Datei" :class="iconButton" :disabled="seenCount === paths.length" @click="nextUnseen">
            <ArrowDownIcon class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Nächste ungesehene Datei</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            :aria-label="allCollapsed ? 'Alle aufklappen' : 'Alle zuklappen'"
            :class="iconButton"
            :disabled="paths.length === 0"
            @click="toggleAll"
          >
            <ChevronsUpDownIcon v-if="allCollapsed" class="size-[16px]" />
            <ChevronsDownUpIcon v-else class="size-[16px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ allCollapsed ? 'Alle aufklappen' : 'Alle zuklappen' }}</TooltipContent>
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

    <!-- Too many files: only the first ones, and what is probably the reason. -->
    <div v-if="notShown > 0" role="status" class="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
      Nur die ersten {{ MAX_FILES }} von {{ allPaths.length.toLocaleString('de-DE') }} geänderten Dateien.
      <template v-if="newFolders">Ganze Ordner sind neu ({{ newFolders }}): Gehören sie in die <code>.gitignore</code>?</template>
    </div>
    <div v-if="!git && !checked" class="flex flex-1 justify-center pt-8">
      <Spinner class="size-[16px] text-muted-foreground" />
    </div>
    <div v-else-if="paths.length === 0" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
      <FileDiffIcon class="size-[24px]" />
      <span class="font-medium text-foreground">{{ git ? 'Keine Änderungen seit dem letzten Commit.' : 'Kein Git-Repository.' }}</span>
    </div>
    <div
      v-else
      ref="scroller"
      class="syntax relative min-h-0 flex-1 overflow-auto select-text"
      :style="{ marginTop: `${PAD - RING}px`, fontFamily, fontSize: `${fontSize}px`, tabSize: DIFF_TAB_SIZE }"
      @scroll.passive="onScroll"
    >
      <!-- A row of characters in the code's font, for how many fit in a card. -->
      <div aria-hidden="true" class="invisible absolute top-0 left-0 size-0 overflow-hidden">
        <span ref="probe" class="inline-block whitespace-pre">{{ '0'.repeat(PROBE_CHARS) }}</span>
      </div>
      <!-- The head of the file in view, over its lines; sticky, so it doesn't lag behind the scrolling. -->
      <div class="sticky top-0 left-0 z-30 h-0" :style="{ width: `${viewWidth}px` }">
        <div
          v-if="stuck"
          class="absolute top-0 overflow-hidden rounded-t-lg shadow-sm ring-1 ring-foreground/10"
          :style="{ left: `${INSET}px`, right: `${INSET}px`, height: `${HEAD}px`, transform: `translateY(${RING + stuck.offset}px)` }"
        >
          <ChangesFileHeader
            :path="stuck.block.path"
            :absolute="absolute(stuck.block.path)"
            :state="decorations.file(stuck.block.path)"
            :added="stuck.block.entry?.parsed.added ?? 0"
            :removed="stuck.block.entry?.parsed.removed ?? 0"
            :collapsed="stuck.block.collapsed"
            :seen="seenState(stuck.block.path)"
            @toggle="setCollapsed(stuck.block.path, !stuck.block.collapsed)"
            @seen="toggleSeen(stuck.block.path)"
            @open="openFile(stuck.block.path)"
          />
        </div>
      </div>
      <div
        class="relative min-w-full"
        :style="{ height: `${layout.height}px`, width: wrap ? undefined : `calc(${layout.widest}ch + ${24 + INSET * 2}px)` }"
      >
        <!-- The cards, with their heads and notes, stay at the left edge while the lines scroll sideways. -->
        <div
          v-for="block in visible.blocks"
          :key="`card\n${block.path}`"
          class="absolute inset-x-0 top-0"
          :style="{ transform: `translateY(${block.top}px)`, height: `${block.end - block.top}px`, clipPath: cardClip(block) }"
        >
          <div class="sticky left-0 h-full" :style="{ width: `${viewWidth}px`, padding: `0 ${INSET}px` }">
            <div class="h-full overflow-hidden rounded-lg ring-1 ring-foreground/10">
              <div :style="{ height: `${HEAD}px` }">
                <ChangesFileHeader
                  :path="block.path"
                  :absolute="absolute(block.path)"
                  :state="decorations.file(block.path)"
                  :added="block.entry?.parsed.added ?? 0"
                  :removed="block.entry?.parsed.removed ?? 0"
                  :collapsed="block.collapsed"
                  :seen="seenState(block.path)"
                  @toggle="setCollapsed(block.path, !block.collapsed)"
                  @seen="toggleSeen(block.path)"
                  @open="openFile(block.path)"
                />
              </div>
              <div v-if="block.note" class="flex items-center px-3 font-sans text-xs text-muted-foreground" :style="{ height: `${rowHeight * 2}px` }">
                <span class="truncate">{{ block.note }}</span>
              </div>
            </div>
          </div>
        </div>
        <DiffLineRow
          v-for="view in visible.lines"
          :key="view.key"
          :line="view.line"
          :html="view.html"
          :top="view.top"
          :height="rowHeight"
          :gutter-width="view.block.gutterWidth"
          :number-width="view.block.entry?.digits ?? 1"
          :with-sign="view.block.withSign"
          :new-file="view.block.entry?.mode === 'new'"
          :inset="INSET"
          :wrap="view.block.offsets !== null"
          :rows="view.rows"
          :clip-top="view.clip"
        />
      </div>
    </div>
  </section>
</template>
