import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, join } from 'node:path'
import { withoutAppImageEnv } from '../lib/linux'

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

/**
 * Variables the Linux desktop sets for the app that was launched (Electron, GNOME): a browser
 * started from a terminal would think it belongs to Claude Manager.
 */
const LAUNCHED_APP_ENV = ['CHROME_DESKTOP', 'GIO_LAUNCHED_DESKTOP_FILE', 'GIO_LAUNCHED_DESKTOP_FILE_PID', 'BAMF_DESKTOP_FILE_HINT']

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

/** Claude Code wasn't found, or didn't answer: looked for (asked) again after this long. */
export const RETRY_MS = 15_000

/**
 * The executable as it is now: an update replaces the file (or the link points to another version),
 * so what was read from the old one no longer holds. Empty when it can't be read.
 */
export function fileStamp(path: string): string {
  try {
    const { mtimeMs, size } = statSync(path)
    return `${path}|${mtimeMs}|${size}`
  } catch {
    return ''
  }
}

/** Quotes one argument for a POSIX shell, for showing a command line. */
export function quotePosixArg(arg: string): string {
  return arg.length > 0 && /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/** A command line as the user would type it on this system. */
export function displayCommand(file: string, args: readonly string[]): string {
  const quote = process.platform === 'win32' ? quoteWindowsArg : quotePosixArg
  return [file, ...args].map(quote).join(' ')
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

/** Characters cmd.exe treats specially, escaped with `^` (as cross-spawn does). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * One argument for a batch file run through `cmd.exe /d /s /c "…"`: quoted for the program
 * (CommandLineToArgvW), then every character cmd.exe would act on (`& | < > ^ % "` …) escaped, so
 * nothing in it runs as a command or expands as a variable. Twice: cmd.exe reads the line once, and
 * the batch file once more where it passes its arguments on (`%*`).
 */
export function escapeCmdArg(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

/** The batch file's own path for the same command line. */
export function escapeCmdCommand(file: string): string {
  return file.replace(CMD_META, '^$1')
}

/**
 * What an npm shim (`claude.cmd` of `npm install -g`) starts: the package's script with node, or the
 * package's own executable. Started directly, without cmd.exe: arguments reach Claude Code as they
 * are, the terminal's process is Claude Code's (its pid names its session file), and folders on
 * network shares work, which cmd.exe refuses as working folder. Null for any other batch file.
 */
export function npmShimTarget(shim: string, content: string, findNode: () => string | null): { file: string; args: string[] } | null {
  // npm 7+: "%dp0%\node_modules\…\cli.js" %*  — older npm: "%~dp0\node_modules\…\cli.js" %*
  const match = /"%(?:~dp0|dp0%)\\([^"%]+?\.(?:c?js|mjs|exe))"\s*%\*/i.exec(content)
  if (!match) return null
  // The shim names it with backslashes; split up, it is the same path where the tests run on Linux too.
  const target = join(dirname(shim), ...match[1].split('\\'))
  if (!isFile(target)) return null
  if (/\.exe$/i.test(target)) return { file: target, args: [] }
  const local = join(dirname(shim), 'node.exe')
  const node = isFile(local) ? local : findNode()
  return node ? { file: node, args: [target] } : null
}

/** node.exe in the PATH, as the shim would find it. */
function nodeInPath(): string | null {
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'node.exe')
    if (isFile(candidate)) return candidate
  }
  return null
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export class ClaudeCli {
  /** Where `claude` was found, and when it was looked for: not found, it is looked for again later. */
  private cachedPath: { path: string | null; at: number } | undefined
  /** Keyed by `fileStamp`: after an update the new version is asked. A failed answer is asked again later. */
  private cachedVersion: { stamp: string; version: string | null; at: number } | null = null
  private cachedLoginEmail: { stamp: string; supported: boolean } | null = null

  constructor(
    private readonly getConfiguredPath: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Clears the cached lookup (e.g. after the user changed the executable path). */
  invalidate(): void {
    this.cachedPath = undefined
    this.cachedVersion = null
    this.cachedLoginEmail = null
  }

  resolve(): string | null {
    const configured = this.getConfiguredPath().trim()
    if (configured) return isFile(configured) ? configured : null
    const cached = this.cachedPath
    if (cached && (cached.path === null ? this.now() - cached.at < RETRY_MS : existsSync(cached.path))) return cached.path
    // Installed meanwhile, or moved: looked for anew.
    const path = this.searchPath()
    this.cachedPath = { path, at: this.now() }
    return path
  }

  private searchPath(): string | null {
    const isWin = process.platform === 'win32'
    const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude']
    const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
    const home = homedir()
    // Common install locations, in case the app was started without the user's PATH.
    dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'))
    if (isWin && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
    if (!isWin) {
      dirs.push(join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'))
      dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
    }
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
    const stamp = fileStamp(exe)
    const cached = this.cachedVersion
    if (cached?.stamp === stamp && (cached.version !== null || this.now() - cached.at < RETRY_MS)) return cached.version
    const stdout = await this.run(['--version'])
    const match = stdout === null ? null : /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout)
    const version = match ? match[1] : stdout?.trim() || null
    this.cachedVersion = { stamp, version, at: this.now() }
    return version
  }

  /** Result of {@link version} for the current executable; `null` while it is unknown. */
  knownVersion(): string | null {
    const exe = this.resolve()
    return exe && this.cachedVersion?.stamp === fileStamp(exe) ? this.cachedVersion.version : null
  }

  /** Checks once per executable whether `claude auth login` can pre-fill the email (`--email`). */
  async checkLoginEmail(): Promise<boolean> {
    const exe = this.resolve()
    if (!exe) return false
    const stamp = fileStamp(exe)
    if (this.cachedLoginEmail?.stamp === stamp) return this.cachedLoginEmail.supported
    const help = await this.run(['auth', 'login', '--help'])
    if (help === null) return false
    const supported = /--email\b/.test(help)
    this.cachedLoginEmail = { stamp, supported }
    return supported
  }

  /** Result of {@link checkLoginEmail} for the current executable; `false` while it is unknown. */
  loginTakesEmail(): boolean {
    const exe = this.resolve()
    return !!exe && this.cachedLoginEmail?.stamp === fileStamp(exe) && this.cachedLoginEmail.supported
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
      const display = displayCommand(exe, claudeArgs)
      const shim = npmShimTarget(exe, readText(exe), nodeInPath)
      if (shim) return { file: shim.file, args: [...shim.args, ...claudeArgs], display }
      // Other batch files must run through cmd.exe; /s keeps the escaped command line as it is.
      const inner = [escapeCmdCommand(exe), ...claudeArgs.map(escapeCmdArg)].join(' ')
      const comspec = process.env.ComSpec || 'cmd.exe'
      return { file: comspec, args: `/d /s /c "${inner}"`, display }
    }
    return { file: exe, args: claudeArgs, display: displayCommand(exe, claudeArgs) }
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
    if (process.platform === 'linux') {
      // Electron swaps the desktop's name for one its tray icon works with; programs in the terminals get the real one.
      if (env.ORIGINAL_XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP
      delete env.ORIGINAL_XDG_CURRENT_DESKTOP
      for (const key of LAUNCHED_APP_ENV) delete env[key]
      withoutAppImageEnv(env)
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    return env
  }
}
