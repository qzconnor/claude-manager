import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AccountKind, SessionGroup, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { claudePaths } from '../lib/claude-paths'
import { projectKey } from '../lib/session-files'
import { moveSession } from '../lib/session-move'
import type { AccountService } from './account-service'
import { SessionHandoff } from './session-handoff'
import type { SessionService } from './session-service'
import type { SettingsService } from './settings-service'
import type { TerminalService } from './terminal-service'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'

const KINDS: Record<string, AccountKind> = { own: 'oauth', other: 'oauth', token: 'token', key: 'apiKey' }

let dir: string
let cwd: string
let tabs: Map<string, TerminalInfo>
let groups: SessionGroup[]
let continuePrompt: string
/** The order in which the tab was stopped, replaced and closed. */
let steps: string[]

const paths = (id: string) => claudePaths(join(dir, id), true)

const accounts = {
  get: (id: string) => {
    if (!KINDS[id]) throw new Error(`no account ${id}`)
    return { id, name: `Name ${id}`, kind: KINDS[id] } as Account
  },
  paths,
} as unknown as AccountService

const sessionFns = {
  list: async () => groups,
  move: vi.fn(async (accountId: string, sessionId: string, to: string) => {
    steps.push('move')
    if (!(await moveSession(paths(accountId).projectsDir, { id: sessionId, cwd, filePath: transcriptOf(accountId) }, to))) {
      throw new Error('Kopie')
    }
  }),
}
const sessions = sessionFns as unknown as SessionService

const settings = { get: () => ({ claude: { continuePrompt } }) } as unknown as SettingsService

const terminalFns = {
  get: (id: string) => {
    const tab = tabs.get(id)
    if (!tab) throw new Error(`no terminal ${id}`)
    return tab
  },
  trustedCwd: vi.fn(async (_accountId: string, folder: string | null): Promise<string | null> => folder),
  stop: vi.fn(async (id: string) => {
    steps.push(`stop ${id}`)
  }),
  create: vi.fn((options: TerminalCreateOptions): TerminalInfo => {
    steps.push('create')
    return tab({ id: 'new', accountId: options.accountId })
  }),
  close: vi.fn((id: string) => {
    steps.push(`close ${id}`)
  }),
  open: vi.fn(async (options: TerminalCreateOptions): Promise<TerminalInfo | null> => tab({ id: 'opened', accountId: options.accountId })),
}
const terminals = terminalFns as unknown as TerminalService

function tab(overrides: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: 'old',
    accountId: 'own',
    authAccountId: 'own',
    sessionId: S,
    limit: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: 'Tab',
    fixedTitle: false,
    autoTitle: 'Tab',
    cwd,
    mode: 'session',
    url: null,
    resumeSessionId: null,
    status: 'running',
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-06T12:00:00.000Z',
    commandLine: 'claude',
    worktree: null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
    ...overrides,
  }
}

function transcriptOf(accountId: string): string {
  return join(paths(accountId).projectsDir, projectKey(cwd), `${S}.jsonl`)
}

async function writeTranscript(accountId = 'own', content = '{"type":"user"}\n'): Promise<string> {
  const file = transcriptOf(accountId)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, content)
  return file
}

function handoff(): SessionHandoff {
  return new SessionHandoff(accounts, sessions, terminals, settings)
}

function createdOptions(): TerminalCreateOptions {
  expect(terminalFns.create).toHaveBeenCalledOnce()
  return terminalFns.create.mock.calls[0][0]
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  cwd = join(dir, 'work', 'project')
  tabs = new Map([['old', tab({})]])
  groups = []
  continuePrompt = 'Mach weiter'
  steps = []
  vi.clearAllMocks()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('SessionHandoff.continueTerminal', () => {
  it('lends a token to the session where it lies', async () => {
    await writeTranscript()
    const result = await handoff().continueTerminal('old', 'token')
    expect(result?.id).toBe('new')
    expect(terminalFns.trustedCwd).toHaveBeenCalledWith('own', cwd)
    expect(createdOptions()).toEqual({ accountId: 'own', authAccountId: 'token', cwd, resumeSessionId: S, title: null, muted: false, replaces: 'old' })
    expect(steps).toEqual(['stop old', 'create', 'close old'])
    expect(existsSync(transcriptOf('token'))).toBe(false)
  })

  it('goes on in the folder /cd moved the session to, also when the tab missed it', async () => {
    const moved = join(dir, 'work', 'site')
    await mkdir(join(paths('own').projectsDir, projectKey(cwd)), { recursive: true })
    const folder = join(paths('own').projectsDir, projectKey(moved))
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${S}.jsonl`), `{"type":"user"}\n${JSON.stringify({ type: 'relocated', sessionId: S, relocatedCwd: moved })}\n`)
    await handoff().continueTerminal('old', 'other')
    expect(terminalFns.trustedCwd).toHaveBeenCalledWith('other', moved)
    expect(createdOptions()).toMatchObject({ accountId: 'other', cwd: moved, resumeSessionId: S })
    expect(existsSync(join(paths('other').projectsDir, projectKey(moved), `${S}.jsonl`))).toBe(true)
  })

  it('tells that the new tab replaces the old one before the old one closes', async () => {
    await writeTranscript()
    const service = handoff()
    service.on('replaced', (oldId, info) => steps.push(`replaced ${oldId} by ${info.id}`))
    await service.continueTerminal('old', 'token')
    expect(steps).toEqual(['stop old', 'create', 'replaced old by new', 'close old'])
  })

  it('copies the session into the folder of another browser login', async () => {
    const transcript = await writeTranscript()
    await mkdir(join(transcript, '..', S, 'subagents'), { recursive: true })
    await writeFile(join(transcript, '..', S, 'subagents', 'agent-1.jsonl'), 'sub\n')

    await handoff().continueTerminal('old', 'other')
    expect(terminalFns.trustedCwd).toHaveBeenCalledWith('other', cwd)
    expect(createdOptions()).toEqual({ accountId: 'other', cwd, resumeSessionId: S, title: null, muted: false, replaces: 'old' })
    expect(await readFile(transcriptOf('other'), 'utf8')).toBe('{"type":"user"}\n')
    expect(await readFile(join(transcriptOf('other'), '..', S, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('sub\n')
    expect(steps).toEqual(['stop old', 'create', 'close old'])
  })

  it('goes back to the own login of a lent tab without copying', async () => {
    tabs.set('old', tab({ authAccountId: 'token' }))
    await writeTranscript()
    await handoff().continueTerminal('old', 'own')
    expect(createdOptions()).toEqual({ accountId: 'own', cwd, resumeSessionId: S, title: null, muted: false, replaces: 'old' })
  })

  it('starts a new session when nothing was written yet', async () => {
    await handoff().continueTerminal('old', 'key')
    expect(createdOptions()).toEqual({ accountId: 'own', authAccountId: 'key', cwd, title: null, muted: false, replaces: 'old' })

    vi.clearAllMocks()
    await handoff().continueTerminal('old', 'other')
    expect(createdOptions()).toEqual({ accountId: 'other', cwd, title: null, muted: false, replaces: 'old' })
  })

  it('keeps a chosen title and the muting', async () => {
    tabs.set('old', tab({ title: 'Refactoring', fixedTitle: true, muted: true }))
    await writeTranscript()
    await handoff().continueTerminal('old', 'token')
    expect(createdOptions()).toMatchObject({ title: 'Refactoring', muted: true })
  })

  it('lets Claude carry on after a limit', async () => {
    tabs.set('old', tab({ limit: { type: 'five_hour', resetsAt: null, message: 'limit' } }))
    await writeTranscript()
    await handoff().continueTerminal('old', 'token')
    expect(createdOptions().prompt).toBe('Mach weiter')
  })

  it('sends no prompt after a limit when the prompt is empty or nothing was written', async () => {
    tabs.set('old', tab({ limit: { type: 'five_hour', resetsAt: null, message: 'limit' } }))
    continuePrompt = ''
    await writeTranscript()
    await handoff().continueTerminal('old', 'token')
    expect(createdOptions().prompt).toBeNull()

    vi.clearAllMocks()
    continuePrompt = 'Weiter'
    await rm(transcriptOf('own'))
    await handoff().continueTerminal('old', 'token')
    expect(createdOptions()).not.toHaveProperty('prompt')
  })

  it('sends no prompt without a limit', async () => {
    await writeTranscript()
    await handoff().continueTerminal('old', 'token')
    expect(createdOptions()).not.toHaveProperty('prompt')
  })

  it('takes the folder the trust check returns', async () => {
    const trusted = join(dir, 'trusted')
    terminalFns.trustedCwd.mockResolvedValueOnce(trusted)
    await handoff().continueTerminal('old', 'token')
    expect(createdOptions().cwd).toBe(trusted)
  })

  it('keeps the tab running when the folder is not trusted', async () => {
    await writeTranscript()
    terminalFns.trustedCwd.mockResolvedValueOnce(null)
    expect(await handoff().continueTerminal('old', 'other')).toBeNull()
    expect(steps).toEqual([])
    expect(existsSync(transcriptOf('other'))).toBe(false)
  })

  it('keeps the tab running when the target has a newer copy of the session', async () => {
    const source = await writeTranscript()
    const old = new Date('2026-01-01T00:00:00Z')
    await utimes(source, old, old)
    await writeTranscript('other', 'newer\n')
    await expect(handoff().continueTerminal('old', 'other')).rejects.toThrow('neuerer Stand')
    expect(steps).toEqual([])
    expect(terminalFns.trustedCwd).not.toHaveBeenCalled()
    expect(await readFile(transcriptOf('other'), 'utf8')).toBe('newer\n')
  })

  it('replaces an older copy at the target', async () => {
    await writeTranscript('other', 'older\n')
    const old = new Date('2026-01-01T00:00:00Z')
    await utimes(transcriptOf('other'), old, old)
    await writeTranscript()
    await handoff().continueTerminal('old', 'other')
    expect(await readFile(transcriptOf('other'), 'utf8')).toBe('{"type":"user"}\n')
  })

  it('restarts an exited tab with the same account', async () => {
    tabs.set('old', tab({ status: 'exited' }))
    await writeTranscript()
    await handoff().continueTerminal('old', 'own')
    expect(createdOptions()).toEqual({ accountId: 'own', cwd, resumeSessionId: S, title: null, muted: false, replaces: 'old' })
  })

  it.each([
    ['a shell tab', { mode: 'shell' as const }, 'Nur Claude-Code-Sessions'],
    ['a login tab', { mode: 'login' as const }, 'Nur Claude-Code-Sessions'],
    ['a tab without a known session', { sessionId: null }, 'noch nicht bekannt'],
  ])('refuses %s', async (_name, overrides, message) => {
    tabs.set('old', tab(overrides))
    await expect(handoff().continueTerminal('old', 'token')).rejects.toThrow(message)
    expect(steps).toEqual([])
  })

  it('refuses the account the running tab already uses', async () => {
    tabs.set('old', tab({ authAccountId: 'token' }))
    await expect(handoff().continueTerminal('old', 'token')).rejects.toThrow('läuft schon über „Name token“')
  })

  it('refuses a second switch of the same tab while one is running', async () => {
    await writeTranscript()
    const service = handoff()
    const first = service.continueTerminal('old', 'token')
    await expect(service.continueTerminal('old', 'key')).rejects.toThrow('Der Wechsel läuft bereits.')
    await first
    expect(terminalFns.create).toHaveBeenCalledOnce()
  })

  it('allows a new switch after one failed', async () => {
    const service = handoff()
    terminalFns.trustedCwd.mockRejectedValueOnce(new Error('dialog failed'))
    await expect(service.continueTerminal('old', 'token')).rejects.toThrow('dialog failed')
    await service.continueTerminal('old', 'token')
    expect(terminalFns.create).toHaveBeenCalledOnce()
  })
})

describe('SessionHandoff.restartTerminal', () => {
  it('goes on with the conversation in the same place and account', async () => {
    await writeTranscript()
    const service = handoff()
    service.on('replaced', (oldId, info) => steps.push(`replaced ${oldId} by ${info.id}`))
    const result = await service.restartTerminal('old')
    expect(result?.id).toBe('new')
    expect(createdOptions()).toEqual({ accountId: 'own', cwd, resumeSessionId: S, title: null, muted: false, replaces: 'old' })
    expect(steps).toEqual(['stop old', 'create', 'replaced old by new', 'close old'])
  })

  it('keeps a lent login', async () => {
    tabs.set('old', tab({ authAccountId: 'token' }))
    await writeTranscript()
    await handoff().restartTerminal('old')
    expect(createdOptions()).toEqual({ accountId: 'own', authAccountId: 'token', cwd, resumeSessionId: S, title: null, muted: false, replaces: 'old' })
  })

  it('sends no continue prompt, even at a limit', async () => {
    tabs.set('old', tab({ limit: { type: 'five_hour', resetsAt: null, message: 'limit' } }))
    await writeTranscript()
    await handoff().restartTerminal('old')
    expect(createdOptions().prompt).toBeUndefined()
  })

  it('goes on with the session the tab has now, not the one it was started with', async () => {
    tabs.set('old', tab({ resumeSessionId: 'aaaaaaaa-0000-4000-8000-000000000000' }))
    await writeTranscript()
    await handoff().restartTerminal('old')
    expect(createdOptions().resumeSessionId).toBe(S)
  })

  it('starts a shell again after its process has ended', async () => {
    tabs.set('old', tab({ mode: 'shell', sessionId: null, title: 'Mein Shell', fixedTitle: true }))
    const result = await handoff().restartTerminal('old')
    expect(result?.id).toBe('new')
    expect(createdOptions()).toEqual({
      accountId: 'own',
      authAccountId: undefined,
      cwd,
      mode: 'shell',
      resumeSessionId: undefined,
      title: 'Mein Shell',
      muted: false,
      replaces: 'old',
    })
    expect(steps).toEqual(['stop old', 'create', 'close old'])
    expect(terminalFns.trustedCwd).not.toHaveBeenCalled()
  })

  it('starts a session whose id is not known yet as it was started, in a trusted folder only', async () => {
    tabs.set('old', tab({ sessionId: null, resumeSessionId: S }))
    terminalFns.trustedCwd.mockResolvedValueOnce(null)
    expect(await handoff().restartTerminal('old')).toBeNull()
    expect(terminalFns.stop).not.toHaveBeenCalled()
    await handoff().restartTerminal('old')
    expect(createdOptions()).toMatchObject({ mode: 'session', resumeSessionId: S, replaces: 'old' })
  })

  it('does not restart a browser', async () => {
    tabs.set('old', tab({ mode: 'browser' }))
    await expect(handoff().restartTerminal('old')).rejects.toThrow()
    expect(terminalFns.stop).not.toHaveBeenCalled()
  })
})

describe('SessionHandoff.moveTerminal', () => {
  const target = () => join(dir, 'work', 'other')

  it('ends the session, moves it and goes on with it in the new folder', async () => {
    await writeTranscript()
    const service = handoff()
    service.on('replaced', (oldId, info) => steps.push(`replaced ${oldId} by ${info.id}`))
    expect((await service.moveTerminal('old', target()))?.id).toBe('new')
    expect(terminalFns.trustedCwd).toHaveBeenCalledWith('own', target())
    expect(sessionFns.move).toHaveBeenCalledWith('own', S, target())
    expect(createdOptions()).toEqual({ accountId: 'own', cwd: target(), resumeSessionId: S, title: null, muted: false, replaces: 'old' })
    expect(steps).toEqual(['stop old', 'move', 'create', 'replaced old by new', 'close old'])
    expect(existsSync(join(paths('own').projectsDir, projectKey(target()), `${S}.jsonl`))).toBe(true)
  })

  it('keeps a lent login', async () => {
    tabs.set('old', tab({ authAccountId: 'token' }))
    await writeTranscript()
    await handoff().moveTerminal('old', target())
    expect(createdOptions()).toEqual({ accountId: 'own', authAccountId: 'token', cwd: target(), resumeSessionId: S, title: null, muted: false, replaces: 'old' })
  })

  it('starts the session anew in the new folder when nothing was written yet', async () => {
    await handoff().moveTerminal('old', target())
    expect(sessionFns.move).not.toHaveBeenCalled()
    expect(createdOptions()).toEqual({ accountId: 'own', cwd: target(), title: null, muted: false, replaces: 'old' })
  })

  it.each([
    ['works on a turn', { busy: true }],
    ['compacts', { compacting: true }],
    ['has subagents running', { subagents: 1 }],
  ])('leaves the session alone while Claude %s', async (_name, overrides) => {
    tabs.set('old', tab(overrides))
    await writeTranscript()
    await expect(handoff().moveTerminal('old', target())).rejects.toThrow('Claude arbeitet gerade')
    expect(steps).toEqual([])
  })

  it('refuses the folder the session is in', async () => {
    await writeTranscript()
    await expect(handoff().moveTerminal('old', cwd)).rejects.toThrow('schon in diesem Ordner')
    expect(steps).toEqual([])
  })

  it('keeps the tab running when the new folder is not trusted', async () => {
    await writeTranscript()
    terminalFns.trustedCwd.mockResolvedValueOnce(null)
    expect(await handoff().moveTerminal('old', target())).toBeNull()
    expect(steps).toEqual([])
  })

  it('goes on where it was when the session cannot move, and says why', async () => {
    await writeTranscript()
    const copy = join(paths('own').projectsDir, projectKey(target()), `${S}.jsonl`)
    await mkdir(join(copy, '..'), { recursive: true })
    await writeFile(copy, 'copy\n')
    await expect(handoff().moveTerminal('old', target())).rejects.toThrow('Kopie')
    expect(createdOptions()).toMatchObject({ accountId: 'own', cwd, resumeSessionId: S })
    expect(steps).toEqual(['stop old', 'move', 'create', 'close old'])
  })
})

describe('SessionHandoff.resumeSession', () => {
  beforeEach(() => {
    groups = [{ accountId: 'own', error: null, sessions: [{ id: S, cwd } as SessionGroup['sessions'][number]] }]
  })

  it('opens a session from the history with a lent token', async () => {
    await writeTranscript()
    expect((await handoff().resumeSession('own', S, 'token'))?.id).toBe('opened')
    expect(terminalFns.open).toHaveBeenCalledWith({ accountId: 'own', authAccountId: 'token', cwd, resumeSessionId: S })
  })

  it('copies a session from the history to another browser login', async () => {
    await writeTranscript()
    await handoff().resumeSession('own', S, 'other')
    expect(terminalFns.open).toHaveBeenCalledWith({ accountId: 'other', cwd, resumeSessionId: S })
    expect(existsSync(transcriptOf('other'))).toBe(true)
  })

  it('refuses a session that is not in the history', async () => {
    await expect(handoff().resumeSession('own', '7c9e6679-7425-40de-944b-e07fc1f90ae7', 'token')).rejects.toThrow('Session nicht gefunden.')
    groups = []
    await expect(handoff().resumeSession('own', S, 'token')).rejects.toThrow('Session nicht gefunden.')
    expect(terminalFns.open).not.toHaveBeenCalled()
  })
})
