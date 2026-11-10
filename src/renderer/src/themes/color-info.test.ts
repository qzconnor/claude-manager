import { describe, expect, it } from 'vitest'
import { THEMES } from '@shared/themes/builtin'
import { contrastRatio, parseColor } from '@shared/themes/colors'
import { THEME_COLOR_KEYS, themeColor } from '@shared/themes/file'
import { COLOR_SECTIONS, CONTRAST_PAIRS } from './color-info'

const described = COLOR_SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.colors))

describe('COLOR_SECTIONS', () => {
  it('describes every color of a theme once, in the order of the file', () => {
    expect(described.map((c) => c.key)).toEqual([...THEME_COLOR_KEYS])
  })

  it('has a label and a description for each', () => {
    for (const info of described) {
      expect(info.label.trim(), info.key).not.toBe('')
      expect(info.description.trim(), info.key).not.toBe('')
    }
  })

  it('groups each color under its section of the file', () => {
    for (const section of COLOR_SECTIONS) {
      for (const group of section.groups) {
        for (const info of group.colors) expect(info.key.startsWith(`${section.id}.`), info.key).toBe(true)
      }
    }
  })
})

describe('CONTRAST_PAIRS', () => {
  // A copy of a built-in theme starts without warnings.
  it.each(THEMES.map((t) => [t.id, t] as const))('find enough contrast in %s', (_, theme) => {
    for (const [key, pair] of Object.entries(CONTRAST_PAIRS)) {
      const ratio = contrastRatio(parseColor(themeColor(theme, key as never))!, parseColor(themeColor(theme, pair!.against))!)
      expect(ratio, `${key} on ${pair!.against}`).toBeGreaterThanOrEqual(pair!.min)
    }
  })
})
