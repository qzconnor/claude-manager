<script setup lang="ts">
import { RotateCcwIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { colorAllowsAlpha } from '@shared/themes/file'
import HighlightText from '@/components/common/HighlightText.vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ColorInfo } from '@/themes/color-info'
import ColorPickerPanel from './ColorPickerPanel.vue'

/** One color of the theme editor: what it is for, and its swatch that opens the picker (hex there too). */
const props = defineProps<{
  info: ColorInfo
  /** The value when the editor opened; null for a new theme (nothing to go back to). */
  original: string | null
  terms: string[]
  swatches: readonly string[]
  /** Too little contrast to the color the text is read on. */
  contrast: { ratio: number; label: string } | null
}>()
const model = defineModel<string>({ required: true })

const alpha = computed(() => colorAllowsAlpha(props.info.key))
const changed = computed(() => props.original !== null && props.original !== model.value)

function reset() {
  if (props.original !== null) model.value = props.original
}

const CHECKERS = 'repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 0 0 / 8px 8px'
</script>

<template>
  <div class="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/40" :data-color="info.key">
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-sm font-medium"><HighlightText :text="info.label" :terms="terms" /></span>
        <code class="font-mono text-[11px] text-muted-foreground/80"><HighlightText :text="info.key" :terms="terms" /></code>
      </div>
      <p class="text-xs text-muted-foreground"><HighlightText :text="info.description" :terms="terms" /></p>
      <p v-if="contrast" class="mt-1 flex items-center gap-1 text-xs text-warning">
        <TriangleAlertIcon class="size-3.5 shrink-0" />
        Wenig Kontrast zum {{ contrast.label }} ({{ contrast.ratio.toFixed(1).replace('.', ',') }} : 1), schwer lesbar.
      </p>
    </div>

    <div class="mt-0.5 flex shrink-0 items-center gap-1.5">
      <Button
        v-if="changed"
        variant="ghost"
        size="icon-xs"
        v-tooltip="`Zurück auf ${original}`"
        @click="reset"
      >
        <RotateCcwIcon />
        <span class="sr-only">Zurücksetzen</span>
      </Button>
      <Popover>
        <PopoverTrigger as-child>
          <button
            type="button"
            class="size-8 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-foreground/15 transition outline-none hover:ring-foreground/40 focus-visible:ring-3 focus-visible:ring-ring/50"
            :style="{ background: CHECKERS }"
            :aria-label="`${info.label}: ${model}, Farbe wählen`"
          >
            <span class="block size-full" :style="{ background: model }" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" class="w-auto p-3">
          <ColorPickerPanel v-model="model" :alpha="alpha" :swatches="swatches" />
        </PopoverContent>
      </Popover>
    </div>
  </div>
</template>
