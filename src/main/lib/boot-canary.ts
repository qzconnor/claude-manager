import { hostname } from 'node:os'
import {
  readConfig,
  readConfigSync,
  withConfigLock,
  withConfigLockSync,
  writeConfig,
  writeConfigSync,
  type GlobalConfig,
} from './claude-config'

/**
 * Claude Code's guard against a fullscreen renderer that doesn't start, mirrored from 2.1.319:
 * - Before its first frame, a fullscreen launch writes `fullscreenBootPending[<pid>]` (startedAt,
 *   version, host, platform) to the global config. 10 s after the first frame, or when it ends
 *   normally, it takes the entry out again; a render error stays in the entry as `died`.
 * - A launch that finds the entry of a process that is gone counts a failed start: it says so and
 *   runs with the classic renderer. After two, fullscreen stays off on the machine until an update.
 *
 * The app ends sessions hard (node-pty terminates the process), so a session closed in its first
 * seconds leaves its entry behind and costs the next one its renderer. The app takes the entry out as
 * Claude Code does when it ends normally: the entry goes, failed starts counted before stay.
 */

/** A session the app ended: its process and when the app started it (ms). */
export interface EndedLaunch {
  pid: number
  startedAt: number
}

/** Claude Code writes its entry after the app started the process; the clocks are the same. */
const START_SLACK_MS = 5000
/** When the app quits, it waits no longer for Claude Code's lock. */
const QUIT_LOCK_TIMEOUT_MS = 1000

interface BootEntry {
  startedAt?: unknown
  host?: unknown
  died?: unknown
}

/**
 * The config without the entries of these launches, or null when it has none of them. An entry with
 * a render error (`died`) stays: that start failed for real.
 */
export function withoutBootEntries(config: GlobalConfig, launches: readonly EndedLaunch[], host = hostname()): GlobalConfig | null {
  const pending = config.fullscreenBootPending
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return null
  const rest = { ...(pending as Record<string, BootEntry | undefined>) }
  let removed = false
  for (const launch of launches) {
    const key = String(launch.pid)
    const entry = rest[key]
    if (!entry || typeof entry !== 'object' || entry.died !== undefined) continue
    if (typeof entry.startedAt !== 'number' || entry.startedAt < launch.startedAt - START_SLACK_MS) continue
    if (typeof entry.host === 'string' && entry.host !== host) continue
    delete rest[key]
    removed = true
  }
  if (!removed) return null
  // Claude Code leaves the key out once no launch is pending.
  const { fullscreenBootPending: _, ...others } = config
  return Object.keys(rest).length > 0 ? { ...others, fullscreenBootPending: rest } : others
}

/** Takes the entries of these launches out of the config file; true when there were any. */
export async function withdrawBootEntries(configFile: string, launches: readonly EndedLaunch[]): Promise<boolean> {
  // Most sessions took their entry out themselves: only then is the lock taken.
  const config = await readConfig(configFile)
  if (!config || !withoutBootEntries(config, launches)) return false
  return withConfigLock(configFile, async () => {
    const current = await readConfig(configFile)
    const next = current && withoutBootEntries(current, launches)
    if (!next) return false
    await writeConfig(configFile, next)
    return true
  })
}

/** Blocking variant of `withdrawBootEntries`, for when the app quits before the processes have ended. */
export function withdrawBootEntriesSync(configFile: string, launches: readonly EndedLaunch[]): boolean {
  const config = readConfigSync(configFile)
  if (!config || !withoutBootEntries(config, launches)) return false
  return withConfigLockSync(
    configFile,
    () => {
      const current = readConfigSync(configFile)
      const next = current && withoutBootEntries(current, launches)
      if (!next) return false
      writeConfigSync(configFile, next)
      return true
    },
    QUIT_LOCK_TIMEOUT_MS,
  )
}
