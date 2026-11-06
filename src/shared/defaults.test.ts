import { describe, expect, it } from 'vitest'
import { createDefaultSettings, SYSTEM_ACCOUNT_ID, TERMINAL_FONT_FALLBACKS } from './defaults'
import { mergeKnown } from './utils'

describe('createDefaultSettings', () => {
  it('returns independent objects on every call', () => {
    const a = createDefaultSettings()
    const b = createDefaultSettings()
    expect(a).toEqual(b)
    a.terminal.padding.left = 99
    a.claude.defaultArgs.push('--verbose')
    a.appearance.themeId = 'nord'
    expect(b.terminal.padding.left).toBe(12)
    expect(b.claude.defaultArgs).toEqual([])
    expect(createDefaultSettings()).toEqual(b)
  })

  it('starts the terminal with Cascadia Mono on Windows and the bundled font elsewhere', () => {
    expect(createDefaultSettings().terminal.fontFamily).toBe('Cascadia Mono')
    expect(createDefaultSettings('win32').terminal.fontFamily).toBe('Cascadia Mono')
    expect(createDefaultSettings('linux').terminal.fontFamily).toBe('Geist Mono Variable')
    expect(createDefaultSettings('darwin').terminal.fontFamily).toBe('Geist Mono Variable')
  })

  it('opens new terminals in the standard account', () => {
    expect(createDefaultSettings().general.defaultAccountId).toBe(SYSTEM_ACCOUNT_ID)
  })

  it('survives a round trip through mergeKnown unchanged', () => {
    const settings = createDefaultSettings('linux')
    expect(mergeKnown(createDefaultSettings('win32'), JSON.parse(JSON.stringify(settings)))).toEqual(settings)
  })
})

describe('TERMINAL_FONT_FALLBACKS', () => {
  it('ends with the generic monospace family', () => {
    expect(TERMINAL_FONT_FALLBACKS.at(-1)).toBe('monospace')
  })
})
