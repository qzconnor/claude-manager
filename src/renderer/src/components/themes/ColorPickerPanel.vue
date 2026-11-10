<script setup lang="ts">
import { PipetteIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { formatColor, hsvToRgb, parseColor, rgbToHsv, toHex, type Hsv } from '@shared/themes/colors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Picks a color: saturation and brightness in the field, hue (and with `alpha` the opacity) on the
 * bars, as text, with the eyedropper from the screen, or one of `swatches` (the other colors of the
 * theme). Changes go out while dragging, so the preview follows.
 */
const props = defineProps<{ alpha?: boolean; swatches?: readonly string[] }>()
const model = defineModel<string>({ required: true })

const hsv = ref<Hsv>({ h: 0, s: 0, v: 0 })
const opacity = ref(1)
const text = ref('')
/** While the value is typed, the text stays as typed (`#fff` on the way to `#fff000` isn't turned into `#ffffff`). */
const typing = ref(false)
/** The last value sent: coming back as the model, it mustn't move the thumbs (gray has no hue). */
let sent: string | null = null

function take(value: string) {
  if (!typing.value) text.value = value
  if (value === sent) return
  const color = parseColor(value)
  if (!color) return
  const next = rgbToHsv(color)
  // Gray, black and white have no hue (black no saturation either): the thumbs stay where they were.
  if (next.s === 0 || next.v === 0) next.h = hsv.value.h
  if (next.v === 0) next.s = hsv.value.s
  hsv.value = next
  opacity.value = props.alpha ? color.a : 1
}
watch(model, take, { immediate: true })

function send() {
  const value = formatColor(hsvToRgb(hsv.value, props.alpha ? Math.round(opacity.value * 100) / 100 : 1))
  sent = value
  text.value = value
  model.value = value
}

const opaque = computed(() => toHex(hsvToRgb(hsv.value)))
const hueColor = computed(() => toHex(hsvToRgb({ h: hsv.value.h, s: 1, v: 1 })))

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Follows the pointer over `event`'s element until it is let go; `onMove` gets x and y from 0 to 1. */
function drag(event: PointerEvent, onMove: (x: number, y: number) => void) {
  if (event.button !== 0) return
  const el = event.currentTarget as HTMLElement
  el.setPointerCapture(event.pointerId)
  el.focus()
  const rect = el.getBoundingClientRect()
  const move = (e: PointerEvent) => onMove(clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height))
  const stop = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', stop)
    el.removeEventListener('pointercancel', stop)
  }
  move(event)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', stop)
  el.addEventListener('pointercancel', stop)
}

function dragField(event: PointerEvent) {
  drag(event, (x, y) => {
    hsv.value = { ...hsv.value, s: x, v: 1 - y }
    send()
  })
}
function dragHue(event: PointerEvent) {
  drag(event, (x) => {
    hsv.value = { ...hsv.value, h: x * 360 }
    send()
  })
}
function dragAlpha(event: PointerEvent) {
  drag(event, (x) => {
    opacity.value = x
    send()
  })
}

/** Arrow keys move by 1 %, with Shift by 10 %. */
function step(event: KeyboardEvent): [number, number] | null {
  const by = event.shiftKey ? 0.1 : 0.01
  const moves: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, by], ArrowDown: [0, -by] }
  const move = moves[event.key]
  if (!move) return null
  event.preventDefault()
  return move
}
function keyField(event: KeyboardEvent) {
  const move = step(event)
  if (!move) return
  hsv.value = { ...hsv.value, s: clamp01(hsv.value.s + move[0]), v: clamp01(hsv.value.v + move[1]) }
  send()
}
function keyHue(event: KeyboardEvent) {
  const move = step(event)
  if (!move) return
  hsv.value = { ...hsv.value, h: (hsv.value.h + (move[0] + move[1]) * 360 + 360) % 360 }
  send()
}
function keyAlpha(event: KeyboardEvent) {
  const move = step(event)
  if (!move) return
  opacity.value = clamp01(opacity.value + move[0] + move[1])
  send()
}

// The text, not the input event: the field passes its value on a moment later.
watch(text, (value) => {
  const color = parseColor(value)
  if (!typing.value || !color || (!props.alpha && color.a < 1)) return
  sent = null
  model.value = formatColor(color)
})
function onTextDone() {
  typing.value = false
  text.value = model.value
}

function pickSwatch(color: string) {
  const parsed = parseColor(color)
  if (!parsed) return
  sent = null
  model.value = formatColor({ ...parsed, a: props.alpha ? opacity.value : 1 })
}

/** Chromium's eyedropper: picks a color anywhere on the screen. */
interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>
}
const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => EyeDropperApi }).EyeDropper
async function pickFromScreen() {
  if (!EyeDropperCtor) return
  try {
    const { sRGBHex } = await new EyeDropperCtor().open()
    pickSwatch(sRGBHex)
  } catch {
    // Cancelled with Escape.
  }
}

const uniqueSwatches = computed(() => {
  const seen = new Set<string>()
  return (props.swatches ?? []).filter((color) => {
    const parsed = parseColor(color)
    if (!parsed || parsed.a < 1) return false
    const hex = toHex(parsed)
    if (seen.has(hex)) return false
    seen.add(hex)
    return true
  })
})

/** The checkerboard behind see-through colors. */
const CHECKERS = 'repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 0 0 / 8px 8px'
</script>

<template>
  <div class="flex w-60 flex-col gap-3">
    <div
      role="slider"
      tabindex="0"
      aria-label="Sättigung und Helligkeit"
      :aria-valuetext="`Sättigung ${Math.round(hsv.s * 100)} %, Helligkeit ${Math.round(hsv.v * 100)} %`"
      class="relative h-36 cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      :style="{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }"
      @pointerdown="dragField"
      @keydown="keyField"
    >
      <span
        class="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
        :style="{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }"
      />
    </div>

    <div class="flex items-center gap-2">
      <div class="flex flex-1 flex-col gap-2.5">
        <div
          role="slider"
          tabindex="0"
          aria-label="Farbton"
          :aria-valuenow="Math.round(hsv.h)"
          aria-valuemin="0"
          aria-valuemax="360"
          class="relative h-3 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          style="background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
          @pointerdown="dragHue"
          @keydown="keyHue"
        >
          <span
            class="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
            :style="{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }"
          />
        </div>
        <div
          v-if="alpha"
          role="slider"
          tabindex="0"
          aria-label="Deckkraft"
          :aria-valuenow="Math.round(opacity * 100)"
          aria-valuemin="0"
          aria-valuemax="100"
          class="relative h-3 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          :style="{ background: `linear-gradient(to right, transparent, ${opaque}), ${CHECKERS}` }"
          @pointerdown="dragAlpha"
          @keydown="keyAlpha"
        >
          <span
            class="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
            :style="{ left: `${opacity * 100}%`, background: model }"
          />
        </div>
      </div>
      <span class="size-8 shrink-0 overflow-hidden rounded-md ring-1 ring-foreground/15" :style="{ background: CHECKERS }">
        <span class="block size-full" :style="{ background: model }" />
      </span>
    </div>

    <div class="flex items-center gap-1.5">
      <Input
        v-model="text"
        aria-label="Farbwert"
        spellcheck="false"
        class="h-7 flex-1 font-mono text-xs"
        :aria-invalid="!parseColor(text) || (!alpha && parseColor(text)!.a < 1)"
        @focus="typing = true"
        @blur="onTextDone"
        @keydown.enter.prevent="text = model"
      />
      <Button v-if="EyeDropperCtor" variant="ghost" size="icon-sm" v-tooltip="'Farbe vom Bildschirm aufnehmen'" @click="pickFromScreen">
        <PipetteIcon />
        <span class="sr-only">Farbe vom Bildschirm aufnehmen</span>
      </Button>
    </div>

    <div v-if="uniqueSwatches.length" class="flex flex-col gap-1.5">
      <span class="text-xs text-muted-foreground">Farben dieses Themes</span>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="color in uniqueSwatches"
          :key="color"
          type="button"
          class="size-5 rounded-[5px] ring-1 ring-foreground/15 outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring"
          :style="{ background: color }"
          :aria-label="color"
          v-tooltip="color"
          @click="pickSwatch(color)"
        />
      </div>
    </div>
  </div>
</template>
