<script setup lang="ts">
import { computed } from 'vue'

/** Where a link (OSC 8) under the mouse (`x`, `y`) leads; the mouse passes through it. */
const props = defineProps<{ url: string; x: number; y: number; ctrl: boolean }>()

/** Largest width and about the height of the hint (px), its distance from the mouse and from the window's edges. */
const WIDTH = 420
const HEIGHT = 64
const GAP = 14
const MARGIN = 8

// Above the mouse like the preview of a pasted image, unless there is no room; held inside the window.
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
      class="glass pointer-events-none fixed z-50 flex max-w-[420px] flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-xs shadow-lg ring-1 ring-foreground/10"
      :style="style"
    >
      <span class="line-clamp-2 font-mono break-all">{{ url }}</span>
      <span class="text-muted-foreground">{{ ctrl ? 'Strg+Klick öffnet den Link' : 'Klicken zum Öffnen' }}</span>
    </div>
  </Teleport>
</template>
