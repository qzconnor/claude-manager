import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isHomeFolder, projectKey, trustFolder, trustTarget } from './workspace-trust'

const isWindows = process.platform === 'win32'

/** Trust is inherited up to the drive's root outside of a repository: only testable without a repository above the temp folder. */
function insideRepository(path: string): boolean {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true
    if (dirname(current) === current) return false
  }
}
const tmpInRepository = insideRepository(tmpdir())

let dir: string
let configFile: string
/** A repository with a subfolder. */
let repo: string
let src: string

const trusted = { hasTrustDialogAccepted: true }

async function writeConfig(projects: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(configFile, JSON.stringify({ numStartups: 7, ...extra, projects }))
}

async function readConfig(): Promise<{ projects: Record<string, Record<string, unknown>>; [key: string]: unknown }> {
  return JSON.parse(await readFile(configFile, 'utf8'))
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'cm-test-')))
  configFile = join(dir, 'config', '.claude.json')
  await mkdir(dirname(configFile))
  repo = join(dir, 'repo')
  src = join(repo, 'src')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(join(src, 'deep'), { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('projectKey', () => {
  it.runIf(isWindows)('uses forward slashes on Windows', () => {
    expect(projectKey('C:\\Users\\dev\\app')).toBe('C:/Users/dev/app')
    expect(projectKey('C:\\Users\\dev\\..\\shared\\app')).toBe('C:/Users/shared/app')
    expect(projectKey('d:/Work/App')).toBe('d:/Work/App')
  })

  it.skipIf(isWindows)('keeps a normalized POSIX path', () => {
    expect(projectKey('/home/dev/../shared//app')).toBe('/home/shared/app')
  })
})

describe('trustTarget', () => {
  it("keeps the trust on the repository's root", async () => {
    expect(await trustTarget(configFile, join(src, 'deep'))).toEqual({
      cwd: join(src, 'deep'),
      folder: repo,
      key: projectKey(repo),
      trusted: false,
    })
  })

  it('trusts every folder of a trusted repository', async () => {
    await writeConfig({ [projectKey(repo)]: { allowedTools: [], ...trusted } })
    expect((await trustTarget(configFile, join(src, 'deep'))).trusted).toBe(true)
    expect((await trustTarget(configFile, repo)).trusted).toBe(true)
  })

  it('trusts the folders below a trusted folder inside the repository', async () => {
    await writeConfig({ [projectKey(src)]: trusted })
    expect((await trustTarget(configFile, join(src, 'deep'))).trusted).toBe(true)
    expect((await trustTarget(configFile, src)).trusted).toBe(true)
    expect((await trustTarget(configFile, repo)).trusted).toBe(false)
  })

  it("doesn't take the trust of a folder above the repository", async () => {
    await writeConfig({ [projectKey(dir)]: trusted })
    expect((await trustTarget(configFile, src)).trusted).toBe(false)
  })

  it('needs the flag to be set', async () => {
    await writeConfig({ [projectKey(repo)]: { hasTrustDialogAccepted: false }, [projectKey(src)]: {} })
    expect((await trustTarget(configFile, src)).trusted).toBe(false)
  })

  it.skipIf(tmpInRepository)('takes the trust of any parent outside a repository', async () => {
    const plain = join(dir, 'plain', 'sub')
    await mkdir(plain, { recursive: true })
    expect(await trustTarget(configFile, plain)).toEqual({ cwd: plain, folder: plain, key: projectKey(plain), trusted: false })
    await writeConfig({ [projectKey(dir)]: trusted })
    expect((await trustTarget(configFile, plain)).trusted).toBe(true)
  })

  it('cleans the path as the process sees its working directory', async () => {
    const target = await trustTarget(configFile, `${join(src, 'deep', '..')}${sep}`)
    expect(target.cwd).toBe(src)
  })

  it("keeps the trust of a worktree on the main checkout", async () => {
    const worktree = join(dir, 'feature-wt')
    const gitDir = join(repo, '.git', 'worktrees', 'feature')
    await mkdir(gitDir, { recursive: true })
    await mkdir(join(worktree, 'lib'), { recursive: true })
    await writeFile(join(gitDir, 'commondir'), '../..\n')
    await writeFile(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`)
    await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`)

    const cwd = join(worktree, 'lib')
    expect(await trustTarget(configFile, cwd)).toEqual({ cwd, folder: repo, key: projectKey(repo), trusted: false })
    await writeConfig({ [projectKey(repo)]: trusted })
    expect((await trustTarget(configFile, cwd)).trusted).toBe(true)
  })

  it("keeps the trust of a bare repository's worktree on the repository's folder", async () => {
    const bare = join(dir, 'project.git')
    const worktree = join(dir, 'main-wt')
    const gitDir = join(bare, 'worktrees', 'main')
    await mkdir(gitDir, { recursive: true })
    await mkdir(worktree)
    await writeFile(join(gitDir, 'commondir'), '../..\n')
    await writeFile(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`)
    await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    expect(await trustTarget(configFile, worktree)).toMatchObject({ cwd: worktree, folder: bare, key: projectKey(bare) })
  })

  it("treats a pointer that doesn't lead to a worktree as its own root", async () => {
    // A submodule's pointer, and a worktree whose checkout was moved away.
    const submodule = join(repo, 'vendor', 'lib')
    await mkdir(join(repo, '.git', 'modules', 'lib'), { recursive: true })
    await mkdir(submodule, { recursive: true })
    await writeFile(join(submodule, '.git'), 'gitdir: ../../.git/modules/lib\n')
    expect(await trustTarget(configFile, submodule)).toMatchObject({ folder: submodule, key: projectKey(submodule) })

    const moved = join(dir, 'moved-wt')
    const gitDir = join(repo, '.git', 'worktrees', 'old')
    await mkdir(gitDir, { recursive: true })
    await mkdir(moved)
    await writeFile(join(gitDir, 'commondir'), '../..\n')
    await writeFile(join(gitDir, 'gitdir'), `${join(dir, 'old-place', '.git')}\n`)
    await writeFile(join(moved, '.git'), `gitdir: ${gitDir}\n`)
    expect(await trustTarget(configFile, moved)).toMatchObject({ folder: moved, key: projectKey(moved) })
  })

  it('reads a config with a byte order mark', async () => {
    await writeFile(configFile, `\uFEFF${JSON.stringify({ projects: { [projectKey(repo)]: trusted } })}`)
    expect((await trustTarget(configFile, src)).trusted).toBe(true)
  })

  it('throws for a config that is no JSON object', async () => {
    await writeFile(configFile, '[]')
    await expect(trustTarget(configFile, src)).rejects.toThrow('kein JSON-Objekt')
    await writeFile(configFile, '{"projects":')
    await expect(trustTarget(configFile, src)).rejects.toThrow(SyntaxError)
  })

  it.runIf(isWindows)('uses an entry spelled in another case, so Claude Code finds it', async () => {
    const key = projectKey(repo)
    const spelled = key === key.toLowerCase() ? key.toUpperCase() : key.toLowerCase()
    await writeConfig({ [spelled]: trusted })
    const respelled = spelled.replaceAll('/', '\\')
    expect(await trustTarget(configFile, join(src, 'deep'))).toEqual({
      cwd: `${respelled}\\src\\deep`,
      folder: respelled,
      key: spelled,
      trusted: true,
    })
  })

  it.runIf(isWindows)('no longer reads entries written with backslashes', async () => {
    await writeConfig({ [repo]: trusted })
    expect(await trustTarget(configFile, src)).toMatchObject({ key: projectKey(repo), trusted: false })
  })

  it.skipIf(isWindows)('tells folders apart by case on Linux', async () => {
    await writeConfig({ [projectKey(repo).toUpperCase()]: trusted })
    expect(await trustTarget(configFile, src)).toMatchObject({ cwd: src, key: projectKey(repo), trusted: false })
  })
})

describe('trustFolder', () => {
  it('creates the entry as Claude Code does and keeps everything else', async () => {
    await writeConfig({ '/other/project': { allowedTools: ['Read'] } }, { oauthAccount: { emailAddress: 'dev@example.com' } })
    await trustFolder(configFile, await trustTarget(configFile, src))
    const config = await readConfig()
    expect(config.numStartups).toBe(7)
    expect(config.oauthAccount).toEqual({ emailAddress: 'dev@example.com' })
    expect(config.projects['/other/project']).toEqual({ allowedTools: ['Read'] })
    expect(config.projects[projectKey(repo)]).toEqual({
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    })
    expect((await trustTarget(configFile, src)).trusted).toBe(true)
  })

  it('sets the flag on an existing entry', async () => {
    await writeConfig({ [projectKey(repo)]: { allowedTools: ['Bash(npm test)'], lastCost: 1.5 } })
    await trustFolder(configFile, await trustTarget(configFile, src))
    expect((await readConfig()).projects[projectKey(repo)]).toEqual({
      allowedTools: ['Bash(npm test)'],
      lastCost: 1.5,
      hasTrustDialogAccepted: true,
    })
  })

  it('leaves the file alone when the folder is trusted already', async () => {
    await writeConfig({ [projectKey(repo)]: trusted })
    const before = await readFile(configFile, 'utf8')
    await trustFolder(configFile, await trustTarget(configFile, src))
    expect(await readFile(configFile, 'utf8')).toBe(before)
  })

  it('creates a missing config', async () => {
    const missing = join(dir, 'new-home', '.claude.json')
    await trustFolder(missing, await trustTarget(missing, src))
    expect((await trustTarget(missing, src)).trusted).toBe(true)
  })

  it('never overwrites a config it cannot read', async () => {
    await writeFile(configFile, '{"projects": {')
    const target = { cwd: src, folder: repo, key: projectKey(repo), trusted: false }
    await expect(trustFolder(configFile, target)).rejects.toThrow(SyntaxError)
    expect(await readFile(configFile, 'utf8')).toBe('{"projects": {')
    expect(await readdir(dirname(configFile))).toEqual(['.claude.json'])
  })

  it.runIf(isWindows)('moves an entry written with backslashes to the new key', async () => {
    await writeConfig({ [repo]: { allowedTools: ['Read'], hasTrustDialogAccepted: false } })
    await trustFolder(configFile, await trustTarget(configFile, src))
    expect((await readConfig()).projects).toEqual({ [projectKey(repo)]: { allowedTools: ['Read'], hasTrustDialogAccepted: true } })
  })

  it("waits for Claude Code's lock and releases its own", async () => {
    const lock = `${configFile}.lock`
    await mkdir(lock)
    const target = await trustTarget(configFile, src)
    const done = trustFolder(configFile, target)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(existsSync(configFile)).toBe(false)
    await rm(lock, { recursive: true })
    await done
    expect((await trustTarget(configFile, src)).trusted).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('takes over a stale lock', async () => {
    const lock = `${configFile}.lock`
    await mkdir(lock)
    const old = new Date(Date.now() - 30_000)
    await utimes(lock, old, old)
    await trustFolder(configFile, await trustTarget(configFile, src))
    expect((await trustTarget(configFile, src)).trusted).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })
})

describe('isHomeFolder', () => {
  it('matches the home folder only', () => {
    const home = join(dir, 'home', 'dev')
    expect(isHomeFolder(home, home)).toBe(true)
    expect(isHomeFolder(home, `${home}${sep}`)).toBe(true)
    expect(isHomeFolder(join(home, 'project'), home)).toBe(false)
    expect(isHomeFolder(dirname(home), home)).toBe(false)
  })

  it.runIf(isWindows)('ignores case and slashes on Windows', () => {
    expect(isHomeFolder('c:/users/dev', 'C:\\Users\\Dev')).toBe(true)
  })

  it.skipIf(isWindows)('tells case apart on Linux', () => {
    expect(isHomeFolder('/home/Dev', '/home/dev')).toBe(false)
  })
})
