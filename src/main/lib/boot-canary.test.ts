import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withdrawBootEntries, withdrawBootEntriesSync, withoutBootEntries } from './boot-canary'

const host = hostname()
const started = 1_790_000_000_000
/** An entry as Claude Code writes it before its first frame. */
const entry = (startedAt = started + 800, extra: Record<string, unknown> = {}) => ({
  startedAt,
  version: '2.1.319',
  host,
  platform: 'windows',
  ...extra,
})

describe('withoutBootEntries', () => {
  it('takes out the entry of an ended launch and keeps the others', () => {
    const config = { numStartups: 3, fullscreenBootPending: { '100': entry(), '200': entry() } }
    expect(withoutBootEntries(config, [{ pid: 100, startedAt: started }])).toEqual({
      numStartups: 3,
      fullscreenBootPending: { '200': entry() },
    })
  })

  it('leaves the key out once nothing is pending, like Claude Code', () => {
    const config = { fullscreenBootPending: { '100': entry() }, fullscreenBootStrikes: { count: 1, version: '2.1.319' } }
    // Failed starts counted before stay counted.
    expect(withoutBootEntries(config, [{ pid: 100, startedAt: started }])).toEqual({
      fullscreenBootStrikes: { count: 1, version: '2.1.319' },
    })
  })

  it('keeps an entry with a render error: that start failed for real', () => {
    const config = { fullscreenBootPending: { '100': entry(started + 800, { died: 'render_error' }) } }
    expect(withoutBootEntries(config, [{ pid: 100, startedAt: started }])).toBeNull()
  })

  it('keeps the entry of an earlier process with the same pid', () => {
    const config = { fullscreenBootPending: { '100': entry(started - 60_000) } }
    expect(withoutBootEntries(config, [{ pid: 100, startedAt: started }])).toBeNull()
  })

  it("keeps another machine's entry (a shared home folder)", () => {
    const config = { fullscreenBootPending: { '100': entry(started + 800, { host: 'other-pc' }) } }
    expect(withoutBootEntries(config, [{ pid: 100, startedAt: started }], host)).toBeNull()
  })

  it('is null without entries', () => {
    expect(withoutBootEntries({ numStartups: 3 }, [{ pid: 100, startedAt: started }])).toBeNull()
    expect(withoutBootEntries({ fullscreenBootPending: [] }, [{ pid: 100, startedAt: started }])).toBeNull()
  })
})

describe('withdrawBootEntries', () => {
  let dir: string
  let configFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cm-canary-'))
    configFile = join(dir, '.claude.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const write = (config: unknown) => writeFile(configFile, JSON.stringify(config))
  const read = async () => JSON.parse(await readFile(configFile, 'utf8'))

  it('takes the entry out of the file and keeps everything else', async () => {
    await write({ oauthAccount: { emailAddress: 'a@b.c' }, projects: { x: {} }, fullscreenBootPending: { '100': entry() } })
    expect(await withdrawBootEntries(configFile, [{ pid: 100, startedAt: started }])).toBe(true)
    expect(await read()).toEqual({ oauthAccount: { emailAddress: 'a@b.c' }, projects: { x: {} } })
    expect(existsSync(`${configFile}.lock`)).toBe(false)
  })

  it("leaves the file alone when the session took its entry out itself", async () => {
    await write({ numStartups: 3 })
    const before = statSync(configFile).mtimeMs
    // Held by Claude Code: not needed, so not waited for.
    await mkdir(`${configFile}.lock`)
    expect(await withdrawBootEntries(configFile, [{ pid: 100, startedAt: started }])).toBe(false)
    expect(statSync(configFile).mtimeMs).toBe(before)
  })

  it('is false without a config file', async () => {
    expect(await withdrawBootEntries(configFile, [{ pid: 100, startedAt: started }])).toBe(false)
    expect(existsSync(configFile)).toBe(false)
  })

  it("waits for Claude Code's lock", async () => {
    await write({ fullscreenBootPending: { '100': entry() } })
    const lock = `${configFile}.lock`
    await mkdir(lock)
    const done = withdrawBootEntries(configFile, [{ pid: 100, startedAt: started }])
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await read()).fullscreenBootPending).toBeDefined()
    await rm(lock, { recursive: true })
    expect(await done).toBe(true)
    expect((await read()).fullscreenBootPending).toBeUndefined()
  })

  it('takes several entries out at once when the app quits', async () => {
    await write({ fullscreenBootPending: { '100': entry(), '200': entry(), '300': entry() } })
    const launches = [
      { pid: 100, startedAt: started },
      { pid: 300, startedAt: started },
    ]
    expect(withdrawBootEntriesSync(configFile, launches)).toBe(true)
    expect((await read()).fullscreenBootPending).toEqual({ '200': entry() })
    expect(existsSync(`${configFile}.lock`)).toBe(false)
  })

  it('gives up on a held lock when the app quits', async () => {
    await write({ fullscreenBootPending: { '100': entry() } })
    await mkdir(`${configFile}.lock`)
    expect(() => withdrawBootEntriesSync(configFile, [{ pid: 100, startedAt: started }])).toThrow()
    expect((await read()).fullscreenBootPending).toEqual({ '100': entry() })
  })
})
