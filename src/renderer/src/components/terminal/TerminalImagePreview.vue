<script setup lang="ts">
import { computed } from 'vue'
import type { PastedImage } from '@shared/types'

/** A pasted image next to the mouse (`x`, `y`) resting on its `[Image #N]`; the mouse passes through it. */
const props = defineProps<{ id: number; x: number; y: number; image: PastedImage }>()

/** Largest size of the card with the caption (px), its distance from the mouse and from the window's edges. */
const WIDTH = 360
const HEIGHT = 280
const GAP = 14
const MARGIN = 8

// Above the mouse, where the prompt usually is, unless there is no room; held inside the window.
const style = computed(() => {
  const left = `${Math.max(MARGIN, Math.min(props.x - GAP, window.innerWidth - WIDTH - MARGIN))}px`
  return props.y - GAP - HEIGHT >= MARGIN
    ? { left, bottom: `${window.innerHeight - props.y + GAP}px` }
    : { left, top: `${props.y + GAP}px` }
})
</script>

<template>
  <Teleport to="body">
    <div
      class="glass pointer-events-none fixed z-50 flex max-w-[360px] min-w-52 flex-col gap-1.5 rounded-xl p-1.5 shadow-lg ring-1 ring-foreground/10"
      :style="style"
    >
      <img :src="image.src" alt="" class="block max-h-[240px] max-w-full self-center rounded-lg" />
      <div class="flex items-baseline justify-between gap-3 px-1 pb-0.5 text-xs">
        <span class="font-medium">
          Bild #{{ id }}
          <span v-if="!image.sent" class="font-normal text-muted-foreground">· nicht gesendet</span>
        </span>
        <span class="text-muted-foreground">Klicken zum Vergrößern</span>
      </div>
    </div>
  </Teleport>
</template>
