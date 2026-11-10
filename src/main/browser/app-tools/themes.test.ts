import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import { THEMES } from '@shared/themes/builtin'
import type { CustomThemeEntry } from '@shared/themes/types'
import type { AppSettings, ClaudeSettings, DeepPartial } from '@shared/types'
import { ThemeService } from '../../services/theme-service'
import { allowedToolNames } from '../mcp-server'
import { parseAppToolArgs } from '.'
import { applyTheme, buildTheme, checksText, createTheme, describeTheme, listThemes, parseColors, updateTheme, type CreateParams } from './themes'
import type { AppToolsDeps } from './tool'

const ember = THEMES.find((t) => t.id === 'ember')!
const paper = THEMES.find((t) => t.id === 'paper')!
const nord = THEMES.find((t) => t.id === 'nord')!

const create = (patch: Partial<CreateParams> = {}): CreateParams => ({
  name: 'Ozean',
  mode: undefined,
  base: undefined,
  colors: new Map(),
  apply: false,
  ...patch,
})

describe('arguments', () => {
  it('takes colors by their path, written as the theme files write them', () => {
    expect([...parseColors({ colors: { 'app.primary': '#ABC', 'terminal.selectionBackground': 'rgba(0, 0, 255, 0.3)' } })]).toEqual([
      ['app.primary', '#aabbcc'],
      ['terminal.selectionBackground', 'rgba(0, 0, 255, 0.3)'],
    ])
    expect(parseColors({}).size).toBe(0)
  })

  it('names unknown and wrong colors, and see-through ones where they may not be', () => {
    expect(() => parseColors({ colors: { 'app.accent': '#fff' } })).toThrow('Unknown colors: app.accent.')
    expect(() => parseColors({ colors: { 'app.primary': 'blue', 'terminal.normal.red': '#ff000080' } })).toThrow(
      'Invalid colors: app.primary ("blue"), terminal.normal.red ("#ff000080").',
    )
    expect(() => parseColors({ colors: ['#fff'] })).toThrow('colors must be an object')
  })

  it('needs a name to create and something to change', () => {
    expect(() => parseAppToolArgs('theme_create', {})).toThrow('name must be a non-empty string.')
    expect(() => parseAppToolArgs('theme_create', { name: 'x'.repeat(61) })).toThrow('at most 60 characters')
    expect(() => parseAppToolArgs('theme_create', { name: 'A', mode: 'grey' })).toThrow('mode must be one of dark, light.')
    expect(() => parseAppToolArgs('theme_update', { id: 'custom:a' })).toThrow('Give name, mode or colors to change.')
    expect(() => parseAppToolArgs('theme_update', { id: 'custom:a', apply: true })).toThrow('call theme_apply')
  })
})

describe('buildTheme', () => {
  it('fills in the colors not given from the built-in theme of its mode', () => {
    const dark = buildTheme(create({ colors: new Map([['app.primary', '#4f8cff']]) }), null)
    expect(dark).toMatchObject({ name: 'Ozean', mode: 'dark', colors: { ...ember.colors, primary: '#4f8cff' }, terminal: ember.terminal })
    expect(buildTheme(create({ mode: 'light' }), null).colors).toEqual(paper.colors)
  })

  it('takes the mode from the background, else from the base', () => {
    expect(buildTheme(create({ colors: new Map([['app.background', '#fafafa']]) }), null).mode).toBe('light')
    expect(buildTheme(create(), paper)).toMatchObject({ mode: 'light', colors: paper.colors })
    expect(buildTheme(create({ mode: 'dark' }), nord).terminal).toEqual(nord.terminal)
  })
})

describe('checksText', () => {
  it('points out weak contrast and a mode that does not fit', () => {
    expect(checksText(ember)).toBe('Contrast and mode are fine.')
    const weak = { ...ember, colors: { ...ember.colors, mutedForeground: ember.colors.background } }
    expect(checksText(weak)).toMatch(/^To check: app\.mutedForeground on app\.background has a contrast of 1\.0:1, at least 3:1 is needed\. Fix it/)
    expect(checksText({ ...ember, mode: 'light' })).toContain('so mode should be dark')
  })
})

describe('theme tools', () => {
  let root: string
  let themes: ThemeService
  let settings: AppSettings
  let deps: AppToolsDeps
  let saved: CustomThemeEntry[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'theme-tools-'))
    themes = new ThemeService(root)
    saved = []
    themes.on('saved', (entry) => saved.push(entry))
    settings = createDefaultSettings()
    const update = async (patch: DeepPartial<AppSettings>) => {
      // The window must know the theme before the setting that picks it.
      if (patch.appearance?.themeId?.startsWith('custom:')) expect(saved.map((e) => e.id)).toContain(patch.appearance.themeId)
      settings = {
        ...settings,
        appearance: { ...settings.appearance, ...patch.appearance },
        terminal: { ...settings.terminal, ...patch.terminal } as AppSettings['terminal'],
      }
      return settings
    }
    deps = { themes, settings: { get: () => settings, update } } as unknown as AppToolsDeps
  })

  afterEach(() => {
    themes.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a theme without using it, unless asked to', async () => {
    const text = await createTheme(deps, create({ base: 'nord', colors: new Map([['app.primary', '#4f8cff']]) }))
    expect(text).toContain('Created "Ozean" (custom:ozean), dark, based on "Nord" (nord), in ')
    expect(text).toContain('Not in use')
    expect(readdirSync(themes.dir)).toEqual(['ozean.json'])
    expect(settings.appearance.themeId).toBe('ember')

    const again = await createTheme(deps, create({ apply: true }))
    expect(again).toContain('Created "Ozean 2" (custom:ozean-2)')
    expect(again).toContain('The app uses "Ozean 2" (custom:ozean-2) now (before: "Ember" (ember)).')
    expect(settings.appearance.themeId).toBe('custom:ozean-2')
  })

  it('refuses a base that is not there', async () => {
    await expect(createTheme(deps, create({ base: 'custom:nope' }))).rejects.toThrow('There is no theme "custom:nope". Call themes_list')
  })

  it('changes colors and the name; settings that use it follow the new id', async () => {
    await createTheme(deps, create({ apply: true }))
    settings.terminal.colorSchemeId = 'custom:ozean'
    const text = await updateTheme(deps, { id: 'custom:ozean', name: 'Tiefsee', mode: undefined, colors: new Map([['app.primary', '#123456']]), apply: false })
    expect(text).toContain('With the new name its id is custom:tiefsee now (was custom:ozean).')
    expect(text).toContain('It is the theme in use')
    expect(settings.appearance.themeId).toBe('custom:tiefsee')
    expect(settings.terminal.colorSchemeId).toBe('custom:tiefsee')
    expect(readdirSync(themes.dir)).toEqual(['tiefsee.json'])
    expect(await describeTheme(deps, 'custom:tiefsee')).toContain('"app.primary": "#123456"')
  })

  it('leaves the built-in themes as they are', async () => {
    await expect(updateTheme(deps, { id: 'nord', name: 'X', mode: undefined, colors: new Map(), apply: false })).rejects.toThrow(
      "nord is a built-in theme and can't be changed. Create a theme with base \"nord\" instead.",
    )
  })

  it('lists the themes, the one in use and files that cannot be used', async () => {
    await createTheme(deps, create())
    writeFileSync(join(themes.dir, 'kaputt.json'), '{ nope')
    settings.terminal.colorSchemeId = 'dracula'
    const text = await listThemes(deps)
    expect(text).toContain('In use: "Ember" (ember); the terminals use their own scheme "Dracula" (dracula)')
    expect(text).toContain('- "Paper" (paper), light')
    expect(text).toContain('- "Ozean" (custom:ozean), dark')
    expect(text).toMatch(/kaputt\.json: can't be used: Kein gültiges JSON/)
  })

  it('switches back and names a terminal scheme of its own', async () => {
    settings.appearance.themeId = 'nord'
    settings.terminal.colorSchemeId = 'dracula'
    expect(await applyTheme(deps, ember)).toBe(
      'The app uses "Ember" (ember) now (before: "Nord" (nord)). The terminals keep their own color scheme dracula; the user changes that in Einstellungen › Terminal.',
    )
    expect(await applyTheme(deps, ember)).toBe('"Ember" (ember) is already the theme in use.')
  })
})

describe('permissions', () => {
  const claude = (patch: Partial<ClaudeSettings> = {}): ClaudeSettings => ({ ...createDefaultSettings().claude, ...patch })

  it('reads themes without asking; Claude Code asks before every change', () => {
    const allowed = allowedToolNames(claude({ shellTools: true, shellToolsAllowed: true }), [], true)
    expect(allowed).toContain('themes_list')
    expect(allowed.filter((name) => name.startsWith('theme_'))).toEqual([])
    expect(allowedToolNames(claude({ themesTool: false }), [], true)).not.toContain('themes_list')
  })
})
