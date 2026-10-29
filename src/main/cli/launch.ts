import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { Account, TerminalCreateOptions, TerminalInfo } from '@shared/types'

/**
 * The `cm` command (src/launcher/cm.cs) starts the app with `--cm=<Base64>`: the caller's
 * working directory and its arguments, separated by NUL characters.
 */
const SWITCH = '--cm='
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LaunchRequest {
  cwd: string
  args: string[]
}

export interface LaunchCommand {
  dir: string | null
  account: string | null
  continue: boolean
  /** A session id, or `true` for Claude Code's interactive picker. */
  resume: string | true | null
  shell: boolean
  /** Always open a new tab, even if one already shows the folder. */
  newTab: boolean
  passthrough: string[]
}

export interface LaunchPlan {
  options: TerminalCreateOptions
  /** A running tab that already shows what was asked for: it is selected instead. */
  existing: TerminalInfo | null
}

export function readLaunchRequest(argv: readonly string[]): LaunchRequest | null {
  const encoded = argv.find((arg) => arg.startsWith(SWITCH))?.slice(SWITCH.length)
  if (!encoded) return null
  const [cwd, ...args] = Buffer.from(encoded, 'base64').toString('utf8').split('\0')
  return cwd ? { cwd, args } : null
}

/** Checks data coming from another process (`second-instance`) before trusting its shape. */
export function isLaunchRequest(value: unknown): value is LaunchRequest {
  if (!value || typeof value !== 'object') return false
  const { cwd, args } = value as Record<string, unknown>
  return typeof cwd === 'string' && Array.isArray(args) && args.every((a) => typeof a === 'string')
}

export function parseLaunchArgs(args: readonly string[]): LaunchCommand {
  const command: LaunchCommand = {
    dir: null,
    account: null,
    continue: false,
    resume: null,
    shell: false,
    newTab: false,
    passthrough: [],
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      command.passthrough.push(...args.slice(i + 1))
      break
    }
    const [flag, inline] = arg.startsWith('-') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null]
    switch (flag) {
      case '-a':
      case '--account': {
        const value = inline ?? args[++i]
        if (!value) throw new Error(`${flag} braucht einen Account-Namen.`)
        command.account = value
        break
      }
      case '-c':
      case '--continue':
        command.continue = true
        break
      case '-r':
      case '--resume': {
        const value = inline ?? (args[i + 1] && SESSION_ID_RE.test(args[i + 1]) ? args[++i] : null)
        if (value !== null && !SESSION_ID_RE.test(value)) throw new Error(`„${value}“ ist keine gültige Session-ID.`)
        command.resume = value ?? true
        break
      }
      case '-s':
      case '--shell':
        command.shell = true
        break
      case '-n':
      case '--new':
        command.newTab = true
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unbekannte Option „${arg}“. Argumente für claude gehören hinter --, z. B. cm -- --model opus`)
        }
        if (command.dir !== null) throw new Error(`Nur ein Ordner möglich („${command.dir}“ und „${arg}“).`)
        command.dir = arg
    }
  }

  if (command.continue && command.resume) throw new Error('-c und -r lassen sich nicht kombinieren.')
  if (command.shell && (command.continue || command.resume || command.passthrough.length)) {
    throw new Error('-s startet eine Shell und lässt sich nicht mit -c, -r oder Claude-Argumenten kombinieren.')
  }
  return command
}

/** Account by id, name, e-mail or a unique part of the name (all case-insensitive). */
export function findAccount(accounts: readonly Account[], query: string): Account {
  const q = query.trim().toLowerCase()
  const exact = accounts.find(
    (a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q || a.identity.email?.toLowerCase() === q,
  )
  if (exact) return exact
  const partial = accounts.filter((a) => a.name.toLowerCase().includes(q))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new Error(`„${query}“ passt auf mehrere Accounts: ${partial.map((a) => a.name).join(', ')}.`)
  }
  throw new Error(`Kein Account „${query}“. Vorhanden: ${accounts.map((a) => a.name).join(', ')}.`)
}

/**
 * `openTerminals`: tabs that may be selected instead of opening a new one (see `findOpenTerminal`);
 * empty to always open one.
 */
export function resolveLaunch(
  request: LaunchRequest,
  accounts: readonly Account[],
  defaultAccountId: string,
  openTerminals: readonly TerminalInfo[] = [],
): LaunchPlan {
  const command = parseLaunchArgs(request.args)
  const account = command.account
    ? findAccount(accounts, command.account)
    : (accounts.find((a) => a.id === defaultAccountId) ?? accounts.find((a) => a.id === SYSTEM_ACCOUNT_ID))
  if (!account) throw new Error('Kein Account vorhanden.')

  let cwd = request.cwd
  if (command.dir) {
    const dir = command.dir === '~' || /^~[\\/]/.test(command.dir) ? join(homedir(), command.dir.slice(1)) : command.dir
    cwd = isAbsolute(dir) ? dir : resolve(request.cwd, dir)
  }

  const options: TerminalCreateOptions = {
    accountId: account.id,
    cwd,
    mode: command.shell ? 'shell' : 'session',
    resumeSessionId: typeof command.resume === 'string' ? command.resume : null,
    args: [
      ...(command.continue ? ['--continue'] : []),
      ...(command.resume === true ? ['--resume'] : []),
      ...command.passthrough,
    ],
  }
  return { options, existing: findOpenTerminal(command, account.id, cwd, openTerminals) }
}

/**
 * The running tab a call asks for: the one with the session to resume, otherwise the latest tab of
 * the same kind in the folder (of the account, if one was named). -n, -c, -r without a session id
 * and arguments for claude ask for something new.
 */
function findOpenTerminal(
  command: LaunchCommand,
  accountId: string,
  cwd: string,
  terminals: readonly TerminalInfo[],
): TerminalInfo | null {
  if (command.newTab || command.continue || command.resume === true || command.passthrough.length) return null
  const mode = command.shell ? 'shell' : 'session'
  const running = terminals.filter((t) => t.status === 'running' && t.mode === mode)
  if (typeof command.resume === 'string') return running.find((t) => t.sessionId === command.resume) ?? null
  return (
    running.findLast(
      (t) => samePath(t.cwd, cwd) && (!command.account || t.accountId === accountId || t.authAccountId === accountId),
    ) ?? null
  )
}

/** Windows paths are compared without regard to case, slash direction or a trailing backslash. */
function samePath(a: string, b: string): boolean {
  const normalize = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  return normalize(a) === normalize(b)
}
