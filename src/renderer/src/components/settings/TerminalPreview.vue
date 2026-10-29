<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { Terminal } from '@xterm/xterm'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { terminalOptions } from '@/composables/useTerminal'
import { ensureFontLoaded, useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { useSettingsStore } from '@/stores/settings'

/** Static xterm instance that shows the current terminal settings with sample output. */
const container = ref<HTMLElement | null>(null)
const settings = useSettingsStore()
const { palette, containerBackground } = useTerminalAppearance()

const ESC = '\x1b['
const SAMPLE = [
  `${ESC}1;38;2;217;119;87m✻${ESC}0m ${ESC}1mWelcome to Claude Code!${ESC}0m`,
  '',
  `${ESC}2m  /help for help, /status for your current setup${ESC}0m`,
  '',
  `${ESC}36m>${ESC}0m Refactor the session list 🚀 and add tests ✅`,
  '',
  `${ESC}32m●${ESC}0m ${ESC}1mRead${ESC}0m(src/views/SessionsView.vue)`,
  `  ⎿  Read ${ESC}1m142${ESC}0m lines`,
  `${ESC}33m●${ESC}0m ${ESC}1mUpdate${ESC}0m(src/lib/format.ts)`,
  `  ${ESC}42;30m + ${ESC}0m${ESC}32m export function formatTokens(value: number) {${ESC}0m`,
  `  ${ESC}41;30m - ${ESC}0m${ESC}31m const old = 'legacy' // 👋${ESC}0m`,
  '',
  `${ESC}30m■${ESC}31m■${ESC}32m■${ESC}33m■${ESC}34m■${ESC}35m■${ESC}36m■${ESC}37m■ ${ESC}90m■${ESC}91m■${ESC}92m■${ESC}93m■${ESC}94m■${ESC}95m■${ESC}96m■${ESC}97m■${ESC}0m  äöü ß € → ✓ ⚡ 👨‍👩‍👧 🇩🇪`,
].join('\r\n')

let term: Terminal | null = null
let fit: FitAddon | null = null
let observer: ResizeObserver | null = null

function applyUnicode() {
  if (term) term.unicode.activeVersion = settings.settings.terminal.unicode === 'graphemes' ? '15-graphemes' : '11'
}

onMounted(async () => {
  const el = container.value
  if (!el) return
  const s = settings.settings.terminal
  await ensureFontLoaded(s.fontFamily, s.fontSize)
  if (!container.value) return
  term = new Terminal({
    ...terminalOptions(s, palette.value),
    allowProposedApi: true,
    allowTransparency: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    disableStdin: true,
    cursorBlink: false,
    scrollback: 0,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.loadAddon(new UnicodeGraphemesAddon())
  applyUnicode()
  term.open(el)
  term.write(SAMPLE)
  fit.fit()
  observer = new ResizeObserver(() => fit?.fit())
  observer.observe(el)
})

watch(
  () => [settings.settings.terminal, palette.value] as const,
  async ([s, p]) => {
    if (!term) return
    await ensureFontLoaded(s.fontFamily, s.fontSize)
    if (!term) return
    Object.assign(term.options, { ...terminalOptions(s, p), cursorBlink: false, scrollback: 0 })
    applyUnicode()
    fit?.fit()
  },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  term?.dispose()
  term = null
})
</script>

<template>
  <div
    class="overflow-hidden rounded-xl ring-1 ring-foreground/10"
    :style="{ background: containerBackground, padding: `${settings.settings.terminal.padding}px` }"
  >
    <div ref="container" class="h-56 w-full" />
  </div>
</template>
