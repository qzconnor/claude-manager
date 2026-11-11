import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderIdentity, WorkspaceService } from './workspace-service'

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

  it('refuses a bad name or a file in the way', async () => {
    writeFileSync(join(root, 'Datei'), '')
    await expect(service.create({ parent: root, name: 'Datei', prompt: '' })).rejects.toThrow(/ist eine Datei/)
    await expect(service.create({ parent: root, name: 'a/b', prompt: '' })).rejects.toThrow()
    expect(await service.list()).toEqual([])
  })

  it('uses folders that are there already, with what lies in them', async () => {
    const path = join(root, 'Da')
    mkdirSync(join(path, 'projekt'), { recursive: true })
    writeFileSync(join(path, 'cm_prompts.md'), 'Schon da.')
    const created = await service.create({ parent: root, name: 'Da', prompt: '' })
    expect(created).toMatchObject({ path, exists: true, projects: ['projekt'], hasPrompt: true })
    // Without a prompt of its own the one there stays.
    expect(readFileSync(join(path, 'cm_prompts.md'), 'utf8')).toBe('Schon da.')
    await service.create({ parent: root, name: 'Da', prompt: 'Neu.' })
    expect(readFileSync(join(path, 'cm_prompts.md'), 'utf8')).toBe('Neu.\n')
    expect(service.paths()).toEqual([path])

    // Missing folders on the way are made.
    const deep = await service.create({ parent: join(root, 'neu', 'tiefer'), name: 'Kunden', prompt: '' })
    expect(deep.path).toBe(join(root, 'neu', 'tiefer', 'Kunden'))
    expect(existsSync(join(deep.path, 'cm_prompts.md'))).toBe(true)
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
    // A nested workspace is no project of the outer one, and comes right after it.
    expect((await service.list())[0]?.projects).toEqual([])
    expect(service.paths().map((p) => basename(p))).toEqual(['Webseiten', 'Kunden', 'Ohne'])
    mkdirSync(join(outer, 'Shops'))
    await service.adopt(join(outer, 'Shops'), null)
    expect(service.paths().map((p) => basename(p))).toEqual(['Webseiten', 'Kunden', 'Shops', 'Ohne'])
  })

  it('writes prompts only of workspaces', async () => {
    await expect(service.writePrompt(root, 'x')).rejects.toThrow(/kein Workspace/)
    expect(existsSync(join(root, 'cm_prompts.md'))).toBe(false)
    // Read also before a folder becomes one, to show what is there.
    expect(await service.readPrompt(root)).toBe('')
  })

  describe('folderIdentity', () => {
    it('tells a new folder from a deleted one with the same number', () => {
      const old = folderIdentity({ dev: 1n, ino: 42n, birthtimeNs: 1000n }, 'linux')
      const reused = folderIdentity({ dev: 1n, ino: 42n, birthtimeNs: 2000n }, 'linux')
      expect(old).not.toBe(reused)
      expect(folderIdentity({ dev: 1n, ino: 42n, birthtimeNs: 1000n }, 'linux')).toBe(old)
    })

    it('takes no identity without the time a folder was made, outside Windows', () => {
      expect(folderIdentity({ dev: 1n, ino: 42n, birthtimeNs: 0n }, 'linux')).toBe('')
      expect(folderIdentity({ dev: 1n, ino: 0n, birthtimeNs: 1000n }, 'win32')).toBe('')
      expect(folderIdentity({ dev: 1n, ino: 42n, birthtimeNs: 0n }, 'win32')).not.toBe('')
    })
  })

  describe('moving folders', () => {
    let kunden: string
    let andere: string
    let follows: [string, string][]

    beforeEach(async () => {
      await service.create({ parent: root, name: 'Kunden', prompt: '' })
      await service.create({ parent: root, name: 'Andere', prompt: '' })
      kunden = join(root, 'Kunden')
      andere = join(root, 'Andere')
      mkdirSync(join(kunden, 'shop', 'src'), { recursive: true })
      follows = []
      service.follow(async (from, to) => {
        follows.push([from, to])
      })
      // Seen as they are now.
      await service.list()
    })

    it('moves a project into another workspace, with the workspaces in it', async () => {
      await service.adopt(join(kunden, 'shop'), null)
      const moved = await service.move(join(kunden, 'shop'), andere)

      expect(moved).toEqual({ path: join(andere, 'shop'), leftover: false })
      expect(existsSync(join(andere, 'shop', 'src'))).toBe(true)
      expect(service.paths()).toEqual([kunden, andere, join(andere, 'shop')])
      const listed = await service.list()
      expect(listed.map((w) => [w.name, w.projects])).toEqual([
        ['Kunden', []],
        ['Andere', []],
        ['shop', ['src']],
      ])
      // The app moved it itself: no move to follow.
      expect(follows).toEqual([])
    })

    it('refuses to move a folder into itself, onto another or where it is', async () => {
      await expect(service.move(join(kunden, 'shop'), join(kunden, 'shop', 'src'))).rejects.toThrow(/in sich selbst/)
      await expect(service.move(join(kunden, 'shop'), kunden)).rejects.toThrow(/liegt schon/)
      mkdirSync(join(andere, 'shop'))
      await expect(service.move(join(kunden, 'shop'), andere)).rejects.toThrow(/gibt es schon/)
      await expect(service.move(join(kunden, 'weg'), andere)).rejects.toThrow(/gibt es nicht/)
    })

    it('follows a folder moved outside the app, by its identity', async () => {
      renameSync(join(kunden, 'shop'), join(andere, 'laden'))
      // A new folder with its own identity is no move.
      mkdirSync(join(andere, 'neu'))
      await service.list()
      expect(follows).toEqual([[join(kunden, 'shop'), join(andere, 'laden')]])
      await service.list()
      expect(follows).toHaveLength(1)
    })

    it('keeps a moved workspace one, at its new place', async () => {
      await service.adopt(join(kunden, 'shop'), null)
      await service.list()
      renameSync(join(kunden, 'shop'), join(andere, 'shop'))
      await service.list()
      expect(follows).toEqual([[join(kunden, 'shop'), join(andere, 'shop')]])
      expect(service.paths()).toEqual([kunden, andere, join(andere, 'shop')])
    })

    it('follows a move made while the app was closed', async () => {
      service.dispose()
      renameSync(join(kunden, 'shop'), join(andere, 'shop'))
      const next = new WorkspaceService(data)
      next.init()
      const seen: [string, string][] = []
      next.follow(async (from, to) => {
        seen.push([from, to])
      })
      await next.list()
      next.dispose()
      expect(seen).toEqual([[join(kunden, 'shop'), join(andere, 'shop')]])
    })

    it('takes no folder of a workspace taken off the list for moved', async () => {
      await service.remove(kunden)
      await service.list()
      expect(follows).toEqual([])
    })
  })
})
