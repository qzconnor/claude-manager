<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { wordMarks, type DiffLine } from '@/lib/file-diff'
import { snippetDiff } from '@/lib/snippet-diff'
import { hasLanguage, highlightDiff, loadLanguage } from '@/lib/syntax'
import { cn } from '@/lib/utils'
import { splitByRanges } from '@/lib/word-diff'

/**
 * What an Edit changed: `before` and `after` line by line, in the colours of the file diff (the view
 * sets `--diff-*` and `--syn-*`), highlighted in `language`, with the words that changed marked.
 */
const props = defineProps<{ before: string; after: string; language: string | null }>()

/** Lines shown before „Alle … Zeilen anzeigen“. */
const MAX_LINES = 40

const diff = computed(() => snippetDiff(props.before, props.after))
const expanded = ref(false)
const cut = computed(() => !expanded.value && diff.value.lines.length > MAX_LINES + 5)
const lines = computed(() => (cut.value ? diff.value.lines.slice(0, MAX_LINES) : diff.value.lines))

const languageLoaded = ref(0)
watch(
  () => props.language,
  (language) => {
    if (language && !hasLanguage(language)) {
      void loadLanguage(language).then((loaded) => {
        if (loaded) languageLoaded.value++
      })
    }
  },
  { immediate: true },
)
const html = computed(() => {
  void languageLoaded.value
  return props.language ? highlightDiff(diff.value.lines, props.language) : null
})

const ROW: Record<DiffLine['kind'], string> = { context: '', add: 'bg-(--diff-add)', del: 'bg-(--diff-del)', hunk: '' }
const SIGN: Record<DiffLine['kind'], string> = { context: ' ', add: '+', del: '−', hunk: ' ' }
const SIGN_CLASS: Record<DiffLine['kind'], string> = {
  context: 'text-(--diff-number)',
  add: 'bg-(--diff-add-gutter) text-(--diff-add-number)',
  del: 'bg-(--diff-del-gutter) text-(--diff-del-number)',
  hunk: '',
}
const MARK: Record<'add' | 'del', string> = { add: 'bg-(--diff-add-word)', del: 'bg-(--diff-del-word)' }

/** The words that changed in a line, as a see-through copy under it with them tinted. */
function marks(line: DiffLine) {
  if (line.kind !== 'add' && line.kind !== 'del') return null
  const ranges = wordMarks(line)
  return ranges.length ? splitByRanges(line.text, ranges) : null
}
</script>

<template>
  <div
    class="selectable flex min-w-0 flex-col overflow-hidden rounded-md border border-border/70 bg-(--code-bg) font-(family-name:--code-font) text-(length:--code-size) leading-relaxed text-(--code-fg)"
  >
    <div class="syntax max-h-[32rem] overflow-auto py-1">
      <div v-for="(line, index) in lines" :key="index" :class="cn('flex min-w-0', ROW[line.kind])">
        <span :class="cn('w-[3ch] shrink-0 text-center select-none', SIGN_CLASS[line.kind])">{{ SIGN[line.kind] }}</span>
        <span class="relative min-w-0 flex-1 pr-3 pl-[1ch] whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span
            v-if="marks(line)"
            aria-hidden="true"
            class="pointer-events-none absolute inset-y-0 right-3 left-[1ch] text-transparent select-none"
            ><span
              v-for="(part, i) in marks(line)!"
              :key="i"
              :class="part.changed && MARK[line.kind as 'add' | 'del']"
              >{{ part.text }}</span
            ></span
          >
          <!-- eslint-disable-next-line vue/no-v-html -- highlight.js escapes the code -->
          <!-- The shown lines are the first ones of the diff: the index is the same. -->
          <span v-if="html?.[index]" class="relative" v-html="html[index]" />
          <span v-else class="relative">{{ line.text || ' ' }}</span>
        </span>
      </div>
    </div>
    <button
      v-if="cut || expanded"
      type="button"
      class="cursor-pointer border-t border-border/50 px-3 py-1 text-left font-sans text-xs text-muted-foreground transition-colors outline-none hover:bg-(--code-fg)/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      @click="expanded = !expanded"
    >
      {{ cut ? `Alle ${diff.lines.length} Zeilen anzeigen` : 'Weniger anzeigen' }}
    </button>
  </div>
</template>
