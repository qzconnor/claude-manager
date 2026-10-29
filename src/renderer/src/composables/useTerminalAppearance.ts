import { computed } from 'vue'
import { TERMINAL_FONT_FALLBACKS } from '@shared/defaults'
import { sgrBackground } from '@/lib/panel-background'
import { useSettingsStore } from '@/stores/settings'
import { findTheme } from '@/themes/themes'
import type { TerminalPalette } from '@/themes/types'

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

  const theme = computed(() => findTheme(store.settings.terminal.colorSchemeId ?? store.settings.appearance.themeId))
  const palette = computed<TerminalPalette>(() => theme.value.terminal)

  /** SGR background that replaces Claude Code's panel gray; null keeps the gray. */
  const panelBackground = computed<string | null>(() => {
    switch (store.settings.terminal.panelBackground) {
      case 'theme':
        return sgrBackground(theme.value.colors.surface)
      case 'terminal':
        return '49'
      default:
        return null
    }
  })

  const containerBackground = computed(() => {
    const opacity = store.settings.terminal.backgroundOpacity
    const materialActive = store.settings.appearance.material !== 'none'
    const effective = materialActive ? opacity : 100
    return `color-mix(in oklab, ${palette.value.background} ${effective}%, transparent)`
  })

  return { palette, containerBackground, panelBackground }
}
