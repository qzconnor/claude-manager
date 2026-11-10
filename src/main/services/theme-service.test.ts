import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEMES } from '@shared/themes/builtin'
import { THEME_FILE_FORMAT, themeContent, themeToFile } from '@shared/themes/file'
import { ThemeService } from './theme-service'

const ember = THEMES.find((t) => t.id === 'ember')!
const paper = THEMES.find((t) => t.id === 'paper')!

let root: string
let dir: string
let service: ThemeService
let trashed: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'themes-'))
  dir = join(root, 'themes')
  trashed = []
  service = new ThemeService(root, async (path) => {
    trashed.push(path)
    rmSync(path, { force: true })
  })
  service.init()
})

afterEach(() => {
  service.dispose()
  rmSync(root, { recursive: true, force: true })
})

const files = () => readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
const fileJson = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))

describe('ThemeService', () => {
  it('makes its folder', () => {
    expect(existsSync(dir)).toBe(true)
  })

  it('saves a new theme as a file named after it', async () => {
    const entry = await service.create({ ...themeContent(ember), name: 'Mein Theme' })
    expect(entry.id).toBe('custom:mein-theme')
    expect(entry.theme?.name).toBe('Mein Theme')
    expect(files()).toEqual(['mein-theme.json'])
    expect(fileJson('mein-theme.json')).toEqual(themeToFile({ ...themeContent(ember), name: 'Mein Theme' }))
  })

  it('numbers names and files that are taken', async () => {
    const first = await service.create({ ...themeContent(ember), name: 'Nacht' })
    const second = await service.create({ ...themeContent(ember), name: 'Nacht' })
    const builtIn = await service.create({ ...themeContent(ember), name: 'Ember' })
    expect([first.theme?.name, second.theme?.name, builtIn.theme?.name]).toEqual(['Nacht', 'Nacht 2', 'Ember 2'])
    expect(files()).toEqual(['ember-2.json', 'nacht-2.json', 'nacht.json'])
  })

  it('lists the files sorted by name, and says why one can not be used', async () => {
    await service.create({ ...themeContent(paper), name: 'Zitrone' })
    await service.create({ ...themeContent(ember), name: 'Apfel' })
    writeFileSync(join(dir, 'kaputt.json'), '{ "name": "Kaputt", ')
    writeFileSync(join(dir, 'falsch.json'), JSON.stringify({ format: THEME_FILE_FORMAT, app: { primary: 'lila' } }))
    writeFileSync(join(dir, 'notiz.txt'), 'keine Theme-Datei')
    const list = await service.list()
    expect(list.map((e) => e.id)).toEqual(['custom:apfel', 'custom:falsch', 'custom:kaputt', 'custom:zitrone'])
    expect(list.find((e) => e.id === 'custom:kaputt')?.error).toMatch(/Kein gültiges JSON/)
    expect(list.find((e) => e.id === 'custom:falsch')?.error).toMatch(/app\.primary/)
    expect(list.find((e) => e.id === 'custom:zitrone')?.theme?.mode).toBe('light')
  })

  it('takes a file copied in by hand, with the id of its name', async () => {
    writeFileSync(join(dir, 'Von Hand.json'), JSON.stringify(themeToFile({ ...themeContent(ember), name: 'Von Hand' })))
    const [entry] = await service.list()
    expect(entry.id).toBe('custom:Von Hand')
    expect(entry.theme?.id).toBe('custom:Von Hand')
  })

  it('keeps the file when the name stays, and renames it with a new name', async () => {
    const created = await service.create({ ...themeContent(ember), name: 'Alt' })
    const same = await service.save(created.id, { ...themeContent(ember), name: 'Alt', colors: { ...ember.colors, primary: '#123456' } })
    expect(same.id).toBe(created.id)
    expect(fileJson('alt.json').app.primary).toBe('#123456')

    const renamed = await service.save(created.id, { ...themeContent(ember), name: 'Neu' })
    expect(renamed.id).toBe('custom:neu')
    expect(files()).toEqual(['neu.json'])
  })

  it('does not rename a file named by hand while its name stays', async () => {
    writeFileSync(join(dir, 'Mein Export (1).json'), JSON.stringify(themeToFile({ ...themeContent(ember), name: 'Mein Export' })))
    const saved = await service.save('custom:Mein Export (1)', { ...themeContent(ember), name: 'Mein Export' })
    expect(saved.id).toBe('custom:Mein Export (1)')
    expect(files()).toEqual(['Mein Export (1).json'])
  })

  it('writes a theme again whose file was deleted meanwhile', async () => {
    const created = await service.create({ ...themeContent(ember), name: 'Weg' })
    rmSync(join(dir, 'weg.json'))
    const saved = await service.save(created.id, { ...themeContent(ember), name: 'Weg' })
    expect(saved.id).toBe(created.id)
    expect(files()).toEqual(['weg.json'])
  })

  it('moves a deleted theme to the recycle bin', async () => {
    const created = await service.create({ ...themeContent(ember), name: 'Tschüss' })
    await service.remove(created.id)
    expect(trashed).toEqual([join(dir, 'tschuess.json')])
    expect(files()).toEqual([])
  })

  it('refuses built-in themes and paths out of the folder', async () => {
    await expect(service.save('ember', themeContent(ember))).rejects.toThrow(/Eingebaute Themes/)
    await expect(service.remove('ember')).rejects.toThrow(/Eingebaute Themes/)
    await expect(service.remove('custom:../settings')).rejects.toThrow(/Ungültiges Theme/)
    await expect(service.remove('custom:a\\b')).rejects.toThrow(/Ungültiges Theme/)
  })

  it('exports and imports, the files that are no theme named', async () => {
    const created = await service.create({ ...themeContent(paper), name: 'Teilen' })
    const out = join(root, 'export.json')
    await service.exportTo(created.id, out)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(fileJson('teilen.json'))

    const bad = join(root, 'settings.json')
    writeFileSync(bad, JSON.stringify({ format: 'claude-manager-settings', settings: {} }))
    const result = await service.importFrom([out, bad, join(root, 'gibts-nicht.json')])
    expect(result.imported.map((e) => e.theme?.name)).toEqual(['Teilen 2'])
    expect(result.failed.map((f) => f.error)).toEqual([expect.stringMatching(/kein Theme des Claude Managers/), 'Die Datei gibt es nicht mehr.'])
    expect(files()).toEqual(['teilen-2.json', 'teilen.json'])
  })

  it('reports files that come, change and go in its folder', async () => {
    const changed = vi.fn()
    service.on('changed', changed)
    writeFileSync(join(dir, 'neu.json'), JSON.stringify(themeToFile({ ...themeContent(ember), name: 'Neu' })))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 })
    expect((await service.list()).map((e) => e.id)).toEqual(['custom:neu'])

    changed.mockClear()
    rmSync(join(dir, 'neu.json'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 })
    expect(await service.list()).toEqual([])
  })

  it('makes its folder again when it was deleted, and watches it', async () => {
    const changed = vi.fn()
    service.on('changed', changed)
    rmSync(dir, { recursive: true, force: true })
    await vi.waitFor(() => expect(existsSync(dir)).toBe(true), { timeout: 6000 })
    changed.mockClear()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wieder.json'), JSON.stringify(themeToFile({ ...themeContent(ember), name: 'Wieder' })))
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 })
    expect((await service.list()).map((e) => e.theme?.name)).toEqual(['Wieder'])
  }, 12_000)
})
