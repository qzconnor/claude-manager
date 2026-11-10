import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceService } from './workspace-service'

describe('WorkspaceService', () => {
  let root: string
  let data: string
  let service: WorkspaceService

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workspaces-'))
    data = join(root, 'data')
    mkdirSync(data)
    service = new WorkspaceService(data)
    service.init()
  })

  afterEach(() => {
    service.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  it('makes a folder with its prompt and lists its subfolders as projects', async () => {
    const created = await service.create({ parent: root, name: 'Webseiten', prompt: 'Nur Open-Source-Bibliotheken.' })
    const path = join(root, 'Webseiten')
    expect(created).toMatchObject({ path, name: 'Webseiten', exists: true, projects: [], hasPrompt: true })
    expect(readFileSync(join(path, 'cm_prompts.md'), 'utf8')).toBe('Nur Open-Source-Bibliotheken.\n')

    for (const dir of ['websiteB', 'websiteA', '.git']) mkdirSync(join(path, dir))
    writeFileSync(join(path, 'notes.txt'), '')
    const [listed] = await service.list()
    expect(listed?.projects).toEqual(['websiteA', 'websiteB'])
  })

  it('writes an empty prompt file without a prompt', async () => {
    const created = await service.create({ parent: root, name: 'Leer', prompt: '  ' })
    expect(created.hasPrompt).toBe(false)
    expect(readFileSync(join(root, 'Leer', 'cm_prompts.md'), 'utf8')).toBe('')
  })

  it('refuses a folder that is there already, or a bad name', async () => {
    mkdirSync(join(root, 'Da'))
    await expect(service.create({ parent: root, name: 'Da', prompt: '' })).rejects.toThrow(/gibt es schon/)
    await expect(service.create({ parent: root, name: 'a/b', prompt: '' })).rejects.toThrow()
    expect(await service.list()).toEqual([])
  })

  it('makes an existing folder a workspace and keeps its prompt unless given one', async () => {
    const path = join(root, 'Kunden')
    mkdirSync(path)
    writeFileSync(join(path, 'cm_prompts.md'), 'Schon da.')
    await service.adopt(`${path}\\`, null)
    expect(service.paths()).toEqual([path])
    expect(readFileSync(join(path, 'cm_prompts.md'), 'utf8')).toBe('Schon da.')

    await service.adopt(path, 'Neu.')
    expect(service.paths()).toEqual([path])
    expect(await service.readPrompt(path)).toBe('Neu.\n')

    await expect(service.adopt(join(root, 'fehlt'), null)).rejects.toThrow(/gibt es nicht/)
  })

  it('remembers the workspaces and forgets one without touching its folder', async () => {
    await service.create({ parent: root, name: 'A', prompt: '' })
    await service.create({ parent: root, name: 'B', prompt: '' })
    // The list is written in the background.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const again = new WorkspaceService(data)
    again.init()
    expect(again.paths()).toEqual([join(root, 'A'), join(root, 'B')])

    await again.remove(join(root, 'A'))
    expect(again.paths()).toEqual([join(root, 'B')])
    expect(existsSync(join(root, 'A', 'cm_prompts.md'))).toBe(true)
    again.dispose()
  })

  it.runIf(process.platform === 'win32')('writes the drive of a workspace upper case, as Windows does', async () => {
    const path = join(root, 'Kunden')
    mkdirSync(path)
    await service.adopt(path.charAt(0).toLowerCase() + path.slice(1), null)
    expect(service.paths()).toEqual([path.charAt(0).toUpperCase() + path.slice(1)])
  })

  it('makes a project folder in a workspace, not elsewhere and not twice', async () => {
    const created = await service.create({ parent: root, name: 'Webseiten', prompt: '' })
    const path = await service.createProject(created.path, ' websiteD ')
    expect(path).toBe(join(created.path, 'websiteD'))
    expect(existsSync(path)).toBe(true)
    expect((await service.list())[0]?.projects).toEqual(['websiteD'])

    await expect(service.createProject(created.path, 'websiteD')).rejects.toThrow(/gibt es in „Webseiten“ schon/)
    await expect(service.createProject(created.path, '  ')).rejects.toThrow('Gib dem Projekt einen Namen.')
    await expect(service.createProject(created.path, 'a/b')).rejects.toThrow()
    await expect(service.createProject(root, 'x')).rejects.toThrow(/kein Workspace/)
    expect(existsSync(join(root, 'x'))).toBe(false)
  })

  it('keeps the order the workspaces were dragged into', async () => {
    for (const name of ['A', 'B', 'C']) await service.create({ parent: root, name, prompt: '' })
    let changes = 0
    service.on('changed', () => changes++)
    // Another spelling, a folder that is no workspace, one left out: C first, then A, B after them.
    await service.reorder([join(root, 'C') + sep, join(root, 'X'), join(root, 'A')])
    expect(service.paths()).toEqual([join(root, 'C'), join(root, 'A'), join(root, 'B')])
    expect(changes).toBe(1)
    await service.reorder(service.paths())
    expect(changes).toBe(1)

    const again = new WorkspaceService(data)
    again.init()
    expect(again.paths()).toEqual([join(root, 'C'), join(root, 'A'), join(root, 'B')])
    expect((await again.list()).map((w) => w.name)).toEqual(['C', 'A', 'B'])
    again.dispose()
  })

  it('gives a session the prompts of the workspaces its folder lies in, the outermost first', async () => {
    await service.create({ parent: root, name: 'Webseiten', prompt: 'Außen.' })
    const outer = join(root, 'Webseiten')
    mkdirSync(join(outer, 'Kunden'))
    await service.adopt(join(outer, 'Kunden'), 'Innen.')
    await service.create({ parent: root, name: 'Ohne', prompt: '' })

    expect(service.promptsFor(join(outer, 'Kunden', 'acme')).map((p) => [p.name, p.text])).toEqual([
      ['Webseiten', 'Außen.'],
      ['Kunden', 'Innen.'],
    ])
    expect(service.promptsFor(join(outer, 'websiteA')).map((p) => p.name)).toEqual(['Webseiten'])
    expect(service.promptsFor(join(root, 'Ohne'))).toEqual([])
    expect(service.promptsFor(root)).toEqual([])
    // A nested workspace is no project of the outer one.
    expect((await service.list())[0]?.projects).toEqual([])
  })

  it('writes prompts only of workspaces', async () => {
    await expect(service.writePrompt(root, 'x')).rejects.toThrow(/kein Workspace/)
    expect(existsSync(join(root, 'cm_prompts.md'))).toBe(false)
    // Read also before a folder becomes one, to show what is there.
    expect(await service.readPrompt(root)).toBe('')
  })
})
