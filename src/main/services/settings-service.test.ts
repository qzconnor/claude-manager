import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import type { AppSettings } from '@shared/types'
import { SettingsService } from './settings-service'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const defaults = () => createDefaultSettings(process.platform)

/** A service whose settings.json has `stored` as content (a string is written as it is). */
async function load(stored: unknown): Promise<SettingsService> {
  await writeFile(join(dir, 'settings.json'), typeof stored === 'string' ? stored : JSON.stringify(stored))
  return new SettingsService(dir)
}

async function readStored(file = join(dir, 'settings.json')): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

describe('SettingsService loading', () => {
  it('starts with the defaults of this platform without a settings file', () => {
    expect(new SettingsService(dir).get()).toEqual(defaults())
  })

  it('starts with the defaults when the file is no valid JSON', async () => {
    expect((await load('{ "appearance": ')).get()).toEqual(defaults())
    expect((await load('[1, 2]')).get()).toEqual(defaults())
    expect((await load('null')).get()).toEqual(defaults())
  })

  it('reads a file with a byte order mark', async () => {
    const settings = (await load('﻿{"appearance":{"surfaceOpacity":40}}')).get()
    expect(settings.appearance.surfaceOpacity).toBe(40)
  })

  it('keeps valid values and fills missing sections and keys with the defaults', async () => {
    const settings = (await load({ appearance: { surfaceOpacity: 40, themeId: 'paper' }, notifications: { nearLimitPercent: 90 } })).get()
    expect(settings.appearance).toEqual({ ...defaults().appearance, surfaceOpacity: 40, themeId: 'paper' })
    expect(settings.notifications).toEqual({ ...defaults().notifications, nearLimitPercent: 90 })
    expect(settings.terminal).toEqual(defaults().terminal)
    expect(settings.api).toEqual(defaults().api)
  })

  it('drops unknown sections and keys', async () => {
    const settings = (await load({ legacy: { a: 1 }, appearance: { blur: 12, surfaceOpacity: 50 } })).get()
    expect(settings).not.toHaveProperty('legacy')
    expect(settings.appearance).not.toHaveProperty('blur')
    expect(settings.appearance.surfaceOpacity).toBe(50)
  })

  it('ignores values of the wrong type', async () => {
    const settings = (
      await load({
        appearance: { surfaceOpacity: '50', keepMaterialWhenInactive: 'no' },
        terminal: { fontSize: [16], cursorBlink: 0 },
        notifications: { nearLimitPercent: '85', enabled: 'false' },
        claude: { defaultArgs: '--verbose', defaultCwdAsked: 'yes' },
      })
    ).get()
    expect(settings.appearance.surfaceOpacity).toBe(defaults().appearance.surfaceOpacity)
    expect(settings.appearance.keepMaterialWhenInactive).toBe(true)
    expect(settings.terminal.fontSize).toBe(defaults().terminal.fontSize)
    expect(settings.terminal.cursorBlink).toBe(true)
    expect(settings.notifications.nearLimitPercent).toBe(80)
    expect(settings.notifications.enabled).toBe(true)
    expect(settings.claude.defaultArgs).toEqual([])
    expect(settings.claude.defaultCwdAsked).toBe(false)
  })

  it('keeps a whole section of the wrong type at its defaults', async () => {
    const settings = (await load({ terminal: 'big', notifications: null, api: [1] })).get()
    expect(settings.terminal).toEqual(defaults().terminal)
    expect(settings.notifications).toEqual(defaults().notifications)
    expect(settings.api).toEqual(defaults().api)
  })

  it.each([
    [5, 10],
    [9.4, 10],
    [10, 10],
    [80.5, 81],
    [99, 99],
    [99.6, 99],
    [150, 99],
    [-20, 10],
  ])('clamps and rounds nearLimitPercent %s to %s', async (stored, expected) => {
    expect((await load({ notifications: { nearLimitPercent: stored } })).get().notifications.nearLimitPercent).toBe(expected)
  })

  it.each([
    [-5, 0],
    [0, 0],
    [55.5, 55.5],
    [100, 100],
    [250, 100],
  ])('clamps surfaceOpacity %s to %s', async (stored, expected) => {
    expect((await load({ appearance: { surfaceOpacity: stored } })).get().appearance.surfaceOpacity).toBe(expected)
  })

  it('falls back to the default for a null number where it is not rounded first', async () => {
    const settings = (await load({ appearance: { surfaceOpacity: null, uiFontSize: null }, terminal: { padding: { top: null } } })).get()
    expect(settings.appearance.surfaceOpacity).toBe(defaults().appearance.surfaceOpacity)
    expect(settings.appearance.uiFontSize).toBe(defaults().appearance.uiFontSize)
    expect(settings.terminal.padding.top).toBe(defaults().terminal.padding.top)
  })

  it('falls back to the default for a null number that is rounded, not to the minimum', async () => {
    const settings = (
      await load({
        notifications: { nearLimitPercent: null, minBusySeconds: null },
        api: { port: null },
        terminal: { scrollback: null, fontWeight: null, fontWeightBold: null },
      })
    ).get()
    const d = defaults()
    expect(settings.notifications.nearLimitPercent).toBe(d.notifications.nearLimitPercent)
    expect(settings.notifications.minBusySeconds).toBe(d.notifications.minBusySeconds)
    expect(settings.api.port).toBe(d.api.port)
    expect(settings.terminal.scrollback).toBe(d.terminal.scrollback)
    expect(settings.terminal.fontWeight).toBe(d.terminal.fontWeight)
    expect(settings.terminal.fontWeightBold).toBe(d.terminal.fontWeightBold)
  })

  it('starts with the default font when the font family is null', async () => {
    const service = await load({ terminal: { fontFamily: null } })
    expect(service.get().terminal.fontFamily).toBe(defaults().terminal.fontFamily)
  })

  it('replaces null and other types in text settings with the defaults', async () => {
    const settings = (
      await load({
        appearance: { themeId: null },
        claude: { executablePath: null, defaultCwd: 42 },
        general: { defaultAccountId: null },
      })
    ).get()
    const d = defaults()
    expect(settings.appearance.themeId).toBe(d.appearance.themeId)
    expect(settings.claude.executablePath).toBe(d.claude.executablePath)
    expect(settings.claude.defaultCwd).toBe(d.claude.defaultCwd)
    expect(settings.general.defaultAccountId).toBe(d.general.defaultAccountId)
  })

  it('takes a colour scheme id or null where the default is null', async () => {
    expect((await load({ terminal: { colorSchemeId: 'dracula' } })).get().terminal.colorSchemeId).toBe('dracula')
    expect((await load({ terminal: { colorSchemeId: null } })).get().terminal.colorSchemeId).toBeNull()
    expect((await load({ terminal: { colorSchemeId: 7 } })).get().terminal.colorSchemeId).toBeNull()
  })

  it('keeps the other numbers in their ranges', async () => {
    const settings = (
      await load({
        appearance: { uiFontSize: 4, radius: 3 },
        terminal: {
          fontSize: 100,
          lineHeight: 0.5,
          letterSpacing: -12,
          fontWeight: 449,
          fontWeightBold: 1200,
          scrollback: 10,
          padding: { top: -4, right: 60, bottom: 8, left: 2.5 },
          backgroundOpacity: 120,
          minimumContrastRatio: 30,
        },
        claude: { usageRefreshMinutes: 1 },
        notifications: { minBusySeconds: 99999.4 },
        api: { port: 80 },
      })
    ).get()
    expect(settings.appearance.uiFontSize).toBe(11)
    expect(settings.appearance.radius).toBe(1.5)
    expect(settings.terminal.fontSize).toBe(40)
    expect(settings.terminal.lineHeight).toBe(1)
    expect(settings.terminal.letterSpacing).toBe(-5)
    expect(settings.terminal.fontWeight).toBe(400)
    expect(settings.terminal.fontWeightBold).toBe(900)
    expect(settings.terminal.scrollback).toBe(500)
    expect(settings.terminal.padding).toEqual({ top: 0, right: 48, bottom: 8, left: 2.5 })
    expect(settings.terminal.backgroundOpacity).toBe(100)
    expect(settings.terminal.minimumContrastRatio).toBe(21)
    expect(settings.claude.usageRefreshMinutes).toBe(2)
    expect(settings.notifications.minBusySeconds).toBe(3600)
    expect(settings.api.port).toBe(1024)
  })

  it('rounds the font weights to hundreds', async () => {
    const settings = (await load({ terminal: { fontWeight: 551, fontWeightBold: 649 } })).get()
    expect(settings.terminal.fontWeight).toBe(600)
    expect(settings.terminal.fontWeightBold).toBe(600)
  })

  it('replaces unknown choices with the defaults', async () => {
    const settings = (
      await load({
        appearance: { material: 'glass', tabPosition: 'left' },
        terminal: { cursorStyle: 'beam', renderer: 'canvas', unicode: 'unicode6', panelBackground: 'black', diffColors: 'neon', logoColor: 'pink' },
        general: { closeOnExit: 'sometimes' },
        notifications: { when: 'always' },
      })
    ).get()
    expect(settings.appearance.material).toBe('acrylic')
    expect(settings.appearance.tabPosition).toBe('top')
    expect(settings.terminal.cursorStyle).toBe('bar')
    expect(settings.terminal.renderer).toBe('webgl')
    expect(settings.terminal.unicode).toBe('graphemes')
    expect(settings.terminal.panelBackground).toBe('theme')
    expect(settings.terminal.diffColors).toBe('theme')
    expect(settings.terminal.logoColor).toBe('theme')
    expect(settings.general.closeOnExit).toBe('graceful')
    expect(settings.notifications.when).toBe('background')
  })

  it('keeps valid choices', async () => {
    const settings = (
      await load({
        appearance: { material: 'mica', tabPosition: 'groups' },
        terminal: { cursorStyle: 'underline', renderer: 'dom', unicode: 'unicode11', panelBackground: 'original', diffColors: 'original', logoColor: 'original' },
        general: { closeOnExit: 'never' },
        notifications: { when: 'hidden' },
      })
    ).get()
    expect(settings.appearance.material).toBe('mica')
    expect(settings.appearance.tabPosition).toBe('groups')
    expect(settings.terminal.cursorStyle).toBe('underline')
    expect(settings.terminal.renderer).toBe('dom')
    expect(settings.terminal.unicode).toBe('unicode11')
    expect(settings.terminal.panelBackground).toBe('original')
    expect(settings.terminal.diffColors).toBe('original')
    expect(settings.terminal.logoColor).toBe('original')
    expect(settings.general.closeOnExit).toBe('never')
    expect(settings.notifications.when).toBe('hidden')
  })

  it('cleans up the Claude settings', async () => {
    const settings = (
      await load({
        terminal: { fontFamily: '   ' },
        claude: { defaultArgs: ['--verbose', '', 7, null, '--model'], continuePrompt: `  ${'x'.repeat(2500)}  ` },
      })
    ).get()
    expect(settings.terminal.fontFamily).toBe(defaults().terminal.fontFamily)
    expect(settings.claude.defaultArgs).toEqual(['--verbose', '--model'])
    expect(settings.claude.continuePrompt).toBe('x'.repeat(2000))
  })

  it('takes over the single padding of older versions, keeping the scrollbar free on the right', async () => {
    expect((await load({ terminal: { padding: 8 } })).get().terminal.padding).toEqual({ top: 8, right: 14, bottom: 8, left: 8 })
    expect((await load({ terminal: { padding: 20 } })).get().terminal.padding).toEqual({ top: 20, right: 20, bottom: 20, left: 20 })
  })

  it('moves the old taskbar flashing setting to the notifications', async () => {
    const settings = (await load({ general: { flashOnTurnEnd: false } })).get()
    expect(settings.notifications.flashTaskbar).toBe(false)
    expect(settings.general).not.toHaveProperty('flashOnTurnEnd')
  })

  it('keeps an explicit taskbar flashing setting over the old one', async () => {
    const settings = (await load({ general: { flashOnTurnEnd: false }, notifications: { flashTaskbar: true, sound: false } })).get()
    expect(settings.notifications.flashTaskbar).toBe(true)
    expect(settings.notifications.sound).toBe(false)
  })
})

describe('SettingsService changes', () => {
  it('returns copies that cannot change the stored settings', () => {
    const service = new SettingsService(dir)
    const copy = service.get()
    copy.appearance.surfaceOpacity = 1
    copy.claude.defaultArgs.push('--x')
    expect(service.get().appearance.surfaceOpacity).toBe(defaults().appearance.surfaceOpacity)
    expect(service.get().claude.defaultArgs).toEqual([])
  })

  it('cleans up, saves and announces an update', async () => {
    const service = new SettingsService(dir)
    const changed = vi.fn<(next: AppSettings, previous: AppSettings) => void>()
    service.on('changed', changed)
    const result = await service.update({ notifications: { nearLimitPercent: 120, onDone: false }, appearance: { material: 'mica' } })
    expect(result.notifications.nearLimitPercent).toBe(99)
    expect(result.notifications.onDone).toBe(false)
    expect(result.appearance.material).toBe('mica')
    expect(changed).toHaveBeenCalledOnce()
    const [next, previous] = changed.mock.calls[0]
    expect(next).toEqual(result)
    expect(previous.notifications.nearLimitPercent).toBe(80)
    const stored = await readStored()
    expect(stored.notifications).toEqual(result.notifications)
    // A new service reads what was saved.
    expect(new SettingsService(dir).get()).toEqual(result)
  })

  it('keeps the previous value for null or a wrong type in an update', async () => {
    const service = new SettingsService(dir)
    await service.update({ notifications: { nearLimitPercent: 90 }, terminal: { fontFamily: 'Cascadia Mono' } })
    const result = await service.update({
      notifications: { nearLimitPercent: null, onDone: false },
      terminal: { fontFamily: null, fontSize: '16' },
    } as never)
    expect(result.notifications.nearLimitPercent).toBe(90)
    expect(result.notifications.onDone).toBe(false)
    expect(result.terminal.fontFamily).toBe('Cascadia Mono')
    expect(result.terminal.fontSize).toBe(defaults().terminal.fontSize)
  })

  it('can clear the colour scheme again', async () => {
    const service = new SettingsService(dir)
    await service.update({ terminal: { colorSchemeId: 'dracula' } })
    expect((await service.update({ terminal: { colorSchemeId: null } })).terminal.colorSchemeId).toBeNull()
  })

  it('imports a file with null values without failing', async () => {
    const service = new SettingsService(dir)
    const file = join(dir, 'import.json')
    await writeFile(file, JSON.stringify({ terminal: { fontFamily: null, fontSize: 15 }, appearance: { themeId: null } }))
    const { settings } = await service.importFrom(file)
    expect(settings.terminal.fontFamily).toBe(defaults().terminal.fontFamily)
    expect(settings.terminal.fontSize).toBe(15)
    expect(settings.appearance.themeId).toBe(defaults().appearance.themeId)
  })

  it('resets one section or everything', async () => {
    const service = new SettingsService(dir)
    await service.update({ appearance: { surfaceOpacity: 10 }, api: { port: 5000 } })
    const section = await service.reset('appearance')
    expect(section.appearance).toEqual(defaults().appearance)
    expect(section.api.port).toBe(5000)
    expect(await service.reset()).toEqual(defaults())
    expect(new SettingsService(dir).get()).toEqual(defaults())
  })
})

describe('SettingsService export and import', () => {
  it('exports without what belongs to this installation', async () => {
    const service = new SettingsService(dir)
    await service.update({ general: { defaultAccountId: 'acc-1', runInTray: true }, claude: { defaultCwdAsked: true } })
    const file = join(dir, 'export.json')
    await service.exportTo(file, '1.2.3')
    const exported = await readStored(file)
    expect(exported).toMatchObject({ format: 'claude-manager-settings', version: 1, appVersion: '1.2.3' })
    expect(typeof exported.exportedAt).toBe('string')
    const settings = exported.settings as AppSettings
    expect(settings.general.runInTray).toBe(true)
    expect(settings.general).not.toHaveProperty('defaultAccountId')
    expect(settings.claude).not.toHaveProperty('defaultCwdAsked')
  })

  it('imports an export and keeps the local values', async () => {
    const source = new SettingsService(dir)
    await source.update({ appearance: { surfaceOpacity: 33 }, general: { defaultAccountId: 'remote' } })
    const file = join(dir, 'export.json')
    await source.exportTo(file, '1.0.0')

    const otherDir = await mkdtemp(join(tmpdir(), 'cm-test-'))
    try {
      const target = new SettingsService(otherDir)
      await target.update({ general: { defaultAccountId: 'local' }, claude: { defaultCwdAsked: true } })
      const result = await target.importFrom(file)
      expect(result.skipped).toEqual([])
      expect(result.settings.appearance.surfaceOpacity).toBe(33)
      expect(result.settings.general.defaultAccountId).toBe('local')
      expect(result.settings.claude.defaultCwdAsked).toBe(true)
    } finally {
      await rm(otherDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('imports a plain settings.json, cleaned up and migrated', async () => {
    const file = join(dir, 'other-settings.json')
    await writeFile(file, JSON.stringify({ terminal: { padding: 4, fontSize: 99 }, notifications: { nearLimitPercent: 3 } }))
    const { settings } = await new SettingsService(dir).importFrom(file)
    expect(settings.terminal.padding).toEqual({ top: 4, right: 14, bottom: 4, left: 4 })
    expect(settings.terminal.fontSize).toBe(40)
    expect(settings.notifications.nearLimitPercent).toBe(10)
  })

  it('keeps paths of another computer that do not exist here', async () => {
    const service = new SettingsService(dir)
    await service.update({ claude: { executablePath: join(dir, 'claude-here'), defaultCwd: dir } })
    await writeFile(join(dir, 'claude-here'), '')
    const file = join(dir, 'export.json')
    await writeFile(
      file,
      JSON.stringify({
        format: 'claude-manager-settings',
        version: 1,
        settings: { claude: { executablePath: join(dir, 'missing', 'claude'), defaultCwd: join(dir, 'claude-here'), usageRefreshMinutes: 10 } },
      }),
    )
    const result = await service.importFrom(file)
    const exeLabel = process.platform === 'win32' ? 'Pfad zur claude.exe' : 'Pfad zu claude'
    expect(result.skipped).toEqual([exeLabel, 'Standard-Arbeitsordner'])
    expect(result.settings.claude.executablePath).toBe(join(dir, 'claude-here'))
    // A file is no working folder.
    expect(result.settings.claude.defaultCwd).toBe(dir)
    expect(result.settings.claude.usageRefreshMinutes).toBe(10)
  })

  it('takes over paths that exist here', async () => {
    await writeFile(join(dir, 'claude'), '')
    const file = join(dir, 'export.json')
    await writeFile(
      file,
      JSON.stringify({ format: 'claude-manager-settings', version: 1, settings: { claude: { executablePath: join(dir, 'claude'), defaultCwd: dir } } }),
    )
    const result = await new SettingsService(dir).importFrom(file)
    expect(result.skipped).toEqual([])
    expect(result.settings.claude.executablePath).toBe(join(dir, 'claude'))
    expect(result.settings.claude.defaultCwd).toBe(dir)
  })

  it.each([
    ['invalid JSON', '{ nope', 'kein gültiges JSON'],
    ['an export of a newer version', JSON.stringify({ format: 'claude-manager-settings', version: 2, settings: {} }), 'neueren Version'],
    ['another format', JSON.stringify({ format: 'something-else', settings: { appearance: {} } }), 'keine Einstellungen'],
    ['an export without settings', JSON.stringify({ format: 'claude-manager-settings', version: 1 }), 'keine Einstellungen'],
    ['JSON without a settings section', JSON.stringify({ foo: { bar: 1 }, appearance: 'x' }), 'keine Einstellungen'],
    ['a list', '[]', 'keine Einstellungen'],
  ])('refuses %s', async (_name, content, message) => {
    const file = join(dir, 'import.json')
    await writeFile(file, content)
    const service = new SettingsService(dir)
    await expect(service.importFrom(file)).rejects.toThrow(message)
    expect(service.get()).toEqual(defaults())
  })

  it('refuses a file larger than 1 MB', async () => {
    const file = join(dir, 'import.json')
    await writeFile(file, JSON.stringify({ appearance: { themeId: 'x'.repeat(1024 * 1024) } }))
    await expect(new SettingsService(dir).importFrom(file)).rejects.toThrow('zu groß')
  })
})
