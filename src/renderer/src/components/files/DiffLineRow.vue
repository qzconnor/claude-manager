<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { LineMarks } from '@/composables/useLineComments'
import { MAX_DIFF_COLUMNS, MAX_WRAPPED_COLUMNS, shownText, wordMarks, type DiffLine } from '@/lib/file-diff'
import { splitByRanges } from '@/lib/word-diff'
import type { ReviewComment } from '@/lib/review-comments'
import { cn } from '@/lib/utils'

/**
 * A line of a diff, drawn at `top` (px) in a view that draws only the lines in sight: its number (a
 * removed line its old one) and sign at the left edge, where they stay while the lines scroll sideways,
 * then the code, highlighted (`html`, escaped by highlight.js) or plain. `newFile`: all added, lightly tinted.
 * `inset`: away from the view's left edge (px), the numbers too; the view sets `--clip-right` to cut the
 * lines off as far from its right edge. `wrap`: the line wraps over `rows` rows (`wrappedRows`) and
 * ends `inset` before the right edge, instead of scrolling sideways. `clipTop`: cut off above that (px),
 * where something stands over it. `side`: side by side, in the left half (the old file, its numbers)
 * or the right one (the new file); it wraps. `commentable`: a press on its number picks it for a comment
 * to Claude (`pick`); `marks`: how it shows the comments (picked, on one, the mark of one starting here).
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
  /** Marked for a moment: the line a search hit leads to. */
  marked?: boolean
  /** A section's row: with its buttons to stage or discard it. */
  hunkActions?: boolean
  side?: 'left' | 'right'
  commentable?: boolean
  marks?: LineMarks
}>()
const emit = defineEmits<{ stage: []; discard: []; pick: [event: PointerEvent]; edit: [comment: ReviewComment] }>()

const pickable = computed(() => props.commentable && props.line.kind !== 'hunk')

function onGutterDown(event: PointerEvent) {
  if (!pickable.value || event.button !== 0) return
  // No text selection starts, and the keyboard stays where it is.
  event.preventDefault()
  emit('pick', event)
}

const wrapped = computed(() => props.wrap || !!props.side)
const max = computed(() => (wrapped.value ? MAX_WRAPPED_COLUMNS : MAX_DIFF_COLUMNS))
/** One number: a removed line's in the old file, the others' in the new; on the left side the old file's. */
const number = computed(() => (props.side === 'left' ? props.line.old : (props.line.new ?? props.line.old)))
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
    wrapped.value ? 'pr-[1ch] [line-break:anywhere] [white-space:break-spaces]' : 'whitespace-pre',
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
    wrapped.value
      ?'min-w-0 pr-[1ch] [line-break:anywhere] [white-space:break-spaces]'
      : '[clip-path:inset(0_var(--clip-right,0px)_0_var(--scroll-left,0px))]',
    rowClass.value,
  ),
)
const style = computed(() => {
  const inset = `${props.inset ?? 0}px`
  const [left, right] = props.side === 'left' ? ['0px', '50%'] : props.side === 'right' ? ['50%', '0px'] : [inset, props.wrap ? inset : '0px']
  return {
    left,
    right,
    transform: `translateY(${props.top}px)`,
    height: `${props.height * (props.rows ?? 1)}px`,
    lineHeight: `${props.height}px`,
    clipPath: props.clipTop ? `inset(${props.clipTop}px 0 0 0)` : undefined,
  }
})
</script>

<template>
  <!-- Wrapped, a row counted too few cuts its line instead of covering the next (`clip` keeps the numbers sticky). -->
  <div :class="cn('absolute top-0 flex whitespace-pre', wrapped && 'overflow-clip')" :style="style">
    <span
      :class="
        cn(
          'sticky z-10 flex shrink-0 justify-end gap-[1ch] px-[1ch] tabular-nums select-none',
          GUTTER_CLASS[line.kind],
          pickable && 'group/gutter cursor-pointer',
          marks?.selected
            ? 'shadow-[inset_2px_0_0_var(--primary)]'
            : marks?.commented && 'shadow-[inset_2px_0_0_color-mix(in_oklab,var(--primary)_55%,transparent)]',
        )
      "
      :style="{ left: `${inset ?? 0}px`, width: `${gutterWidth}ch` }"
      @pointerdown="onGutterDown"
    >
      <!-- A comment starts here: its dot in the margin left of the number, which opens it; else on hover the sign that a press comments. -->
      <button
        v-if="marks?.comment"
        type="button"
        class="group/mark absolute top-0 left-0 z-[12] flex w-[calc(1ch+2px)] cursor-pointer items-center justify-center outline-none"
        :style="{ height: `${height}px` }"
        :aria-label="`Kommentar: ${marks.tooltip}`"
        v-tooltip="marks.tooltip"
        @pointerdown.stop
        @click="emit('edit', marks.comment)"
      >
        <span class="size-[6px] rounded-full bg-primary transition-transform group-hover/mark:scale-150 group-focus-visible/mark:scale-150" />
      </button>
      <span
        v-else-if="pickable"
        aria-hidden="true"
        class="absolute top-0 left-[2px] hidden items-center group-hover/gutter:flex"
        :style="{ height: `${height}px` }"
      >
        <span class="flex size-[14px] items-center justify-center rounded-[3px] bg-primary text-primary-foreground">
          <PlusIcon class="size-[10px]" />
        </span>
      </span>
      <span v-if="line.kind === 'hunk'" class="flex-1 text-left">⋯</span>
      <template v-else>
        <span class="text-right" :style="{ width: `${numberWidth}ch` }">{{ number ?? '' }}</span>
        <span v-if="withSign" class="w-[1ch]">{{ SIGN[line.kind] }}</span>
      </template>
    </span>
    <span v-if="marked" aria-hidden="true" class="pointer-events-none absolute inset-0 z-[11] bg-primary/15 ring-1 ring-primary/50 ring-inset" />
    <span
      v-if="marks?.selected || marks?.commented"
      aria-hidden="true"
      :class="cn('pointer-events-none absolute inset-0 z-[11]', marks.selected ? 'bg-primary/15' : 'bg-primary/[0.07]')"
    />
    <span :class="cn(codeClass, parts && 'relative')"><span v-if="parts" aria-hidden="true" :class="marksClass"><template v-for="(part, i) in parts" :key="i"><span v-if="part.changed" :class="cn('rounded-[2px]', MARK_CLASS[line.kind as 'add' | 'del'])">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span><span v-if="html !== null" class="relative" v-html="html" /><span v-else class="relative">{{ text }}</span><span v-if="line.eol" class="relative text-(--diff-number) select-none">{{ EOL[line.eol] }}</span></span>
    <!-- At the right edge of the view however far it scrolls sideways. -->
    <span
      v-if="hunkActions"
      class="sticky right-0 z-10 ml-auto flex shrink-0 items-center gap-0.5 bg-(--diff-hunk) pr-2 pl-3 font-sans text-[11px] not-italic select-none"
    >
      <button
        type="button"
        class="cursor-pointer rounded px-1.5 leading-[18px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        @click="emit('stage')"
      >
        Vormerken
      </button>
      <button
        type="button"
        class="cursor-pointer rounded px-1.5 leading-[18px] text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        @click="emit('discard')"
      >
        Verwerfen
      </button>
    </span>
  </div>
</template>
