<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { unifiedPatch } from '@shared/line-diff'
import { numberDigits, parsePatch, wordMarks, type DiffLine } from '@/lib/file-diff'
import { hasLanguage, highlightDiff, languageOf, loadLanguage } from '@/lib/syntax'
import { cn } from '@/lib/utils'
import { splitByRanges } from '@/lib/word-diff'

/**
 * Two versions of a file as a diff with three lines around each change, both line numbers, the words
 * that changed marked, in the colours of the file diff (the view sets `--diff-*` and `--syn-*`).
 */
const props = defineProps<{
  before: string | null
  after: string | null
  path: string
}>()

/** Lines drawn before „Alle … Zeilen anzeigen“: a whole new file can be long. */
const MAX_LINES = 2000

const diff = computed(() => parsePatch(unifiedPatch(props.before ?? '', props.after ?? '')))
const expanded = ref(false)
watch(diff, () => (expanded.value = false))
const cut = computed(() => !expanded.value && diff.value.lines.length > MAX_LINES + 100)
const lines = computed(() => (cut.value ? diff.value.lines.slice(0, MAX_LINES) : diff.value.lines))
const digits = computed(() => numberDigits(diff.value.lines))

const language = computed(() => languageOf(props.path))
const languageLoaded = ref(0)
watch(
  language,
  (name) => {
    if (name && !hasLanguage(name)) {
      void loadLanguage(name).then((loaded) => {
        if (loaded) languageLoaded.value++
      })
    }
  },
  { immediate: true },
)
const html = computed(() => {
  void languageLoaded.value
  return language.value ? highlightDiff(lines.value, language.value) : null
})

const ROW: Record<DiffLine['kind'], string> = {
  context: '',
  add: 'bg-(--diff-add)',
  del: 'bg-(--diff-del)',
  hunk: 'bg-(--diff-hunk) text-(--diff-number)',
}
const NUMBER: Record<DiffLine['kind'], string> = {
  context: 'text-(--diff-number)',
  add: 'bg-(--diff-add-gutter) text-(--diff-add-number)',
  del: 'bg-(--diff-del-gutter) text-(--diff-del-number)',
  hunk: '',
}
const MARK: Record<'add' | 'del', string> = {
  add: 'bg-(--diff-add-word)',
  del: 'bg-(--diff-del-word)',
}

/** The words that changed in a line, as a see-through copy under it with them tinted. */
function marks(line: DiffLine) {
  if (line.kind !== 'add' && line.kind !== 'del') return null
  const ranges = wordMarks(line)
  return ranges.length ? splitByRanges(line.text, ranges) : null
}
</script>

<template>
  <div class="selectable syntax min-w-0 font-(family-name:--code-font) text-(length:--code-size) leading-relaxed text-(--code-fg)">
    <div v-if="!diff.lines.length" class="px-4 py-3 font-sans text-xs text-muted-foreground">
      Der Inhalt ist gleich geblieben{{ before === null && after !== null ? ', die Datei ist leer' : '' }}.
    </div>
    <div v-for="(line, index) in lines" :key="index" :class="cn('flex min-w-0', ROW[line.kind])">
      <template v-if="line.kind === 'hunk'">
        <span class="px-3 py-0.5 text-xs select-none">⋯ {{ line.text }}</span>
      </template>
      <template v-else>
        <span :class="cn('shrink-0 px-2 text-right select-none', NUMBER[line.kind])" :style="{ width: `${digits + 2}ch` }">{{
          line.old ?? ''
        }}</span>
        <span :class="cn('shrink-0 px-2 text-right select-none', NUMBER[line.kind])" :style="{ width: `${digits + 2}ch` }">{{
          line.new ?? ''
        }}</span>
        <span class="relative min-w-0 flex-1 pr-3 pl-[1ch] whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span
            v-if="marks(line)"
            aria-hidden="true"
            class="pointer-events-none absolute inset-y-0 right-3 left-[1ch] text-transparent select-none"
            ><span v-for="(part, i) in marks(line)!" :key="i" :class="part.changed && MARK[line.kind as 'add' | 'del']">{{
              part.text
            }}</span></span
          >
          <!-- eslint-disable-next-line vue/no-v-html -- highlight.js escapes the code -->
          <span v-if="html?.[index]" class="relative" v-html="html[index]" />
          <span v-else class="relative">{{ line.text || ' ' }}</span>
        </span>
      </template>
    </div>
    <button
      v-if="cut"
      type="button"
      class="w-full cursor-pointer border-t border-border/50 px-3 py-1.5 text-left font-sans text-xs text-muted-foreground transition-colors outline-none hover:bg-(--code-fg)/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      @click="expanded = true"
    >
      Alle {{ diff.lines.length.toLocaleString('de') }} Zeilen anzeigen
    </button>
  </div>
</template>
