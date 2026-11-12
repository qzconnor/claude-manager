import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import type { SettingChange } from '@shared/types'
import { isPlainObject } from '@shared/utils'
import { groupChanges, LOCAL_SETTINGS, SETTING_PLACES, settingValueText } from './setting-changes'
import { settingsIndex } from './settings-index'

/** The paths of all settings, e.g. `terminal.padding.top`, the way an import names its changes. */
function leaves(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return isPlainObject(item) ? leaves(item, path) : [path]
  })
}

const change = (path: string, to: unknown, from: unknown = null): SettingChange => ({ path, from, to, sensitive: false })
const noThemes = () => null

describe('SETTING_PLACES', () => {
  it.each(['win32', 'linux'])('knows the place of every setting an import can change (%s)', (platform) => {
    const paths = leaves(createDefaultSettings(platform) as unknown as Record<string, unknown>).filter(
      (path) => !LOCAL_SETTINGS.includes(path),
    )
    expect(Object.keys(SETTING_PLACES).sort()).toEqual(paths.sort())
  })

  it('points to rows and cards that exist on the settings page', () => {
    const anchors = new Set(settingsIndex('win32').map((entry) => entry.id))
    expect(Object.values(SETTING_PLACES).filter((place) => !anchors.has(place.anchor))).toEqual([])
  })
})

describe('groupChanges', () => {
  it('groups the changes by tab and puts tabs and changes in the order of the settings page', () => {
    const groups = groupChanges(
      [
        change('api.port', 4000),
        change('terminal.padding.top', 4),
        change('appearance.uiFontSize', 15),
        change('terminal.fontSize', 16),
        change('claude.shellToolsAllowed', true),
        change('general.closeOnExit', 'never'),
      ],
      'win32',
    )
    expect(groups.map((group) => [group.label, group.changes.map((c) => c.label)])).toEqual([
      ['Darstellung', ['Schriftgröße der Oberfläche']],
      ['Terminal', ['Schriftgröße', 'Innenabstand oben']],
      ['Claude Code', ['Tab schließen, wenn der Prozess endet']],
      ['Werkzeuge', ['Shell-Tabs ohne Nachfrage']],
      ['API', ['Port der API']],
    ])
  })

  it('takes the label of the system and keeps rows only Windows shows', () => {
    const groups = groupChanges([change('notifications.flashTaskbar', false), change('terminal.backgroundOpacity', 20)], 'linux')
    expect(groups.map((group) => [group.label, group.changes.map((c) => c.label)])).toEqual([
      ['Terminal', ['Hintergrund-Deckkraft']],
      ['Benachrichtigungen', ['Fenster in der Taskleiste markieren']],
    ])
  })

  it('keeps a setting it does not know under „Weitere“, at the end', () => {
    const groups = groupChanges([change('future.thing', 1), change('api.port', 4000)], 'win32')
    expect(groups.map((group) => [group.label, group.changes.map((c) => c.label)])).toEqual([
      ['API', ['Port der API']],
      ['Weitere', ['future.thing']],
    ])
  })
})

describe('settingValueText', () => {
  it('names choices, switches and numbers the way the settings page does', () => {
    expect(settingValueText('appearance.material', 'tabbed', noThemes)).toBe('Mica Alt')
    expect(settingValueText('notifications.when', 'hidden', noThemes)).toBe('Tab nicht sichtbar')
    expect(settingValueText('terminal.ligatures', true, noThemes)).toBe('An')
    expect(settingValueText('terminal.ligatures', false, noThemes)).toBe('Aus')
    expect(settingValueText('terminal.fontSize', 15, noThemes)).toBe('15 px')
    expect(settingValueText('appearance.surfaceOpacity', 40, noThemes)).toBe('40 %')
    expect(settingValueText('terminal.lineHeight', 1.25, noThemes)).toBe('1,25')
    expect(settingValueText('appearance.radius', 0.625, noThemes)).toBe('10 px')
    expect(settingValueText('terminal.scrollback', 20000, noThemes)).toBe('20.000 Zeilen')
    expect(settingValueText('api.port', 47821, noThemes)).toBe('47821')
  })

  it('shows empty values like the placeholders of the settings page', () => {
    expect(settingValueText('claude.executablePath', '', noThemes)).toBe('Automatisch')
    expect(settingValueText('claude.defaultArgs', [], noThemes)).toBe('keine')
    expect(settingValueText('claude.continuePrompt', '', noThemes)).toBe('nichts schicken')
    expect(settingValueText('terminal.fontFamily', '', noThemes)).toBe('(leer)')
  })

  it('shows the options of Claude Code the way they are typed', () => {
    expect(settingValueText('claude.defaultArgs', ['--settings', 'a b'], noThemes)).toBe('--settings "a b"')
  })

  it('names themes, and says when one is missing here', () => {
    const themeName = (id: string) => (id === 'ember' ? 'Ember' : null)
    expect(settingValueText('appearance.themeId', 'ember', themeName)).toBe('Ember')
    expect(settingValueText('terminal.colorSchemeId', 'custom:mine', themeName)).toBe('„custom:mine“ (fehlt hier)')
    expect(settingValueText('terminal.colorSchemeId', null, themeName)).toBe('Wie App-Theme')
  })
})
