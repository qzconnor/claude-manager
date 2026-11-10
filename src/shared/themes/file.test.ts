import { describe, expect, it } from 'vitest'
import { baseTheme, THEMES } from './builtin'
import { normalizeColor } from './colors'
import {
  customThemeStem,
  parseThemeFile,
  THEME_COLOR_KEYS,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  themeColor,
  themeContent,
  themeSlug,
  themeToFile,
  uniqueSlug,
  uniqueThemeName,
  withThemeColor,
} from './file'

const ember = THEMES.find((t) => t.id === 'ember')!

describe('theme files', () => {
  it('know every color of a theme once', () => {
    expect(new Set(THEME_COLOR_KEYS).size).toBe(THEME_COLOR_KEYS.length)
    expect(THEME_COLOR_KEYS.length).toBe(Object.keys(ember.colors).length + Object.keys(ember.terminal).length)
  })

  it('group the colors like the editor, in a fixed order', () => {
    const file = themeToFile(ember)
    expect(Object.keys(file)).toEqual(['format', 'version', 'name', 'mode', 'app', 'terminal'])
    expect(file.format).toBe(THEME_FILE_FORMAT)
    expect(file.version).toBe(THEME_FILE_VERSION)
    expect(Object.keys(file.terminal)).toEqual(['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'normal', 'bright'])
    expect(file.terminal.normal.red).toBe(ember.terminal.red)
    expect(file.terminal.bright.red).toBe(ember.terminal.brightRed)
    expect(file.app.primary).toBe(ember.colors.primary)
  })

  it.each(THEMES.map((t) => [t.id, t] as const))('keep %s as it is, the colors tidied', (_, theme) => {
    const back = parseThemeFile(JSON.parse(JSON.stringify(themeToFile(theme))), 'x')
    let tidied = themeContent(theme)
    for (const key of THEME_COLOR_KEYS) tidied = withThemeColor(tidied, key, normalizeColor(themeColor(theme, key))!)
    expect(back).toEqual(tidied)
  })

  it('reads and changes a color by its path', () => {
    expect(themeColor(ember, 'terminal.bright.magenta')).toBe(ember.terminal.brightMagenta)
    expect(themeColor(ember, 'app.mutedForeground')).toBe(ember.colors.mutedForeground)
    const changed = withThemeColor(ember, 'terminal.normal.blue', '#123456')
    expect(changed.terminal.blue).toBe('#123456')
    expect(ember.terminal.blue).not.toBe('#123456')
  })
})

describe('parseThemeFile', () => {
  it('fills colors the file lacks from the built-in theme of its mode', () => {
    const light = parseThemeFile({ format: THEME_FILE_FORMAT, name: 'Hell', mode: 'light', app: { primary: '#ff0000' } }, 'x')
    expect(light.colors.primary).toBe('#ff0000')
    expect(light.colors.background).toBe(baseTheme('light').colors.background)
    expect(light.terminal).toEqual(baseTheme('light').terminal)
  })

  it('takes the mode from the background when the file has none', () => {
    expect(parseThemeFile({ app: { background: '#fafafa' } }, 'x').mode).toBe('light')
    expect(parseThemeFile({ app: { background: '#101010' } }, 'x').mode).toBe('dark')
    expect(parseThemeFile({ terminal: {} }, 'x').mode).toBe('dark')
  })

  it('names the theme after the file without a name', () => {
    expect(parseThemeFile({ app: {} }, 'nachtblau').name).toBe('nachtblau')
    expect(parseThemeFile({ name: '  Nacht  ', app: {} }, 'x').name).toBe('Nacht')
  })

  it('normalizes the colors', () => {
    const theme = parseThemeFile({ app: { primary: '#ABC', success: 'rgb(0, 128, 0)' }, terminal: { selectionBackground: '#ff000080' } }, 'x')
    expect(theme.colors.primary).toBe('#aabbcc')
    expect(theme.colors.success).toBe('#008000')
    expect(theme.terminal.selectionBackground).toBe('rgba(255, 0, 0, 0.5)')
  })

  it('also reads the flat form of the app code', () => {
    const theme = parseThemeFile({ name: 'Flach', mode: 'dark', colors: { primary: '#010203' }, terminal: { brightRed: '#ff0001', red: '#aa0000' } }, 'x')
    expect(theme.colors.primary).toBe('#010203')
    expect(theme.terminal.brightRed).toBe('#ff0001')
    expect(theme.terminal.red).toBe('#aa0000')
  })

  it('names the colors that are wrong', () => {
    expect(() => parseThemeFile({ app: { primary: 'blau' } }, 'x')).toThrow(/Ungültige Farbe: app\.primary \("blau"\)/)
    expect(() => parseThemeFile({ terminal: { normal: { red: 7 } } }, 'x')).toThrow(/terminal\.normal\.red \(7\)/)
    // Only the selection may be see-through.
    expect(() => parseThemeFile({ app: { background: 'rgba(0, 0, 0, 0.5)' } }, 'x')).toThrow(/app\.background/)
    const many = { app: { background: 'a', foreground: 'b', surface: 'c', popover: 'd', primary: 'e' } }
    expect(() => parseThemeFile(many, 'x')).toThrow(/und 2 weitere/)
  })

  it('refuses what is no theme', () => {
    expect(() => parseThemeFile(null, 'x')).toThrow(/kein Theme/)
    expect(() => parseThemeFile([], 'x')).toThrow(/kein Theme/)
    expect(() => parseThemeFile({ foo: 1 }, 'x')).toThrow(/kein Theme/)
    expect(() => parseThemeFile({ format: 'claude-manager-settings', settings: {} }, 'x')).toThrow(/kein Theme des Claude Managers/)
    expect(() => parseThemeFile({ format: THEME_FILE_FORMAT, version: THEME_FILE_VERSION + 1 }, 'x')).toThrow(/neueren Version/)
  })
})

describe('names', () => {
  it('makes file names of theme names', () => {
    expect(themeSlug('Mein Theme')).toBe('mein-theme')
    expect(themeSlug('Grün & Größe')).toBe('gruen-groesse')
    expect(themeSlug('Café Noir!')).toBe('cafe-noir')
    expect(themeSlug('***')).toBe('theme')
    expect(themeSlug('CON')).toBe('con-theme')
    expect(themeSlug('x'.repeat(80)).length).toBeLessThanOrEqual(48)
  })

  it('numbers a file name that is taken, without case like Windows', () => {
    expect(uniqueSlug('nord', [])).toBe('nord')
    expect(uniqueSlug('nord', ['Nord', 'nord-2'])).toBe('nord-3')
  })

  it('numbers a theme name that is taken', () => {
    expect(uniqueThemeName('Ember', ['Ember', 'ember 2'])).toBe('Ember 3')
    expect(uniqueThemeName('  ', [])).toBe('Eigenes Theme')
    expect(uniqueThemeName('Neu', ['Alt'])).toBe('Neu')
  })

  it('tells custom ids from built-in ones', () => {
    expect(customThemeStem('custom:nachtblau')).toBe('nachtblau')
    expect(customThemeStem('ember')).toBeNull()
    expect(customThemeStem('custom:')).toBeNull()
    expect(customThemeStem(null)).toBeNull()
  })
})
