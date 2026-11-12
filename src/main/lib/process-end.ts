import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** How long a process may take to end after it was killed hard. */
export const FORCE_WAIT_MS = 3000

/** Resolves true once `exited` has resolved, false after `ms`. */
export async function settles(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const done = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ])
  clearTimeout(timer)
  return done
}

/**
 * Ends a process with everything it started, without giving it a chance to clean up: on Windows with
 * `taskkill /T /F` (by its full path, not whatever `taskkill` is first in PATH), elsewhere with
 * SIGKILL to its process group (a pty makes it the leader of its own) and to itself.
 */
export function forceKill(pid: number, platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    return new Promise((resolve) => {
      execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve())
    })
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // gone already, or not a group
    }
  }
  return Promise.resolve()
}

/**
 * Waits until a process asked to end (see `kill`) is gone: one that is still there after `timeoutMs`
 * is killed hard (`force`). Throws when even that doesn't end it, so nothing that must not run beside
 * it (a second process on the same session transcript) starts.
 */
export async function awaitEnd(
  exited: Promise<void>,
  force: () => Promise<void>,
  timeoutMs: number,
  forceWaitMs = FORCE_WAIT_MS,
): Promise<void> {
  if (await settles(exited, timeoutMs)) return
  await force()
  if (await settles(exited, forceWaitMs)) return
  throw new Error('Der Prozess lässt sich nicht beenden. Beende ihn selbst (z. B. im Task-Manager) und versuche es dann noch einmal.')
}
