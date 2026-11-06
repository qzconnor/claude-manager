import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Account, TerminalInfo } from '@shared/types'
import { findAccount, isLaunchRequest, parseLaunchArgs, readLaunchRequest, resolveLaunch, type LaunchRequest } from './launch'

const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER_SESSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const WORK = resolve('/work/project')
const OTHER = resolve('/work/other')

/** The switch cm.exe and the Linux script pass: working directory and arguments, NUL separated, Base64. */
function encode(...parts: string[]): string {
  return `--cm=${Buffer.from(parts.join('\0'), 'utf8').toString('base64')}`
}

function account(id: string, name: string, email: string | null = null): Account {
  return {
    id,
    name,
    kind: id === 'system' ? 'system' : 'oauth',
    color: '#d97757',
    configDir: `/config/${id}`,
    customConfigDir: false,
    defaultCwd: null,
    extraArgs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    hasSecret: false,
    secretHint: null,
    authState: 'ok',
    identity: {
      email,
      displayName: null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      subscriptionType: null,
      rateLimitTier: null,
    },
    tokenExpiresAt: null,
    expectedLogin: null,
  }
}

const ACCOUNTS = [
  account('system', 'Standard', 'me@example.com'),
  account('acc-work', 'Work', 'work@example.com'),
  account('acc-work2', 'Work Team'),
  account('acc-private', 'Privat', 'Private@Example.com'),
]

function terminal(overrides: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: 't',
    accountId: 'system',
    authAccountId: 'system',
    sessionId: null,
    limit: null,
    busy: false,
    attention: null,
    muted: false,
    title: 'Tab',
    fixedTitle: false,
    autoTitle: 'Tab',
    cwd: WORK,
    mode: 'session',
    url: null,
    resumeSessionId: null,
    status: 'running',
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-06T12:00:00.000Z',
    commandLine: 'claude',
    ...overrides,
  }
}

describe('readLaunchRequest', () => {
  it('decodes the working directory and the arguments', () => {
    expect(readLaunchRequest(['app.exe', '--flag', encode(WORK, '-a', 'Work Team', '--', '--model', 'opus')])).toEqual({
      cwd: WORK,
      args: ['-a', 'Work Team', '--', '--model', 'opus'],
    })
  })

  it('keeps non-ASCII characters and empty arguments', () => {
    expect(readLaunchRequest([encode('/home/jörg/プロジェクト', '', 'ä')])).toEqual({ cwd: '/home/jörg/プロジェクト', args: ['', 'ä'] })
  })

  it('returns no arguments when only the folder was passed', () => {
    expect(readLaunchRequest([encode(WORK)])).toEqual({ cwd: WORK, args: [] })
  })

  it('is null without the switch, with an empty one or without a folder', () => {
    expect(readLaunchRequest(['app.exe', '--cmx=abc'])).toBeNull()
    expect(readLaunchRequest(['--cm='])).toBeNull()
    expect(readLaunchRequest([encode('', '-c')])).toBeNull()
  })
})

describe('isLaunchRequest', () => {
  it('accepts the shape of a launch request only', () => {
    expect(isLaunchRequest({ cwd: WORK, args: [] })).toBe(true)
    expect(isLaunchRequest({ cwd: WORK, args: ['-c'], extra: 1 })).toBe(true)
    expect(isLaunchRequest(null)).toBe(false)
    expect(isLaunchRequest('cm')).toBe(false)
    expect(isLaunchRequest({ cwd: WORK })).toBe(false)
    expect(isLaunchRequest({ cwd: 5, args: [] })).toBe(false)
    expect(isLaunchRequest({ cwd: WORK, args: ['-a', 1] })).toBe(false)
    expect(isLaunchRequest({ cwd: WORK, args: '-c' })).toBe(false)
  })
})

describe('parseLaunchArgs', () => {
  it('has nothing set without arguments', () => {
    expect(parseLaunchArgs([])).toEqual({
      dir: null,
      account: null,
      continue: false,
      resume: null,
      shell: false,
      newTab: false,
      passthrough: [],
    })
  })

  it('reads the short and long options', () => {
    expect(parseLaunchArgs(['proj', '-a', 'Work', '-c', '-n'])).toMatchObject({ dir: 'proj', account: 'Work', continue: true, newTab: true })
    expect(parseLaunchArgs(['--account', 'Work', '--continue', '--new'])).toMatchObject({ account: 'Work', continue: true, newTab: true })
    expect(parseLaunchArgs(['-s'])).toMatchObject({ shell: true })
    expect(parseLaunchArgs(['--shell'])).toMatchObject({ shell: true })
  })

  it('reads values given with =', () => {
    expect(parseLaunchArgs(['--account=Work Team']).account).toBe('Work Team')
    expect(parseLaunchArgs(['-a=x=y']).account).toBe('x=y')
    expect(parseLaunchArgs([`--resume=${SESSION_ID}`]).resume).toBe(SESSION_ID)
  })

  it('takes a folder with = as a folder', () => {
    expect(parseLaunchArgs(['a=b']).dir).toBe('a=b')
  })

  it('refuses an account option without a name', () => {
    expect(() => parseLaunchArgs(['-a'])).toThrow('-a braucht einen Account-Namen')
    expect(() => parseLaunchArgs(['--account='])).toThrow('--account braucht einen Account-Namen')
  })

  it('takes the next argument after -r only when it is a session id', () => {
    expect(parseLaunchArgs(['-r'])).toMatchObject({ resume: true, dir: null })
    expect(parseLaunchArgs(['-r', SESSION_ID.toUpperCase()])).toMatchObject({ resume: SESSION_ID.toUpperCase(), dir: null })
    expect(parseLaunchArgs(['-r', 'proj'])).toMatchObject({ resume: true, dir: 'proj' })
  })

  it('refuses an invalid session id given with =', () => {
    expect(() => parseLaunchArgs(['--resume=latest'])).toThrow('keine gültige Session-ID')
    expect(() => parseLaunchArgs(['-r='])).toThrow('keine gültige Session-ID')
  })

  it('passes everything after -- on to claude, unparsed', () => {
    expect(parseLaunchArgs(['proj', '--', '--model', 'opus', '-c', '--'])).toMatchObject({
      dir: 'proj',
      continue: false,
      passthrough: ['--model', 'opus', '-c', '--'],
    })
  })

  it('refuses unknown options and points to --', () => {
    expect(() => parseLaunchArgs(['--model', 'opus'])).toThrow('Unbekannte Option „--model“')
    expect(() => parseLaunchArgs(['-x'])).toThrow('cm -- --model opus')
  })

  it('refuses a value on a switch instead of dropping it', () => {
    expect(() => parseLaunchArgs(['-c=foo'])).toThrow('-c nimmt keinen Wert („-c=foo“)')
    expect(() => parseLaunchArgs(['--continue='])).toThrow('--continue nimmt keinen Wert')
    expect(() => parseLaunchArgs(['-s=1'])).toThrow('-s nimmt keinen Wert')
    expect(() => parseLaunchArgs(['--new=yes'])).toThrow('--new nimmt keinen Wert')
  })

  it('refuses a second folder', () => {
    expect(() => parseLaunchArgs(['one', 'two'])).toThrow('Nur ein Ordner möglich')
  })

  it.each([
    [['-c', '-r']],
    [['-c', '-r', SESSION_ID]],
    [['-s', '-c']],
    [['-s', '-r']],
    [['-s', '--', '--model', 'opus']],
  ])('refuses the combination %o', (args) => {
    expect(() => parseLaunchArgs(args)).toThrow()
  })

  it('allows -s with -a, -n and a folder', () => {
    expect(parseLaunchArgs(['-s', '-a', 'Work', '-n', 'proj'])).toMatchObject({ shell: true, account: 'Work', newTab: true, dir: 'proj' })
  })
})

describe('findAccount', () => {
  it('finds an account by id, name or email, ignoring case and spaces', () => {
    expect(findAccount(ACCOUNTS, 'acc-work').id).toBe('acc-work')
    expect(findAccount(ACCOUNTS, 'work').id).toBe('acc-work')
    expect(findAccount(ACCOUNTS, '  WORK  ').id).toBe('acc-work')
    expect(findAccount(ACCOUNTS, 'private@example.COM').id).toBe('acc-private')
    expect(findAccount(ACCOUNTS, 'SYSTEM').id).toBe('system')
  })

  it('prefers an exact name over a partial one', () => {
    // "Work" is also part of "Work Team".
    expect(findAccount(ACCOUNTS, 'Work').id).toBe('acc-work')
  })

  it('finds a unique part of a name', () => {
    expect(findAccount(ACCOUNTS, 'team').id).toBe('acc-work2')
    expect(findAccount(ACCOUNTS, 'stand').id).toBe('system')
  })

  it('refuses a part of several names, naming them', () => {
    expect(() => findAccount(ACCOUNTS, 'wor')).toThrow('passt auf mehrere Accounts: Work, Work Team')
  })

  it('refuses an unknown account, listing the existing ones', () => {
    expect(() => findAccount(ACCOUNTS, 'nobody')).toThrow('Vorhanden: Standard, Work, Work Team, Privat')
  })
})

describe('resolveLaunch', () => {
  const launch = (args: string[], options: { defaultAccountId?: string; open?: TerminalInfo[]; cwd?: string } = {}) =>
    resolveLaunch({ cwd: options.cwd ?? WORK, args } satisfies LaunchRequest, ACCOUNTS, options.defaultAccountId ?? 'system', options.open)

  it('opens a session in the caller folder with the default account', () => {
    expect(launch([], { defaultAccountId: 'acc-work' })).toEqual({
      options: { accountId: 'acc-work', cwd: WORK, mode: 'session', resumeSessionId: null, args: [] },
      existing: null,
    })
  })

  it('falls back to the standard account when the default one is gone', () => {
    expect(launch([], { defaultAccountId: 'deleted' }).options.accountId).toBe('system')
  })

  it('refuses to start without any account', () => {
    expect(() => resolveLaunch({ cwd: WORK, args: [] }, [], 'system')).toThrow('Kein Account vorhanden')
  })

  it('uses the named account', () => {
    expect(launch(['-a', 'team']).options.accountId).toBe('acc-work2')
  })

  it('resolves the folder against the caller folder', () => {
    expect(launch(['sub']).options.cwd).toBe(resolve(WORK, 'sub'))
    expect(launch(['..']).options.cwd).toBe(resolve(WORK, '..'))
    expect(launch([OTHER]).options.cwd).toBe(OTHER)
  })

  it('expands ~ to the home folder', () => {
    expect(launch(['~']).options.cwd).toBe(join(homedir()))
    expect(launch(['~/code']).options.cwd).toBe(join(homedir(), 'code'))
  })

  it('turns the options into arguments for claude', () => {
    expect(launch(['-c', '--', '--model', 'opus']).options).toMatchObject({ args: ['--continue', '--model', 'opus'], resumeSessionId: null })
    expect(launch(['-r']).options).toMatchObject({ args: ['--resume'], resumeSessionId: null })
    expect(launch(['-r', SESSION_ID]).options).toMatchObject({ args: [], resumeSessionId: SESSION_ID })
    expect(launch(['-s']).options).toMatchObject({ mode: 'shell', args: [] })
  })

  describe('existing tabs', () => {
    const open = [
      terminal({ id: 'old', cwd: WORK }),
      terminal({ id: 'shell', cwd: WORK, mode: 'shell' }),
      terminal({ id: 'exited', cwd: WORK, status: 'exited' }),
      terminal({ id: 'work', cwd: WORK, accountId: 'acc-work', authAccountId: 'acc-work' }),
      terminal({ id: 'lent', cwd: WORK, accountId: 'system', authAccountId: 'acc-work2' }),
      terminal({ id: 'other', cwd: OTHER, sessionId: SESSION_ID }),
    ]

    it('selects the latest running session tab in the folder, of any account', () => {
      expect(launch([], { open })?.existing?.id).toBe('lent')
    })

    it('only selects a tab of the named account, also when it lends its login', () => {
      expect(launch(['-a', 'Work'], { open }).existing?.id).toBe('work')
      expect(launch(['-a', 'Team'], { open }).existing?.id).toBe('lent')
      expect(launch(['-a', 'Privat'], { open }).existing).toBeNull()
    })

    it('selects a shell tab for -s', () => {
      expect(launch(['-s'], { open }).existing?.id).toBe('shell')
    })

    it('selects the tab with the session to resume, wherever it is', () => {
      expect(launch(['-r', SESSION_ID], { open }).existing?.id).toBe('other')
      expect(launch(['-r', OTHER_SESSION_ID], { open }).existing).toBeNull()
    })

    it.each([[['-n']], [['-c']], [['-r']], [['--', '--model', 'opus']]])('opens a new tab for %o', (args) => {
      expect(launch(args, { open }).existing).toBeNull()
    })

    it('ignores exited tabs and tabs in other folders', () => {
      expect(launch([], { open: [open[2]] }).existing).toBeNull()
      expect(launch([], { open: [open[5]] }).existing).toBeNull()
    })

    it.runIf(process.platform === 'win32')('compares Windows paths regardless of case, slashes and a trailing backslash', () => {
      const tab = terminal({ id: 'win', cwd: 'C:\\Work\\Project\\' })
      expect(launch([], { cwd: 'c:/work/project', open: [tab] }).existing?.id).toBe('win')
    })

    it.skipIf(process.platform === 'win32')('compares other paths case-sensitively', () => {
      const tab = terminal({ id: 'posix', cwd: '/Work/Project/' })
      expect(launch([], { cwd: '/Work/Project', open: [tab] }).existing?.id).toBe('posix')
      expect(launch([], { cwd: '/work/project', open: [tab] }).existing).toBeNull()
    })
  })
})
