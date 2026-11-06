import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSettings } from '@shared/types'
import { createDefaultSettings } from '@shared/defaults'
import { slotPalette, themeSlotTints } from '@/lib/claude-backgrounds'
import { findTheme } from '@/themes/themes'
import { buildFontStack } from './useTerminalAppearance'
import { placeColumns, terminalOptions, toXtermTheme } from './useTerminal'

// Only the pure helpers are tested: xterm, its addons, the stores and modules that touch `window`
// at import time are replaced.
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
vi.mock('@/lib/shortcuts', () => ({ matchShortcut: vi.fn() }))
vi.mock('@/lib/terminal-bus', () => ({ terminalBus: {} }))
vi.mock('@/lib/translucent-slots', () => ({ makeSlotsTranslucent: vi.fn(), setSlotTints: vi.fn() }))
vi.mock('@/lib/platform', () => ({ supportsMaterial: true }))
vi.mock('@/stores/app', () => ({ useAppStore: vi.fn() }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: vi.fn() }))

const palette = findTheme('ember').terminal
const tints = themeSlotTints(palette)

describe('toXtermTheme', () => {
  it('keeps the palette but leaves the background to the container', () => {
    const theme = toXtermTheme(palette, tints)
    expect(theme.background).toBe('#00000000')
    expect(theme.foreground).toBe(palette.foreground)
    expect(theme.red).toBe(palette.red)
    expect(theme.selectionBackground).toBe(palette.selectionBackground)
  })

  it('holds the opaque slot colors, mixed over the real background', () => {
    const theme = toXtermTheme(palette, tints)
    expect(theme.extendedAnsi).toEqual(slotPalette(tints, palette.background))
    for (const color of theme.extendedAnsi ?? []) expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('terminalOptions', () => {
  it('takes the settings over, with the font stack and the theme', () => {
    const settings: TerminalSettings = { ...createDefaultSettings('linux').terminal, fontFamily: 'Hack', fontSize: 15 }
    const options = terminalOptions(settings, palette, tints)
    expect(options.fontFamily).toBe(buildFontStack('Hack'))
    expect(options.fontSize).toBe(15)
    expect(options.scrollback).toBe(settings.scrollback)
    expect(options.cursorStyle).toBe(settings.cursorStyle)
    expect(options.theme).toEqual(toXtermTheme(palette, tints))
  })
})

describe('placeColumns', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const withPixelRatio = (devicePixelRatio: number | undefined) => vi.stubGlobal('window', { devicePixelRatio })

  it('fits whole columns between the paddings', () => {
    withPixelRatio(1)
    expect(placeColumns(800, 9, 12, 14)).toEqual({ cols: 86, offset: 12 })
  })

  it('splits what is left of a column between both sides', () => {
    withPixelRatio(1)
    // 774 px for columns of 10 px: 77 columns, 4 px left over.
    expect(placeColumns(800, 10, 12, 14)).toEqual({ cols: 77, offset: 14 })
  })

  it('rounds the offset down to whole device pixels', () => {
    withPixelRatio(1)
    expect(placeColumns(801, 10, 12, 14).offset).toBe(14)
    withPixelRatio(2)
    expect(placeColumns(801, 10, 12, 14).offset).toBe(14.5)
    withPixelRatio(1.5)
    expect(placeColumns(801, 10, 12, 14).offset).toBe(14)
  })

  it('treats a missing pixel ratio as 1', () => {
    withPixelRatio(undefined)
    expect(placeColumns(801, 10, 12, 14).offset).toBe(14)
  })

  it('keeps at least 2 columns when the space is too narrow', () => {
    withPixelRatio(1)
    expect(placeColumns(20, 9, 12, 14)).toEqual({ cols: 2, offset: 12 })
    expect(placeColumns(0, 9, 0, 0)).toEqual({ cols: 2, offset: 0 })
  })

  it('always lets the last column end before the right padding', () => {
    for (const ratio of [1, 1.25, 1.5, 2]) {
      withPixelRatio(ratio)
      for (const width of [640, 777, 1001.5]) {
        for (const cell of [7.2, 8.4, 9.6015625]) {
          const { cols, offset } = placeColumns(width, cell, 12, 14)
          expect(offset).toBeGreaterThanOrEqual(12)
          expect(offset + cols * cell).toBeLessThanOrEqual(width - 14 + 1e-9)
          expect(Math.round(offset * ratio * 1e6) / 1e6 % 1).toBe(0)
        }
      }
    }
  })
})
