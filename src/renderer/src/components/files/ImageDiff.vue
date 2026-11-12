<script setup lang="ts">
import { computed, reactive } from 'vue'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * An image of the diff as it was at the last commit and as it is now, side by side (one above the
 * other where there is little room), on a checkerboard so transparency shows; with its size in
 * pixels and bytes. Only one side when the other isn't there: new, deleted or unchanged.
 */
const props = defineProps<{
  before: string | null
  after: string | null
  /** Fits a card of the review: a fixed height instead of the whole view. */
  compact?: boolean
}>()

interface Side {
  key: 'before' | 'after'
  label: string | null
  url: string
}

const sides = computed<Side[]>(() => {
  const { before, after } = props
  if (before && after && before !== after)
    return [
      { key: 'before', label: 'Vorher', url: before },
      { key: 'after', label: 'Jetzt', url: after },
    ]
  if (after) return [{ key: 'after', label: null, url: after }]
  if (before) return [{ key: 'before', label: 'Gelöscht', url: before }]
  return []
})

/** Pixels of each side, once it loaded. */
const sizes = reactive<Record<string, string>>({})
function measured(side: Side, event: Event) {
  const img = event.target as HTMLImageElement
  sizes[side.key] = `${img.naturalWidth} × ${img.naturalHeight} px`
}
/** The bytes a data URL holds: three for every four characters of base64, less its padding. */
function bytesOf(url: string): number {
  const data = url.slice(url.indexOf(',') + 1)
  return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}
</script>

<template>
  <div :class="cn('@container flex min-h-0', compact ? 'h-full' : 'flex-1')">
    <div class="flex size-full min-h-0 flex-col gap-3 p-3 @[480px]:flex-row">
    <figure v-for="side in sides" :key="side.key" class="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
      <figcaption class="flex shrink-0 items-baseline gap-2 font-sans text-xs text-muted-foreground">
        <span v-if="side.label" :class="cn('font-medium', side.key === 'before' ? 'text-destructive' : 'text-success')">{{ side.label }}</span>
        <span class="tabular-nums">{{ [sizes[side.key], formatBytes(bytesOf(side.url))].filter(Boolean).join(' · ') }}</span>
      </figcaption>
      <!-- A checkerboard behind it, so what is see-through shows as such. -->
      <div
        class="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md ring-1 ring-foreground/10 [background:repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)_0_0/16px_16px]"
      >
        <img :src="side.url" alt="" class="max-h-full max-w-full object-contain [image-rendering:auto]" draggable="false" @load="measured(side, $event)" />
      </div>
    </figure>
    </div>
  </div>
</template>
