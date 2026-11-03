<script setup lang="ts">
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { Terminal } from '@xterm/xterm'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { placeColumns, renderService, terminalOptions } from '@/composables/useTerminal'
import { ensureFontLoaded, useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { createBackgroundFilter } from '@/lib/claude-backgrounds'
import { setSlotTints } from '@/lib/translucent-slots'
import { useSettingsStore } from '@/stores/settings'

/** Static xterm instance that shows the current terminal settings with sample output. */
const container = ref<HTMLElement | null>(null)
const settings = useSettingsStore()
const { palette, slotTints, containerBackground, backgrounds } = useTerminalAppearance()

const ESC = '\x1b['
const SAMPLE = [
  `${ESC}1;38;2;217;119;87m✻${ESC}0m ${ESC}1mWelcome to Claude Code!${ESC}0m`,
  '',
  `${ESC}2m  /help for help, /status for your current setup${ESC}0m`,
  '',
  // Claude Code's own backgrounds, exchanged like in a real terminal: the bar behind the user's
  // message and the diff. `ESC[K` fills the rest of the row with the background.
  `${ESC}48;2;55;55;55m${ESC}90m❯${ESC}39m Refactor the session list 🚀 and add tests ✅${ESC}K${ESC}0m`,
  '',
  `${ESC}32m●${ESC}0m ${ESC}1mRead${ESC}0m(src/views/SessionsView.vue)`,
  `  ⎿  Read ${ESC}1m142${ESC}0m lines`,
  `${ESC}33m●${ESC}0m ${ESC}1mUpdate${ESC}0m(src/lib/format.ts)`,
  `  ${ESC}48;2;61;1;0m${ESC}31m - ${ESC}39mconst old = ${ESC}48;2;92;2;0m'legacy'${ESC}48;2;61;1;0m // 👋${ESC}K${ESC}0m`,
  `  ${ESC}48;2;2;40;0m${ESC}32m + ${ESC}39mexport function ${ESC}48;2;4;71;0mformatTokens${ESC}48;2;2;40;0m(value: number) {${ESC}K${ESC}0m`,
  '',
  `${ESC}30m■${ESC}31m■${ESC}32m■${ESC}33m■${ESC}34m■${ESC}35m■${ESC}36m■${ESC}37m■ ${ESC}90m■${ESC}91m■${ESC}92m■${ESC}93m■${ESC}94m■${ESC}95m■${ESC}96m■${ESC}97m■${ESC}0m  äöü ß € → ✓ ⚡ 👨‍👩‍👧 🇩🇪`,
].join('\r\n')

let term: Terminal | null = null
let observer: ResizeObserver | null = null
let fitFrame = 0

/** Writes the sample anew; needed when the exchanged backgrounds change. */
function writeSample() {
  if (!term) return
  term.reset()
  term.write(createBackgroundFilter(() => backgrounds.value)(SAMPLE))
}

function applyUnicode() {
  if (term) term.unicode.activeVersion = settings.settings.terminal.unicode === 'graphemes' ? '15-graphemes' : '11'
}

/** Places the columns like the real terminal, so the left and right padding look the same here. */
function fit() {
  cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => {
    const el = container.value
    if (!term || !el || el.clientWidth === 0) return
    const cell = renderService(term).dimensions.css.cell
    if (!cell.width || !cell.height) return
    const rect = el.getBoundingClientRect()
    const { left, right } = settings.settings.terminal.padding
    const { cols, offset } = placeColumns(rect.width, cell.width, left, right)
    el.style.paddingLeft = `${offset}px`
    const rows = Math.max(1, Math.floor(rect.height / cell.height))
    if (cols === term.cols && rows === term.rows) return
    renderService(term).clear()
    term.resize(cols, rows)
  })
}

onMounted(async () => {
  const el = container.value
  if (!el) return
  const s = settings.settings.terminal
  await ensureFontLoaded(s.fontFamily, s.fontSize)
  if (!container.value) return
  setSlotTints(slotTints.value)
  term = new Terminal({
    ...terminalOptions(s, palette.value, slotTints.value),
    allowProposedApi: true,
    allowTransparency: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    disableStdin: true,
    cursorBlink: false,
    scrollback: 0,
  })
  term.loadAddon(new Unicode11Addon())
  term.loadAddon(new UnicodeGraphemesAddon())
  applyUnicode()
  term.open(el)
  writeSample()
  fit()
  observer = new ResizeObserver(() => fit())
  observer.observe(el)
})

watch(
  () => [settings.settings.terminal, palette.value, slotTints.value] as const,
  async ([s, p, tints]) => {
    if (!term) return
    await ensureFontLoaded(s.fontFamily, s.fontSize)
    if (!term) return
    setSlotTints(tints)
    Object.assign(term.options, { ...terminalOptions(s, p, tints), cursorBlink: false, scrollback: 0 })
    applyUnicode()
    fit()
  },
)

watch(backgrounds, writeSample)

onBeforeUnmount(() => {
  cancelAnimationFrame(fitFrame)
  observer?.disconnect()
  term?.dispose()
  term = null
})
</script>

<template>
  <div
    class="overflow-hidden rounded-xl ring-1 ring-foreground/10"
    :style="{
      background: containerBackground,
      paddingTop: `${settings.settings.terminal.padding.top}px`,
      paddingBottom: `${settings.settings.terminal.padding.bottom}px`,
    }"
  >
    <div ref="container" class="h-56 w-full" />
  </div>
</template>
