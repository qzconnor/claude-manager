import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'

/** Environment variables a parent Claude Code session injects — never forwarded to child sessions. */
const PARENT_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]

/** Variables that make Claude Code bypass the account's own login. */
export const AUTH_OVERRIDE_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
]

export interface ResolvedCommand {
  file: string
  /** On Windows node-pty accepts a pre-built command line string. */
  args: string[] | string
  display: string
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Quotes one argument for a Windows command line (CommandLineToArgvW rules). */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      out += '\\'.repeat(backslashes) + ch
      backslashes = 0
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

export class ClaudeCli {
  private cachedPath: string | null | undefined
  private cachedVersion: { path: string; version: string | null } | null = null
  private cachedLoginEmail: { path: string; supported: boolean } | null = null

  constructor(private readonly getConfiguredPath: () => string) {}

  /** Clears the cached lookup (e.g. after the user changed the executable path). */
  invalidate(): void {
    this.cachedPath = undefined
    this.cachedVersion = null
    this.cachedLoginEmail = null
  }

  resolve(): string | null {
    const configured = this.getConfiguredPath().trim()
    if (configured) return isFile(configured) ? configured : null
    if (this.cachedPath !== undefined && (this.cachedPath === null || existsSync(this.cachedPath))) {
      return this.cachedPath
    }
    this.cachedPath = this.searchPath()
    return this.cachedPath
  }

  private searchPath(): string | null {
    const isWin = process.platform === 'win32'
    const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude']
    const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
    const home = homedir()
    // Common install locations, in case the app was started without the user's PATH.
    dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'))
    if (isWin && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
    if (!isWin) dirs.push('/usr/local/bin', '/opt/homebrew/bin')
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = join(dir, name)
        if (isFile(candidate)) return candidate
      }
    }
    return null
  }

  async version(): Promise<string | null> {
    const exe = this.resolve()
    if (!exe) return null
    if (this.cachedVersion?.path === exe) return this.cachedVersion.version
    const stdout = await this.run(['--version'])
    const match = stdout === null ? null : /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout)
    const version = match ? match[1] : stdout?.trim() || null
    this.cachedVersion = { path: exe, version }
    return version
  }

  /** Checks once per executable whether `claude auth login` can pre-fill the email (`--email`). */
  async checkLoginEmail(): Promise<boolean> {
    const exe = this.resolve()
    if (!exe) return false
    if (this.cachedLoginEmail?.path === exe) return this.cachedLoginEmail.supported
    const help = await this.run(['auth', 'login', '--help'])
    if (help === null) return false
    const supported = /--email\b/.test(help)
    this.cachedLoginEmail = { path: exe, supported }
    return supported
  }

  /** Result of {@link checkLoginEmail} for the current executable; `false` while it is unknown. */
  loginTakesEmail(): boolean {
    const exe = this.resolve()
    return !!exe && this.cachedLoginEmail?.path === exe && this.cachedLoginEmail.supported
  }

  /** Runs `claude` with the arguments and returns its output, `null` when it fails. */
  private run(claudeArgs: string[]): Promise<string | null> {
    const { file, args } = this.command(claudeArgs)
    return new Promise((resolve) => {
      execFile(
        file,
        typeof args === 'string' ? [args] : args,
        { timeout: 15000, windowsHide: true, windowsVerbatimArguments: typeof args === 'string', env: this.baseEnv() },
        (error, stdout) => resolve(error ? null : stdout),
      )
    })
  }

  /** Builds the command to start `claude` with the given arguments. */
  command(claudeArgs: string[]): ResolvedCommand {
    const exe = this.resolve()
    if (!exe) {
      throw new Error(
        'Claude Code wurde nicht gefunden. Installiere es oder trage den Pfad unter Einstellungen → Claude ein.',
      )
    }
    const ext = extname(exe).toLowerCase()
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      // Batch files must run through cmd.exe; /s keeps the quoting of the inner command intact.
      const inner = [exe, ...claudeArgs].map(quoteWindowsArg).join(' ')
      const comspec = process.env.ComSpec || 'cmd.exe'
      return { file: comspec, args: `/d /s /c "${inner}"`, display: inner }
    }
    return {
      file: exe,
      args: claudeArgs,
      display: [exe, ...claudeArgs].map(quoteWindowsArg).join(' '),
    }
  }

  /** The process environment without variables that would confuse a child Claude Code session. */
  baseEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (PARENT_SESSION_ENV.includes(key)) continue
      if (/^(ELECTRON_|VSCODE_|WT_)/.test(key)) continue
      if (key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') continue
      env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    return env
  }
}
