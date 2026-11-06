import { describe, expect, it } from 'vitest'
import { searchTerms } from '@shared/utils'
import { matchSettings, settingsIndex, type SettingsAnchor, type SettingsEntry } from './settings-index'

const windows = settingsIndex('win32')
const linux = settingsIndex('linux')
const entry = (entries: SettingsEntry[], id: SettingsAnchor) => entries.find((e) => e.id === id)

/** What the settings page shows for a search. */
function shown(query: string, entries = windows) {
  const match = matchSettings(entries, searchTerms(query))
  return match && { ids: [...match.ids], tabs: match.tabs }
}

describe('settingsIndex', () => {
  it('has every anchor once', () => {
    expect(new Set(windows.map((e) => e.id)).size).toBe(windows.length)
  })

  it('leaves out what only Windows has', () => {
    const ids = linux.map((e) => e.id)
    expect(windows.map((e) => e.id)).toContain('appearance.material')
    expect(ids).not.toContain('appearance.material')
    expect(ids).not.toContain('terminal.modernConpty')
    expect(ids).toContain('appearance.window')
  })

  it('names things like the system does', () => {
    expect(entry(windows, 'claude.launchAtLogin')?.label).toBe('Mit Windows starten')
    expect(entry(linux, 'claude.launchAtLogin')?.label).toBe('Beim Anmelden starten')
  })

  it('says where something is without repeating names', () => {
    expect(entry(windows, 'terminal.fontSize')?.path).toEqual(['Terminal', 'Schrift'])
    expect(entry(windows, 'terminal.font')?.path).toEqual(['Terminal'])
    expect(entry(windows, 'notifications.enabled')?.path).toEqual([])
    expect(entry(windows, 'updates.notes')?.path).toEqual(['Updates'])
  })

  it('marks the tabs without controls', () => {
    expect(entry(windows, 'about.dataDir')?.linked).toBe(true)
    expect(entry(windows, 'api.port')?.linked).toBe(false)
  })

  it('types the anchors', () => {
    // @ts-expect-error not an anchor of the settings page
    const wrong: SettingsAnchor = 'terminal.nothing'
    expect(wrong).toBeTruthy()
  })
})

describe('matchSettings', () => {
  it('is null without a search', () => {
    expect(shown('')).toBeNull()
    expect(shown('   ')).toBeNull()
  })

  it('shows the hits with their cards', () => {
    const result = shown('schriftgröße')!
    expect(result.ids).toEqual(expect.arrayContaining(['appearance.window', 'appearance.uiFontSize', 'terminal.font', 'terminal.fontSize']))
    expect(result.ids).not.toContain('terminal.lineHeight')
    expect(result.ids).not.toContain('appearance.radius')
    expect(result.tabs).toEqual(['appearance', 'terminal'])
  })

  it('shows every row of a card that is looked for', () => {
    expect(shown('innenabstand')!.ids).toEqual([
      'terminal.padding',
      'terminal.paddingTop',
      'terminal.paddingBottom',
      'terminal.paddingLeft',
      'terminal.paddingRight',
    ])
  })

  it('needs every word, also from the tab and the card', () => {
    expect(shown('terminal schriftgröße')!.ids).toEqual(['terminal.font', 'terminal.fontSize'])
    expect(shown('größe oberfläche')!.ids).toEqual(['appearance.window', 'appearance.uiFontSize'])
  })

  it('finds keywords', () => {
    expect(shown('acryl')!.ids).toEqual(expect.arrayContaining(['appearance.material', 'terminal.backgroundOpacity']))
    expect(shown('acryl', linux)).toEqual({ ids: [], tabs: [] })
  })

  it('finds nothing', () => {
    expect(shown('xyz')).toEqual({ ids: [], tabs: [] })
  })
})

/** The cards and rows of the settings page, read from its templates. */
describe('settings page', () => {
  const files = import.meta.glob<string>('../components/settings/*.vue', { query: '?raw', import: 'default', eager: true })
  const sources = Object.values(files).join('\n')

  const TAG = /<(SettingField|SettingsSection)((?:\s+[:@#]?[\w.:-]+(?:="[^"]*")?)*)\s*\/?>/g
  const ATTR = /([:@#]?[\w.:-]+)(?:="([^"]*)")?/g
  const tags = [...sources.matchAll(TAG)].map(([, tag, attrs]) => ({
    tag,
    attrs: Object.fromEntries([...attrs.matchAll(ATTR)].map(([, name, value]) => [name, value ?? ''])),
  }))
  // Not `:data-setting="anchor"` of the components themselves.
  const anchors = [...sources.matchAll(/(?<![:\w-])(?:anchor|data-setting)="([^"]+)"/g)].map(([, id]) => id)
  const all = new Map([...linux, ...windows].map((e) => [e.id as string, e]))

  it('finds the rows', () => {
    expect(tags.length).toBeGreaterThan(50)
  })

  it('anchors every card and row', () => {
    expect(tags.filter((t) => !t.attrs.anchor)).toEqual([])
  })

  it('anchors everything of the index exactly once', () => {
    expect(anchors.toSorted()).toEqual([...all.keys()].toSorted())
  })

  it('has cards as sections and rows as fields', () => {
    for (const { tag, attrs } of tags) {
      expect([attrs.anchor, all.get(attrs.anchor)?.kind]).toEqual([attrs.anchor, tag === 'SettingsSection' ? 'section' : 'field'])
    }
  })

  it('names them like the index', () => {
    for (const { attrs } of tags) {
      const label = attrs.label ?? attrs.title
      if (label !== undefined) expect([attrs.anchor, label]).toEqual([attrs.anchor, all.get(attrs.anchor)?.label])
    }
  })
})
