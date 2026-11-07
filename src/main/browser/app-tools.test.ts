import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import type { Account, AccountUsage, ClaudeSettings, TerminalCreateOptions, TerminalInfo, TranscriptMessage, UsageWindow } from '@shared/types'
import {
  appInstructions,
  appToolNames,
  AppTools,
  type AppToolsDeps,
  enabledAppGroups,
  formatLimits,
  formatTranscript,
  insideFolder,
  localTime,
  parseAppToolArgs,
  relative,
  shellName,
  terminalText,
  windowName,
} from './app-tools'

describe('terminalText', () => {
  it('drops colors, titles and modes', () => {
    expect(terminalText('\x1b]0;pwsh\x07\x1b[?25l\x1b[32mgreen\x1b[0m text\x1b[?25h')).toBe('green text')
  })

  it('lets a carriage return and erasing overwrite a line, like a progress bar', () => {
    expect(terminalText('10 %\r20 %\r\x1b[Kdone\r\nnext')).toBe('done\nnext')
  })

  it('goes back for a rewrite of the line above', () => {
    expect(terminalText('step 1\nloading…\n\x1b[1A\x1b[2Kloaded\n')).toBe('step 1\nloaded')
  })

  it('starts a new line when the cursor jumps to another row, and stays on it for the same row', () => {
    expect(terminalText('\x1b[2J\x1b[HPS C:\\> \x1b[1;9Hnpm\x1b[2;1Houtput')).toBe('PS C:\\> npm\noutput')
  })

  it('handles backspace, tabs and blank lines', () => {
    expect(terminalText('ab\bc\n\n\n\nx\ty')).toBe('ac\n\nx       y')
  })
})

describe('helpers', () => {
  it('names the shell from its command line', () => {
    expect(shellName('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo')).toBe('PowerShell 7 (pwsh)')
    expect(shellName('powershell.exe -NoLogo')).toBe('Windows PowerShell 5.1')
    expect(shellName('/bin/zsh -l')).toBe('zsh')
  })

  it('finds folders and what is below them, on Windows without case', () => {
    expect(insideFolder('F:\\Projekte\\App\\src', 'f:/projekte/app/', 'win32')).toBe(true)
    expect(insideFolder('F:\\Projekte\\AppTwo', 'F:\\Projekte\\App', 'win32')).toBe(false)
    expect(insideFolder('/home/a/App', '/home/a/app', 'linux')).toBe(false)
    expect(insideFolder('/home/a/app', '/home/a/app', 'linux')).toBe(true)
  })

  it('says how far away a time is', () => {
    expect(relative(100 * 60_000)).toBe('in 1 h 40 min')
    expect(relative(-3 * 60_000)).toBe('3 min ago')
    expect(relative((2 * 24 + 19) * 3_600_000)).toBe('in 2 d 19 h')
    expect(relative(10_000)).toBe('now')
    expect(localTime('2026-11-07T14:00:00.000Z')).toBe('2026-11-07 15:00')
    expect(localTime(null)).toBe('unknown')
  })

  it('names the limit windows in English', () => {
    const window = (key: string, label = '?'): UsageWindow => ({ key, label, percent: 1, resetsAt: null, severity: null })
    expect(windowName(window('five_hour'))).toBe('5-hour window')
    expect(windowName(window('weekly_model:Opus'))).toBe('Week, Opus')
    expect(windowName(window('other', 'Other'))).toBe('Other')
  })

  it('knows the tools of each switch', () => {
    const claude = createDefaultSettings().claude
    expect([...enabledAppGroups(claude)]).toEqual(['limits', 'sessions'])
    expect(appToolNames(enabledAppGroups({ ...claude, shellTools: true }))).toContain('shell_input')
    expect(appInstructions(new Set(['limits']))).not.toContain('shell_open')
  })
})

describe('arguments', () => {
  it('needs a query or a folder to search', () => {
    expect(() => parseAppToolArgs('sessions_search', {})).toThrow('Give query, folder or both.')
    expect(() => parseAppToolArgs('sessions_search', { folder: 'relative/path' })).toThrow('absolute path')
    expect(parseAppToolArgs('sessions_search', { query: ' login bug ' })).toEqual({ query: 'login bug', folder: undefined, limit: 10 })
    expect(() => parseAppToolArgs('sessions_search', { query: 'x', limit: 99 })).toThrow('limit must be a number from 1 to 50.')
  })

  it('checks session ids, offsets and shell ids', () => {
    expect(() => parseAppToolArgs('session_read', { sessionId: '../x' })).toThrow('sessionId')
    expect(parseAppToolArgs('session_read', { sessionId: 'abc-1', offset: -20 })).toMatchObject({ offset: -20, limit: 40 })
    expect(() => parseAppToolArgs('shell_input', { id: 1.5, text: 'x' })).toThrow('id must be the number')
    expect(parseAppToolArgs('shell_input', { id: 2, text: '' })).toMatchObject({ id: 2, text: '', enter: true })
    expect(() => parseAppToolArgs('shell_output', { id: 1, timeout: 120 })).toThrow('timeout must be a number from 1 to 60.')
    expect(() => parseAppToolArgs('shell_output', { id: 1, waitFor: ' ' })).toThrow('waitFor must not be empty.')
  })
})

describe('formatLimits', () => {
  const account = (id: string, name: string) => ({ id, name }) as Account
  const usage: AccountUsage = {
    accountId: 'a',
    status: 'ok',
    source: 'live',
    fetchedAt: '2026-11-07T12:00:00.000Z',
    message: null,
    fiveHour: { key: 'five_hour', label: '5-Stunden-Fenster', percent: 42.4, resetsAt: '2026-11-07T14:00:00.000Z', severity: null },
    sevenDay: { key: 'seven_day', label: 'Woche', percent: 63, resetsAt: null, severity: null },
    scoped: [],
    extra: { enabled: true, usedCredits: 12.3, monthlyLimit: 50, percent: 24, currency: 'USD' },
    breakdown: [],
    nextRefreshAt: null,
  }

  it('lists the windows with reset times, the other accounts and the automatic switch', () => {
    const text = formatLimits({
      account: account('a', 'Persönlich'),
      filesAccount: null,
      usage,
      others: [{ account: account('b', 'Firma'), usage: { ...usage, accountId: 'b', fiveHour: { ...usage.fiveHour!, percent: 10 } } }],
      sessionLimit: null,
      autoSwitch: true,
      now: Date.parse('2026-11-07T12:20:00.000Z'),
    })
    expect(text).toContain('"Persönlich"')
    expect(text).toContain('- 5-hour window: 42 % used, resets 2026-11-07 15:00 (in 1 h 40 min)')
    expect(text).toContain('- Week, all models: 63 % used')
    expect(text).toContain('Extra usage is on: 12.30 of 50.00 USD used this month.')
    expect(text).toContain('- Firma: 5 h 10 %, week 63 %')
    expect(text).toContain('Automatic switch at a limit is on')
  })

  it('says when there are no numbers', () => {
    expect(formatLimits({ account: null, filesAccount: null, usage: null, others: [], sessionLimit: null, autoSwitch: false, now: 0 })).toContain(
      'no usage numbers',
    )
  })
})

describe('formatTranscript', () => {
  const message = (i: number): TranscriptMessage => ({
    uuid: String(i),
    role: i % 2 ? 'assistant' : 'user',
    timestamp: null,
    text: `message ${i}`,
    tools: i === 1 ? [{ id: 't', name: 'Bash', summary: 'npm test', status: 'ok' }] : [],
    model: null,
  })
  const messages = Array.from({ length: 10 }, (_, i) => message(i))

  it('reads a part and says how to go on', () => {
    const text = formatTranscript(messages, 0, 3, false)
    expect(text).toContain('Messages 0–2 of 10')
    expect(text).toContain('  → Bash: npm test (ok)')
    expect(text).toContain('Read on with offset 3.')
  })

  it('counts a negative offset from the end', () => {
    const text = formatTranscript(messages, -2, 40, true)
    expect(text).toContain('Messages 8–9 of 10')
    expect(text).toContain('Only the last 10 messages')
    expect(text).not.toContain('Read on')
  })
})

/** Terminals in memory: a shell answers what is typed after a moment. */
class FakeTerminals {
  private readonly events = new EventEmitter()
  infos: TerminalInfo[] = []
  readonly outputs = new Map<string, string>()
  readonly writes: [string, string][] = []
  created: TerminalCreateOptions[] = []

  on(event: string, listener: Parameters<EventEmitter['on']>[1]): () => void {
    this.events.on(event, listener)
    return () => this.events.off(event, listener)
  }

  list(): TerminalInfo[] {
    return this.infos.map((info) => ({ ...info }))
  }

  create(options: TerminalCreateOptions): TerminalInfo {
    this.created.push(options)
    const info = terminal(`shell-${this.created.length}`, { mode: 'shell', cwd: options.cwd ?? '', title: options.title ?? 'Shell', commandLine: 'pwsh.exe -NoLogo' })
    this.infos.push(info)
    this.events.emit('changed', this.list())
    setTimeout(() => this.print(info.id, 'PowerShell 7\r\nPS C:\\proj> '), 50)
    return { ...info }
  }

  buffer(id: string): { data: string; end: number } {
    const data = this.outputs.get(id) ?? ''
    return { data, end: data.length }
  }

  write(id: string, data: string): void {
    this.writes.push([id, data])
    setTimeout(() => this.print(id, `${data.replace(/\r$/, '')}\r\nran ${data.trim()}\r\nPS C:\\proj> `), 50)
  }

  close(id: string): void {
    this.infos = this.infos.filter((info) => info.id !== id)
    this.events.emit('changed', this.list())
  }

  print(id: string, data: string): void {
    const before = this.outputs.get(id) ?? ''
    this.outputs.set(id, before + data)
    this.events.emit('data', id, data, before.length)
  }
}

function terminal(id: string, patch: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    accountId: 'a1',
    authAccountId: 'a1',
    sessionId: null,
    limit: null,
    busy: false,
    attention: null,
    muted: false,
    title: id,
    fixedTitle: false,
    autoTitle: id,
    cwd: 'C:\\proj',
    mode: 'session',
    url: null,
    resumeSessionId: null,
    status: 'running',
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-07T12:00:00.000Z',
    commandLine: 'claude',
    worktree: null,
    ...patch,
  }
}

describe('AppTools', () => {
  let terminals: FakeTerminals
  let claude: ClaudeSettings
  let tools: AppTools

  beforeEach(() => {
    vi.useFakeTimers()
    terminals = new FakeTerminals()
    terminals.infos.push(terminal('session-1', { sessionId: 'sess-1' }), terminal('session-2'))
    claude = { ...createDefaultSettings().claude, shellTools: true }
    const deps = {
      terminals,
      settings: { get: () => ({ claude }) },
      accounts: { list: () => [] },
      usage: { getAll: () => [] },
      sessions: {},
    } as unknown as AppToolsDeps
    tools = new AppTools(deps)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const text = async (promise: Promise<{ content: { type: string; text?: string }[] }>) => {
    await vi.advanceTimersByTimeAsync(5000)
    return (await promise).content[0].text ?? ''
  }

  it('lists the tools of the switches that are on', () => {
    expect(tools.list(new Set(['limits'])).map((t) => t.name)).toEqual(['limits'])
    expect(tools.list(new Set(['shell'])).find((t) => t.name === 'shell_close')?.annotations?.destructiveHint).toBe(true)
  })

  it('refuses a tool that is switched off, naming the setting', async () => {
    claude.shellTools = false
    await expect(tools.call('session-1', 'shell_list', {})).rejects.toThrow('"Shell-Tabs steuern" off')
  })

  it('opens a shell below the session, runs the command and returns its output', async () => {
    const result = await text(tools.call('session-1', 'shell_open', { command: 'npm run dev' }))
    expect(terminals.created[0]).toMatchObject({ mode: 'shell', accountId: 'a1', cwd: 'C:\\proj', title: 'npm run dev', split: { terminalId: 'session-1', direction: 'column' } })
    expect(terminals.writes).toEqual([['shell-1', 'npm run dev\r']])
    expect(result).toContain('Opened shell 1 (PowerShell 7 (pwsh)) in C:\\proj, below this session.')
    expect(result).toContain('ran npm run dev')
  })

  it('types into its own shells only, and reads what is new', async () => {
    await text(tools.call('session-1', 'shell_open', {}))
    const typed = await text(tools.call('session-1', 'shell_input', { id: 1, text: 'git status', waitFor: 'ran git status' }))
    expect(typed).toContain('"ran git status" appeared.')
    expect(await text(tools.call('session-1', 'shell_output', { id: 1 }))).toContain('(none)')
    terminals.print('shell-1', 'later line\r\n')
    expect(await text(tools.call('session-1', 'shell_output', { id: 1 }))).toContain('later line')
    await expect(tools.call('session-2', 'shell_input', { id: 1, text: 'x' })).rejects.toThrow('You have no shell tabs open.')
  })

  it('opens the next shell below the last one and forgets closed ones', async () => {
    await text(tools.call('session-1', 'shell_open', {}))
    await text(tools.call('session-1', 'shell_open', { title: 'Tests' }))
    expect(terminals.created[1].split).toEqual({ terminalId: 'shell-1', direction: 'column' })
    expect(await text(tools.call('session-1', 'shell_close', { id: 1 }))).toBe('Closed shell 1.')
    expect(await text(tools.call('session-1', 'shell_list', {}))).toContain('- 2: "Tests"')
  })
})
