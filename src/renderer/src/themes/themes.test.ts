import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import { parseHex } from '@/lib/claude-backgrounds'
import { DEFAULT_THEME_ID, findTheme, THEMES } from './themes'
import type { TerminalPalette, ThemeColors } from './types'

const COLOR_KEYS: (keyof ThemeColors)[] = [
  'background',
  'foreground',
  'mutedForeground',
  'surface',
  'popover',
  'primary',
  'primaryForeground',
  'destructive',
  'success',
  'warning',
]

const PALETTE_KEYS: (keyof TerminalPalette)[] = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

/** `rgba(r, g, b, a)` with channels 0–255 and alpha 0–1. */
const RGBA_RE = /^rgba\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3}),\s*(0|1|0?\.\d+)\s*\)$/

/** Relative luminance (WCAG) of a hex color. */
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex)!.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('THEMES', () => {
  it('has unique ids and names', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length)
    for (const theme of THEMES) {
      expect(theme.id).toMatch(/^[a-z0-9-]+$/)
      expect(theme.name.trim()).not.toBe('')
    }
  })

  it('has the default theme and the one new settings start with', () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true)
    expect(THEMES.some((t) => t.id === createDefaultSettings().appearance.themeId)).toBe(true)
  })

  describe.each(THEMES.map((theme) => [theme.id, theme] as const))('%s', (_id, theme) => {
    it('is dark or light', () => {
      expect(['dark', 'light']).toContain(theme.mode)
    })

    it('has every app color as hex', () => {
      expect(Object.keys(theme.colors).sort()).toEqual([...COLOR_KEYS].sort())
      for (const key of COLOR_KEYS) expect(parseHex(theme.colors[key]), `colors.${key}`).not.toBeNull()
    })

    it('has a complete terminal palette as hex, the selection as hex or rgba', () => {
      expect(Object.keys(theme.terminal).sort()).toEqual([...PALETTE_KEYS].sort())
      for (const key of PALETTE_KEYS) {
        const color = theme.terminal[key]
        if (key === 'selectionBackground') {
          expect(parseHex(color) !== null || RGBA_RE.test(color), `terminal.${key}: ${color}`).toBe(true)
        } else {
          expect(parseHex(color), `terminal.${key}`).not.toBeNull()
        }
      }
    })

    it('matches its mode: text lighter than the background in dark themes, darker in light ones', () => {
      for (const { background, foreground } of [theme.colors, theme.terminal]) {
        const lighterText = luminance(foreground) > luminance(background)
        expect(lighterText).toBe(theme.mode === 'dark')
      }
    })
  })
})

describe('findTheme', () => {
  it('finds a theme by id', () => {
    for (const theme of THEMES) expect(findTheme(theme.id)).toBe(theme)
  })

  it('falls back to the default theme', () => {
    const fallback = THEMES.find((t) => t.id === DEFAULT_THEME_ID)
    expect(findTheme('no-such-theme')).toBe(fallback)
    expect(findTheme('')).toBe(fallback)
    expect(findTheme(null)).toBe(fallback)
    expect(findTheme(undefined)).toBe(fallback)
  })
})
