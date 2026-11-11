<script setup lang="ts">
import { computed } from 'vue'
import { MAX_DIFF_COLUMNS, MAX_WRAPPED_COLUMNS, shownText, wordMarks, type DiffLine } from '@/lib/file-diff'
import { splitByRanges } from '@/lib/word-diff'
import { cn } from '@/lib/utils'

/**
 * A line of a diff, drawn at `top` (px) in a view that draws only the lines in sight: its number (a
 * removed line its old one) and sign at the left edge, where they stay while the lines scroll sideways,
 * then the code, highlighted (`html`, escaped by highlight.js) or plain. `newFile`: all added, lightly tinted.
 * `inset`: away from the view's left edge (px), the numbers too; the view sets `--clip-right` to cut the
 * lines off as far from its right edge. `wrap`: the line wraps over `rows` rows (`wrappedRows`) and
 * ends `inset` before the right edge, instead of scrolling sideways. `clipTop`: cut off above that (px),
 * where something stands over it.
 */
const props = defineProps<{
  line: DiffLine
  html: string | null
  top: number
  /** One row (px). */
  height: number
  /** The numbers, the sign and the gaps around them (ch). */
  gutterWidth: number
  numberWidth: number
  withSign: boolean
  newFile?: boolean
  inset?: number
  wrap?: boolean
  rows?: number
  clipTop?: number
}>()

const max = computed(() => (props.wrap ? MAX_WRAPPED_COLUMNS : MAX_DIFF_COLUMNS))
const text = computed(() => shownText(props.line.text, max.value))
const html = computed(() => (props.line.text.length > max.value ? null : props.html))

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
/**
 * The words that changed against the line in its place on the other side, as a copy of the text behind
 * it: see-through, with the changed words tinted. As a copy in the same font, wrapped the same, the marks
 * lie under their words also when the code is highlighted.
 */
const parts = computed(() => {
  if (props.line.kind !== 'add' && props.line.kind !== 'del') return null
  const ranges = wordMarks(props.line)
  return ranges.length ? splitByRanges(text.value, ranges) : null
})
const MARK_CLASS = { add: 'bg-(--diff-add-word)', del: 'bg-(--diff-del-word)' } as const
const marksClass = computed(() =>
  cn(
    'pointer-events-none absolute inset-y-0 left-0 right-0 pl-[1ch] text-transparent select-none',
    props.wrap ? 'pr-[1ch] [line-break:anywhere] [white-space:break-spaces]' : 'whitespace-pre',
  ),
)

/** A line that changed only its ending shows it: carriage return and line feed as their symbols. */
const EOL = { crlf: '␍␊', lf: '␊' } as const

const rowClass = computed(() => (props.newFile && props.line.kind === 'add' ? 'bg-(--diff-add-new)' : ROW_CLASS[props.line.kind]))
/**
 * Scrolling sideways, cut off where it passes below the numbers (the view sets `--scroll-left`);
 * wrapped, broken anywhere, so its rows are as many as `wrappedRows` counts.
 */
const codeClass = computed(() =>
  cn(
    'flex-1 pl-[1ch]',
    props.wrap
      ? 'min-w-0 pr-[1ch] [line-break:anywhere] [white-space:break-spaces]'
      : '[clip-path:inset(0_var(--clip-right,0px)_0_var(--scroll-left,0px))]',
    rowClass.value,
  ),
)
const style = computed(() => {
  const inset = `${props.inset ?? 0}px`
  return {
    left: inset,
    right: props.wrap ? inset : '0px',
    transform: `translateY(${props.top}px)`,
    height: `${props.height * (props.rows ?? 1)}px`,
    lineHeight: `${props.height}px`,
    clipPath: props.clipTop ? `inset(${props.clipTop}px 0 0 0)` : undefined,
  }
})
</script>

<template>
  <!-- Wrapped, a row counted too few cuts its line instead of covering the next (`clip` keeps the numbers sticky). -->
  <div :class="cn('absolute top-0 flex whitespace-pre', wrap && 'overflow-clip')" :style="style">
    <span
      :class="cn('sticky z-10 flex shrink-0 justify-end gap-[1ch] px-[1ch] tabular-nums select-none', GUTTER_CLASS[line.kind])"
      :style="{ left: `${inset ?? 0}px`, width: `${gutterWidth}ch` }"
    >
      <span v-if="line.kind === 'hunk'" class="flex-1 text-left">⋯</span>
      <template v-else>
        <span class="text-right" :style="{ width: `${numberWidth}ch` }">{{ line.new ?? line.old ?? '' }}</span>
        <span v-if="withSign" class="w-[1ch]">{{ SIGN[line.kind] }}</span>
      </template>
    </span>
    <span :class="cn(codeClass, parts && 'relative')"><span v-if="parts" aria-hidden="true" :class="marksClass"><template v-for="(part, i) in parts" :key="i"><span v-if="part.changed" :class="cn('rounded-[2px]', MARK_CLASS[line.kind as 'add' | 'del'])">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span><span v-if="html !== null" class="relative" v-html="html" /><span v-else class="relative">{{ text }}</span><span v-if="line.eol" class="relative text-(--diff-number) select-none">{{ EOL[line.eol] }}</span></span>
  </div>
</template>
