import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectKey } from '../lib/workspace-trust'
import type { AccountService } from './account-service'
import { WorkspaceTrust } from './workspace-trust'

/** Outside of a repository trust is inherited up to the drive's root: a repository above the temp folder hides it. */
function insideRepository(path: string): boolean {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true
    if (dirname(current) === current) return false
  }
}

describe.skipIf(insideRepository(tmpdir()))('WorkspaceTrust.grant', () => {
  let dir: string
  let configs: Record<string, string>
  let trust: WorkspaceTrust
  let asked: number

  const accounts = {
    list: () => Object.keys(configs).map((id) => ({ id })),
    paths: (id: string) => ({ globalConfigFile: configs[id] }),
  } as unknown as AccountService

  async function projects(id: string): Promise<Record<string, { hasTrustDialogAccepted?: boolean }>> {
    return JSON.parse(await readFile(configs[id]!, 'utf8')).projects ?? {}
  }

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'cm-grant-')))
    configs = { a: join(dir, 'a', '.claude.json'), b: join(dir, 'b', '.claude.json') }
    for (const file of Object.values(configs)) {
      await mkdir(dirname(file))
      await writeFile(file, JSON.stringify({ numStartups: 3, projects: {} }))
    }
    asked = 0
    trust = new WorkspaceTrust(accounts, async () => {
      asked++
      return false
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('trusts a folder the user made for every account, so no question comes up', async () => {
    const project = join(dir, 'Webseiten', 'websiteD')
    await mkdir(project, { recursive: true })
    await trust.grant(project)

    for (const id of ['a', 'b']) {
      expect((await projects(id))[projectKey(project)]?.hasTrustDialogAccepted).toBe(true)
      expect(JSON.parse(await readFile(configs[id]!, 'utf8')).numStartups).toBe(3)
    }
    expect(await trust.ensure('b', project)).toBe(project)
    expect(asked).toBe(0)
  })

  it('leaves a folder in a repository and one trusted already as they are', async () => {
    const repo = join(dir, 'repo')
    const inRepo = join(repo, 'neu')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(inRepo)
    await trust.grant(inRepo)
    expect(await projects('a')).toEqual({})

    const parent = join(dir, 'Kunden')
    await mkdir(join(parent, 'acme'), { recursive: true })
    await writeFile(configs.a!, JSON.stringify({ projects: { [projectKey(parent)]: { hasTrustDialogAccepted: true } } }))
    await trust.grant(join(parent, 'acme'))
    expect(Object.keys(await projects('a'))).toEqual([projectKey(parent)])
    expect(Object.keys(await projects('b'))).toEqual([projectKey(join(parent, 'acme'))])
  })
})
