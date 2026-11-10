import { describe, expect, it } from 'vitest'
import { THEMES } from './builtin'
import { contrastIssue, contrastIssues, suggestedMode } from './checks'
import { withThemeColor } from './file'

const ember = THEMES.find((t) => t.id === 'ember')!
const paper = THEMES.find((t) => t.id === 'paper')!

describe('contrastIssues', () => {
  // A copy of a built-in theme starts without warnings.
  it.each(THEMES.map((t) => [t.id, t] as const))('finds enough contrast in %s', (_, theme) => {
    expect(contrastIssues(theme)).toEqual([])
  })

  it('names text that is hard to read on its background', () => {
    const grey = withThemeColor(ember, 'app.foreground', '#3a3532')
    expect(contrastIssue(grey, 'app.foreground')).toMatchObject({ against: 'app.background', label: 'Hintergrund', min: 4.5 })
    expect(contrastIssue(grey, 'app.foreground')!.ratio).toBeLessThan(2)
    expect(contrastIssues(grey).map((i) => i.key)).toEqual(['app.foreground'])
    expect(contrastIssue(grey, 'terminal.normal.red')).toBeNull()
  })
})

describe('suggestedMode', () => {
  it('fits the built-in themes', () => {
    for (const theme of THEMES) expect(suggestedMode(theme), theme.id).toBeNull()
  })

  it('asks for the mode the colors fit', () => {
    expect(suggestedMode({ ...paper, mode: 'dark' })).toBe('light')
    expect(suggestedMode({ ...ember, mode: 'light' })).toBe('dark')
  })
})
