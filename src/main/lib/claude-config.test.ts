import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readConfig, readConfigSync, withConfigLock, withConfigLockSync, writeConfig, writeConfigSync, type GlobalConfig } from './claude-config'

let dir: string
let configFile: string
let lock: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-config-'))
  configFile = join(dir, '.claude.json')
  lock = `${configFile}.lock`
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Makes a lock folder look as if its owner last touched it `ms` ago. */
async function touchedAgo(path: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms)
  await utimes(path, then, then)
}

describe.each([
  ['readConfig', (file: string) => readConfig(file)],
  ['readConfigSync', async (file: string) => readConfigSync(file)],
])('%s', (_name, read) => {
  it('is null when the file is missing', async () => {
    expect(await read(configFile)).toBeNull()
  })

  it('reads the config, also with a byte order mark', async () => {
    await writeFile(configFile, '{"numStartups": 3, "projects": {}}')
    expect(await read(configFile)).toEqual({ numStartups: 3, projects: {} })
    await writeFile(configFile, '﻿{"numStartups": 4}')
    expect(await read(configFile)).toEqual({ numStartups: 4 })
  })

  it('throws for a file that is not valid JSON, so it is never overwritten', async () => {
    await writeFile(configFile, '{"projects": {')
    await expect(read(configFile)).rejects.toThrow(SyntaxError)
    await writeFile(configFile, '')
    await expect(read(configFile)).rejects.toThrow(SyntaxError)
  })

  it.each(['[]', 'null', '42', '"text"'])('throws for JSON that is not an object: %s', async (content) => {
    await writeFile(configFile, content)
    await expect(read(configFile)).rejects.toThrow(configFile)
  })

  it('throws when the file is there but cannot be read', async () => {
    await mkdir(configFile)
    await expect(read(configFile)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe.each([
  ['writeConfig', (file: string, config: GlobalConfig) => writeConfig(file, config)],
  ['writeConfigSync', async (file: string, config: GlobalConfig) => writeConfigSync(file, config)],
])('%s', (_name, write) => {
  it('replaces the config with one that reads back, creating the folder', async () => {
    const file = join(dir, 'home', '.claude.json')
    await write(file, { numStartups: 1 })
    await write(file, { numStartups: 2, projects: { a: { allowedTools: [] } } })
    expect(await readConfig(file)).toEqual({ numStartups: 2, projects: { a: { allowedTools: [] } } })
  })

  it.skipIf(process.platform === 'win32')('writes it readable by its user only, like Claude Code', async () => {
    await writeFile(configFile, '{}', { mode: 0o644 })
    await write(configFile, { numStartups: 1 })
    expect(statSync(configFile).mode & 0o777).toBe(0o600)
  })
})

describe('withConfigLock', () => {
  it('holds the lock folder while the task runs, returns its result and releases it', async () => {
    const file = join(dir, 'home', '.claude.json')
    const held: boolean[] = []

    const result = await withConfigLock(file, async () => {
      held.push(existsSync(`${file}.lock`))
      return 'done'
    })

    expect(result).toBe('done')
    expect(held).toEqual([true])
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  it('releases the lock when the task fails and passes the error on', async () => {
    const failure = new Error('task failed')
    await expect(withConfigLock(configFile, () => Promise.reject(failure))).rejects.toBe(failure)
    expect(existsSync(lock)).toBe(false)

    // The next caller gets it at once.
    const started = Date.now()
    expect(await withConfigLock(configFile, async () => 'next')).toBe('next')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('runs tasks on the same config one after another, so no change gets lost', async () => {
    await writeConfig(configFile, { count: 0 })
    let running = 0
    let mostAtOnce = 0

    const increment = () =>
      withConfigLock(configFile, async () => {
        running++
        mostAtOnce = Math.max(mostAtOnce, running)
        const config = (await readConfig(configFile)) ?? {}
        await delay(20)
        await writeConfig(configFile, { ...config, count: (config.count as number) + 1 })
        running--
      })
    await Promise.all([increment(), increment(), increment(), increment(), increment()])

    expect(mostAtOnce).toBe(1)
    expect(await readConfig(configFile)).toEqual({ count: 5 })
    expect(existsSync(lock)).toBe(false)
  })

  it('locks each config file on its own', async () => {
    const other = join(dir, 'other', '.claude.json')
    let firstStarted: () => void = () => undefined
    let secondStarted: () => void = () => undefined
    const firstRunning = new Promise<void>((resolve) => (firstStarted = resolve))
    const secondRunning = new Promise<void>((resolve) => (secondStarted = resolve))

    // Each task waits until the other one runs too: with one lock for both files neither would end.
    await Promise.all([
      withConfigLock(configFile, async () => {
        firstStarted()
        await secondRunning
      }),
      withConfigLock(other, async () => {
        secondStarted()
        await firstRunning
      }),
    ])
  })

  it("waits for Claude Code's lock, also one touched seconds ago, and runs once it is released", async () => {
    await mkdir(lock)
    await touchedAgo(lock, 8000)
    const task = vi.fn(async () => existsSync(lock))

    const done = withConfigLock(configFile, task)
    await delay(200)
    expect(task).not.toHaveBeenCalled()

    await rm(lock, { recursive: true })
    expect(await done).toBe(true)
    expect(task).toHaveBeenCalledOnce()
    expect(existsSync(lock)).toBe(false)
  })

  it('takes over a lock nobody touched for over ten seconds', async () => {
    await mkdir(lock)
    await touchedAgo(lock, 11_000)
    const started = Date.now()

    expect(await withConfigLock(configFile, async () => 'ran')).toBe('ran')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(existsSync(lock)).toBe(false)
  })

  it('gives up after five seconds on a lock that is held, and leaves it alone', async () => {
    await mkdir(lock)
    const realNow = Date.now.bind(Date)
    let skipped = 0
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped)
    const task = vi.fn(async () => undefined)
    let settled = false

    const attempt = withConfigLock(configFile, task)
    void attempt.catch(() => undefined).finally(() => (settled = true))
    skipped = 4000
    await delay(200)
    expect(settled).toBe(false)

    skipped = 6000
    await expect(attempt).rejects.toThrow(Error)
    expect(task).not.toHaveBeenCalled()
    expect(existsSync(lock)).toBe(true)
  })
})

describe('withConfigLockSync', () => {
  it('holds the lock folder while the task runs, returns its result and releases it', () => {
    const file = join(dir, 'home', '.claude.json')
    expect(withConfigLockSync(file, () => existsSync(`${file}.lock`), 100)).toBe(true)
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  it('releases the lock when the task throws and passes the error on', () => {
    const failure = new Error('task failed')
    expect(() =>
      withConfigLockSync(
        configFile,
        () => {
          throw failure
        },
        100,
      ),
    ).toThrow(failure)
    expect(existsSync(lock)).toBe(false)
  })

  it('takes over a lock nobody touched for over ten seconds', async () => {
    await mkdir(lock)
    await touchedAgo(lock, 11_000)
    expect(withConfigLockSync(configFile, () => 'ran', 100)).toBe('ran')
    expect(existsSync(lock)).toBe(false)
  })

  it('gives up on a lock that is held once the given time is over, and leaves it alone', async () => {
    await mkdir(lock)
    const task = vi.fn(() => undefined)
    const started = Date.now()

    expect(() => withConfigLockSync(configFile, task, 150)).toThrow(Error)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(task).not.toHaveBeenCalled()
    expect(existsSync(lock)).toBe(true)
  })

  it('waits for a held lock until it turns stale, then takes it', async () => {
    await mkdir(lock)
    await touchedAgo(lock, 9700)
    const started = Date.now()

    expect(withConfigLockSync(configFile, () => 'ran', 3000)).toBe('ran')
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(existsSync(lock)).toBe(false)
  })
})
