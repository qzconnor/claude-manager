import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeJsonAtomic, writeJsonAtomicSync } from './json-file'

/**
 * Changes to Claude Code's global config (`.claude.json`) while sessions run: under Claude Code's
 * own lock and on the current content, so running sessions lose nothing of theirs.
 */

/** Claude Code's config lock (proper-lockfile): its owner refreshes it every 5 s, older is stale. */
const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 5000
/** Claude Code writes its config readable for its user only. */
const CONFIG_MODE = 0o600

export interface GlobalConfig {
  [key: string]: unknown
}

/** Null when the file is missing; an unreadable file throws, so it is never overwritten. */
export async function readConfig(file: string): Promise<GlobalConfig | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parseConfig(file, text)
}

/** Blocking variant of `readConfig`, for when the app quits. */
export function readConfigSync(file: string): GlobalConfig | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parseConfig(file, text)
}

/** Writes the config as Claude Code does; only while holding its lock (`withConfigLock`). */
export function writeConfig(file: string, config: GlobalConfig): Promise<void> {
  return writeJsonAtomic(file, config, { mode: CONFIG_MODE })
}

export function writeConfigSync(file: string, config: GlobalConfig): void {
  writeJsonAtomicSync(file, config, { mode: CONFIG_MODE })
}

function parseConfig(file: string, text: string): GlobalConfig {
  const config: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file} ist kein JSON-Objekt.`)
  return config as GlobalConfig
}

/** Runs `task` while holding the lock folder Claude Code takes while it writes its config. */
export async function withConfigLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  await mkdir(dirname(file), { recursive: true })
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(lock).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error('Die Claude-Code-Konfiguration ist gerade gesperrt.')
      await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60))
    }
  }
  try {
    return await task()
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Blocking variant of `withConfigLock`, for when the app quits: it waits at most `timeoutMs` for the
 * lock, since the app is about to be gone.
 */
export function withConfigLockSync<T>(file: string, task: () => T, timeoutMs: number): T {
  const lock = `${file}.lock`
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(file), { recursive: true })
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let mtimeMs: number | null = null
      try {
        mtimeMs = statSync(lock).mtimeMs
      } catch {
        // Released in the meantime.
      }
      if (mtimeMs !== null && Date.now() - mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error('Die Claude-Code-Konfiguration ist gerade gesperrt.')
      sleepSync(20)
    }
  }
  try {
    return task()
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true })
    } catch {
      // Stale after LOCK_STALE_MS.
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
