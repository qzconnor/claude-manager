import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { forceKill } from './process-end'

/** A slow shell setup (plugin managers, version managers) must not hold up the start for long. */
const TIMEOUT_MS = 10_000

/** Set by Electron or by the call itself, or describing the shell process rather than the user's environment. */
const SKIPPED = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'SHLVL', '_', 'PWD', 'OLDPWD'])

/**
 * Started from the application menu, the app only has the environment of the desktop session: what
 * the user sets up in ~/.bashrc, ~/.zshrc & co. is missing, e.g. a PATH with nvm, ~/.npm-global or
 * ~/.bun, where `claude` may be installed. Like VS Code, the app asks the user's login shell for its
 * environment once and takes it over. Started from a terminal, the environment is already complete.
 */
export async function loadShellEnv(): Promise<void> {
  if (process.platform === 'win32' || process.stdout.isTTY || process.env.CLAUDE_MANAGER_SKIP_SHELL_ENV) return
  try {
    const env = await readShellEnv()
    for (const [key, value] of Object.entries(env)) {
      if (!SKIPPED.has(key)) process.env[key] = value
    }
  } catch (error) {
    console.warn('[shell-env] the environment of the login shell could not be read', error)
  }
}

/** The environment of the login shell `shell`; it has `timeoutMs` to answer. */
export function readShellEnv(
  shell = process.env.SHELL || userInfo().shell || '/bin/sh',
  timeoutMs = TIMEOUT_MS,
): Promise<Record<string, string>> {
  const mark = randomUUID()
  // Electron prints the environment as JSON: values with line breaks survive, and output of the
  // shell's own startup files (greetings, prompts) is cut off by the marks.
  const script = `console.log(${JSON.stringify(mark)} + JSON.stringify(process.env) + ${JSON.stringify(mark)})`
  const command = `'${process.execPath.replaceAll("'", `'\\''`)}' -e '${script.replaceAll("'", `'\\''`)}'`
  return new Promise((resolve, reject) => {
    // -i and -l: interactive login shell, which reads the same files as one in a terminal window.
    // `detached`: the leader of a process group of its own, which goes as a whole on a timeout.
    const child = spawn(shell, ['-i', '-l', '-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    })
    let output = ''
    const timer = setTimeout(() => {
      // What the startup files started goes too (a plugin manager waiting for the network, the
      // program asked for the environment): left behind, it would hold on to the output.
      if (child.pid !== undefined) void forceKill(child.pid)
      child.stdout.destroy()
      reject(new Error(`${shell} did not answer within ${timeoutMs / 1000} s`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const start = output.indexOf(mark)
      const end = output.lastIndexOf(mark)
      if (start === -1 || end <= start) return reject(new Error(`${shell} exited with ${code} without an environment`))
      try {
        resolve(JSON.parse(output.slice(start + mark.length, end)) as Record<string, string>)
      } catch (error) {
        reject(error)
      }
    })
  })
}
