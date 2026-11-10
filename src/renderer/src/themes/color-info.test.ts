import { describe, expect, it } from 'vitest'
import { THEME_COLOR_KEYS } from '@shared/themes/file'
import { COLOR_SECTIONS } from './color-info'

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
