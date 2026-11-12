import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readShellEnv } from './shell-env'

/**
 * Whether the process still runs. A killed one may stay a zombie: in a container (as in the CI) the
 * first process often reaps nothing, and `kill(pid, 0)` still finds it. /proc tells its state.
 */
const alive = (pid: number) => {
  if (existsSync('/proc/self/stat')) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2)[0]
      return state !== 'Z' && state !== 'X'
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

// A login shell whose startup files hang: it and what it started go once it took too long.
describe.skipIf(process.platform === 'win32')('readShellEnv', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cm-shell-env-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('ends the shell with everything it started when it does not answer in time', async () => {
    const pidFile = join(dir, 'pid')
    const shell = join(dir, 'slow-shell')
    // Ignores what it is asked and waits, with a program of its own in the background.
    await writeFile(shell, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nsleep 30\n`)
    await chmod(shell, 0o755)
    await expect(readShellEnv(shell, 500)).rejects.toThrow(/did not answer/)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(pid).toBeGreaterThan(0)
    expect(await waitFor(() => !alive(pid))).toBe(true)
  })

  it('reads the environment of a shell that answers', async () => {
    const shell = join(dir, 'plain-shell')
    // Runs the command it is given, after a greeting the marks cut off.
    await writeFile(shell, `#!/bin/sh\necho hello\nshift 3 2>/dev/null\nexec /bin/sh -c "$@"\n`)
    await chmod(shell, 0o755)
    process.env.CM_SHELL_ENV_TEST = 'yes'
    try {
      const env = await readShellEnv(shell, 5000)
      expect(env.CM_SHELL_ENV_TEST).toBe('yes')
    } finally {
      delete process.env.CM_SHELL_ENV_TEST
    }
  })
})
