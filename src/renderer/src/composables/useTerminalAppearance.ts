import { computed } from 'vue'
import { TERMINAL_FONT_FALLBACKS } from '@shared/defaults'
import { backgroundReplacements, themeSlotTints, type SlotTints } from '@/lib/claude-backgrounds'
import { supportsMaterial } from '@/lib/platform'
import { useSettingsStore } from '@/stores/settings'
import { useThemesStore } from '@/stores/themes'
import type { TerminalPalette } from '@shared/themes/types'

const GENERIC_FAMILIES = new Set(['monospace', 'sans-serif', 'serif', 'system-ui', 'ui-monospace'])

/** Builds a CSS font stack from the user's font (or comma separated list) plus emoji/symbol fallbacks. */
export function buildFontStack(fontFamily: string): string {
  const parts = fontFamily
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  const lower = new Set(parts.map((p) => p.toLowerCase()))
  const all = [...parts, ...TERMINAL_FONT_FALLBACKS.filter((f) => !lower.has(f.toLowerCase()))]
  return all.map((f) => (GENERIC_FAMILIES.has(f.toLowerCase()) ? f : `"${f.replace(/"/g, '')}"`)).join(', ')
}

/** Waits until the given font is loaded (bundled web fonts load lazily). Never throws. */
export async function ensureFontLoaded(fontFamily: string, fontSize: number): Promise<void> {
  const first = fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
  if (!first) return
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`${fontSize}px "${first}"`),
        document.fonts.load(`bold ${fontSize}px "${first}"`),
      ]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ])
  } catch {
    // unknown font — the browser falls back to the next family in the stack
  }
}

/** Terminal palette + container background derived from the current settings and theme. */
export function useTerminalAppearance() {
  const store = useSettingsStore()
  const themes = useThemesStore()

  // A scheme whose file is gone (an own theme, deleted or renamed) leaves the terminal in the app's theme.
  const theme = computed(() => {
    const scheme = store.settings.terminal.colorSchemeId
    return themes.find(scheme && themes.exists(scheme) ? scheme : store.settings.appearance.themeId)
  })
  const palette = computed<TerminalPalette>(() => theme.value.terminal)
  /** Whether the terminal's colors are dark: programs that ask (Claude Code's "Auto" theme) are told. */
  const dark = computed(() => theme.value.mode === 'dark')
  /** See-through colors of the palette slots that Claude's backgrounds (and its crab) are exchanged for. */
  const slotTints = computed<SlotTints>(() => themeSlotTints(palette.value, theme.value.colors.primary))
  /** Which of Claude's backgrounds the output filter exchanges, and for what. */
  const backgrounds = computed(() =>
    backgroundReplacements(store.settings.terminal.panelBackground, store.settings.terminal.diffColors),
  )
  /** Whether the output filter gives Claude Code's crab the accent of the theme. */
  const logo = computed(() => store.settings.terminal.logoColor)

  const containerBackground = computed(() => {
    const opacity = store.settings.terminal.backgroundOpacity
    const materialActive = supportsMaterial && store.settings.appearance.material !== 'none'
    const effective = materialActive ? opacity : 100
    return `color-mix(in oklab, ${palette.value.background} ${effective}%, transparent)`
  })

  /** Laid over the parts of a split tab without the keyboard, so the one with it stands out. */
  const inactiveVeil = computed(() => `color-mix(in oklab, ${palette.value.background} 45%, transparent)`)

  return { palette, dark, slotTints, containerBackground, inactiveVeil, backgrounds, logo }
}
