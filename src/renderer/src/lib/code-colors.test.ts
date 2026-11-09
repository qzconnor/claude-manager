import { describe, expect, it } from 'vitest'
import { THEMES } from '@/themes/themes'
import { codeColor } from './code-colors'

/** WCAG contrast of two hex colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const SLOTS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

describe('codeColor', () => {
  it.each(THEMES.map((theme) => [theme.id, theme] as const))('reads well on the background of %s', (_, theme) => {
    const p = theme.terminal
    for (const slot of SLOTS) {
      const color = codeColor(p[slot], p.background)
      expect(color, slot).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrast(color, p.background), slot).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('leaves calm colours as they are', () => {
    // Tokyo Night's blue and Catppuccin's green are made for code already.
    expect(codeColor('#7aa2f7', '#1a1b26')).toBe('#7aa2f7')
    expect(codeColor('#a6e3a1', '#1e1e2e')).toBe('#a6e3a1')
  })

  it('calms a loud and dark terminal colour', () => {
    // Campbell's blue: hard to read on black, and glaring.
    const blue = codeColor('#0037da', '#0c0c0c')
    expect(contrast('#0037da', '#0c0c0c')).toBeLessThan(3)
    expect(contrast(blue, '#0c0c0c')).toBeGreaterThan(6)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(blue.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })

  it('darkens a light colour on a light background', () => {
    expect(contrast(codeColor('#df8e1d', '#eff1f5'), '#eff1f5')).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps what it cannot read', () => {
    expect(codeColor('rgb(1, 2, 3)', '#000000')).toBe('rgb(1, 2, 3)')
    expect(codeColor('#123456', 'transparent')).toBe('#123456')
  })
})
