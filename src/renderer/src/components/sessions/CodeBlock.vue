<script setup lang="ts">
import { CheckIcon, CopyIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { hasLanguage, highlightCode, loadLanguage } from '@/lib/syntax'
import { cn } from '@/lib/utils'

/**
 * Code or what a command printed, in the terminal's colours and font (the view sets `--code-*` and
 * `--syn-*`), highlighted once its `language` is loaded. `maxLines`: longer code shows that many lines
 * first and the rest after a click. `prompt` stands before the first line and isn't copied (`!` of a
 * command typed after it). `bare`: without a frame of its own, inside another one.
 */
const props = withDefaults(
  defineProps<{
    code: string
    language?: string | null
    maxLines?: number
    prompt?: string
    tone?: 'default' | 'error'
    bare?: boolean
    copyable?: boolean
  }>(),
  { language: null, maxLines: 0, prompt: '', tone: 'default', bare: false, copyable: true },
)

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

const lineCount = computed(() => props.code.split('\n').length)
const expanded = ref(false)
// Cut only when more than a few lines would stay hidden.
const cut = computed(() => props.maxLines > 0 && !expanded.value && lineCount.value > props.maxLines + 3)
const shown = computed(() => (cut.value ? props.code.split('\n', props.maxLines).join('\n') : props.code))
const html = computed(() => {
  void languageLoaded.value
  return props.language ? highlightCode(shown.value, props.language) : null
})

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
async function copy() {
  await navigator.clipboard.writeText(props.code)
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div
    :class="
      cn(
        'group/code relative flex min-w-0 flex-col text-(--code-fg)',
        !bare && 'overflow-hidden rounded-md border border-border/70 bg-(--code-bg)',
        tone === 'error' && !bare && 'border-destructive/40',
      )
    "
  >
    <!-- eslint-disable-next-line vue/no-v-html -- highlight.js escapes the code -->
    <pre
      :class="
        cn(
          'syntax selectable m-0 max-h-[32rem] overflow-auto px-3 py-2 font-(family-name:--code-font) text-(length:--code-size) leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]',
          tone === 'error' && 'text-(--syn-red)',
          copyable && 'pr-9',
        )
      "
    ><span v-if="prompt" class="text-(--syn-comment) select-none">{{ prompt }} </span><code v-if="html" v-html="html" /><code v-else>{{ shown }}</code></pre>
    <button
      v-if="cut || expanded"
      type="button"
      class="cursor-pointer border-t border-border/50 px-3 py-1 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-(--code-fg)/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      @click="expanded = !expanded"
    >
      {{ cut ? `Alle ${lineCount} Zeilen anzeigen` : 'Weniger anzeigen' }}
    </button>
    <button
      v-if="copyable"
      type="button"
      :aria-label="copied ? 'Kopiert' : 'Kopieren'"
      v-tooltip="copied ? 'Kopiert' : 'Kopieren'"
      class="absolute top-[4px] right-[4px] flex size-[24px] cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity outline-none group-hover/code:opacity-100 hover:bg-(--code-fg)/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-[14px]"
      @click="copy"
    >
      <CheckIcon v-if="copied" />
      <CopyIcon v-else />
    </button>
  </div>
</template>
