import { describe, expect, it } from 'vitest'
import { keepTabs, MAX_TAB_SET_TABS, parseTabSetTabs, tabSetCommandError, tabSetNameError, tabSetTabLabel, tabSetTabs } from './tab-sets'
import type { PaneNode, PaneSplit, TabSetBrowser, TabSetTab, TabSetTerminal, TerminalInfo } from './types'

const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e'

const row = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneSplit => ({ direction: 'row', ratio, first, second })

function info(id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    accountId: 'acc-a',
    authAccountId: 'acc-a',
    sessionId: null,
    limit: null,
    resume: null,
    context: null,
    busy: false,
    attention: null,
    muted: false,
    title: 'Tab',
    fixedTitle: false,
    autoTitle: 'Tab',
    cwd: 'C:\\code\\app',
    mode: 'session',
    url: null,
    resumeSessionId: null,
    args: [],
    status: 'running',
    sleep: null,
    exitCode: null,
    pid: 1,
    createdAt: '2026-11-12T12:00:00.000Z',
    commandLine: 'claude',
    worktree: null,
    hooks: false,
    activity: null,
    subagents: 0,
    compacting: false,
    turn: null,
    prompt: null,
    ...overrides,
  }
}

const shell = (cwd: string, extra: Partial<TabSetTerminal> = {}): TabSetTerminal => ({
  mode: 'shell',
  accountId: 'acc-a',
  cwd,
  title: null,
  muted: false,
  args: [],
  sessionId: null,
  command: null,
  ...extra,
})
const page = (url: string, extra: Partial<TabSetBrowser> = {}): TabSetBrowser => ({ mode: 'browser', url, title: null, ...extra })

describe('tabSetTabs', () => {
  it('takes sessions, shells and browsers in their order, without login tabs', () => {
    const tabs = tabSetTabs(
      [
        info('a', { sessionId: S1, args: ['--model', 'opus', 'Fix the build'], muted: true }),
        info('login', { mode: 'login' }),
        info('b', { mode: 'shell', cwd: 'C:\\code\\api', title: 'API', fixedTitle: true, args: ['--x'] }),
        info('c', { mode: 'browser', url: 'http://localhost:5173/', title: 'Vite', cwd: '' }),
      ],
      [],
    )
    expect(tabs).toEqual([
      {
        mode: 'session',
        accountId: 'acc-a',
        cwd: 'C:\\code\\app',
        title: null,
        muted: true,
        args: ['--model', 'opus'],
        sessionId: S1,
        command: null,
      },
      { mode: 'shell', accountId: 'acc-a', cwd: 'C:\\code\\api', title: 'API', muted: false, args: [], sessionId: null, command: null },
      { mode: 'browser', url: 'http://localhost:5173/', title: null },
    ])
  })

  it('keeps how split tabs share their space, by index among the tabs taken', () => {
    const tabs = tabSetTabs([info('login', { mode: 'login' }), info('a'), info('b'), info('c')], [row('a', row('c', 'login'))])
    expect(tabs.map((t) => t.layout)).toEqual([row('0', '2'), undefined, undefined])
  })

  it('keeps no session of a shell', () => {
    expect(tabSetTabs([info('a', { mode: 'shell', sessionId: S1 })], [])).toMatchObject([{ mode: 'shell', sessionId: null }])
  })

  it('leaves a split tab out whose other parts are all login tabs', () => {
    const tabs = tabSetTabs([info('a'), info('login', { mode: 'login' })], [row('a', 'login')])
    expect(tabs).toHaveLength(1)
    expect(tabs[0].layout).toBeUndefined()
  })
})

describe('keepTabs', () => {
  const tabs: TabSetTab[] = [shell('A', { layout: row('0', row('1', '2', 0.3), 0.6) }), shell('B'), shell('C'), page('http://localhost/')]

  it('keeps all tabs as they are when all are picked', () => {
    expect(keepTabs(tabs, () => true)).toEqual(tabs)
  })

  it('gives the space of a part that goes to the others, by the new indexes', () => {
    const kept = keepTabs(tabs, (_tab, i) => i !== 1)
    expect(kept.map((t) => (t.mode === 'browser' ? t.url : t.cwd))).toEqual(['A', 'C', 'http://localhost/'])
    expect(kept[0].layout).toEqual(row('0', '1', 0.6))
  })

  it('moves the layout to the first part left, when the first one goes', () => {
    const kept = keepTabs(tabs, (_tab, i) => i !== 0)
    expect(kept[0].layout).toEqual(row('0', '1', 0.3))
    expect(kept.slice(1).every((t) => t.layout === undefined)).toBe(true)
  })

  it('makes a split tab left with one part a tab of its own', () => {
    const kept = keepTabs(tabs, (_tab, i) => i === 2 || i === 3)
    expect(kept).toEqual([shell('C'), page('http://localhost/')])
  })
})

describe('tabSetTabLabel', () => {
  it('names a tab by its name, else by its folder or the page host', () => {
    expect(tabSetTabLabel(shell('C:\\code\\api', { title: 'Server' }))).toBe('Server')
    expect(tabSetTabLabel(shell('C:\\code\\api\\'))).toBe('Shell · api')
    expect(tabSetTabLabel({ ...shell('/home/me/web'), mode: 'session' })).toBe('Session · web')
    expect(tabSetTabLabel(page('http://localhost:5173/app'))).toBe('localhost:5173')
    expect(tabSetTabLabel(page('about:blank'))).toBe('about:blank')
  })
})

describe('tabSetNameError and tabSetCommandError', () => {
  it('wants a name of up to 80 characters', () => {
    expect(tabSetNameError('  ')).toBe('Gib dem Tab-Set einen Namen.')
    expect(tabSetNameError('x'.repeat(80))).toBeNull()
    expect(tabSetNameError('x'.repeat(81))).toMatch(/zu lang/)
  })

  it('wants a command of one line', () => {
    expect(tabSetCommandError('npm run dev')).toBeNull()
    expect(tabSetCommandError('npm i\nnpm run dev')).toBe('Der Startbefehl ist eine Zeile.')
    expect(tabSetCommandError('npm i\rnpm run dev')).toBe('Der Startbefehl ist eine Zeile.')
    expect(tabSetCommandError('x'.repeat(2001))).toMatch(/zu lang/)
  })
})

describe('parseTabSetTabs', () => {
  it('takes valid tabs and cleans them up', () => {
    const parsed = parseTabSetTabs([
      { mode: 'session', accountId: 'acc-a', cwd: 'C:\\a', title: '  Mein Tab  ', muted: false, args: ['--model', 'opus'], sessionId: S1 },
      {
        mode: 'shell',
        accountId: 'acc-a',
        cwd: 'C:\\b',
        title: '',
        muted: true,
        args: ['--x'],
        sessionId: null,
        command: '  npm run dev  ',
      },
      { mode: 'browser', url: 'https://example.com/', title: null },
    ])
    expect(parsed).toEqual([
      {
        mode: 'session',
        accountId: 'acc-a',
        cwd: 'C:\\a',
        title: 'Mein Tab',
        muted: false,
        args: ['--model', 'opus'],
        sessionId: S1,
        command: null,
      },
      { mode: 'shell', accountId: 'acc-a', cwd: 'C:\\b', title: null, muted: true, args: [], sessionId: null, command: 'npm run dev' },
      { mode: 'browser', url: 'https://example.com/', title: null },
    ])
  })

  it('refuses no tabs, too many and anything but a list', () => {
    expect(parseTabSetTabs([])).toBeNull()
    expect(parseTabSetTabs({})).toBeNull()
    expect(parseTabSetTabs(Array.from({ length: MAX_TAB_SET_TABS + 1 }, () => shell('C:\\a')))).toBeNull()
    expect(parseTabSetTabs(Array.from({ length: MAX_TAB_SET_TABS }, () => shell('C:\\a')))).toHaveLength(MAX_TAB_SET_TABS)
  })

  it.each([
    ['a login tab', { ...shell('C:\\a'), mode: 'login' }],
    ['no account', { ...shell('C:\\a'), accountId: '' }],
    ['no folder', { ...shell('C:\\a'), cwd: 1 }],
    ['no muted flag', { ...shell('C:\\a'), muted: 'no' }],
    ['a title that is no text', { ...shell('C:\\a'), title: 5 }],
    ['args that are no texts', { ...shell('C:\\a'), mode: 'session', args: [1] }],
    ['too many args', { ...shell('C:\\a'), mode: 'session', args: Array.from({ length: 65 }, () => '--x') }],
    ['an invalid session id', { ...shell('C:\\a'), mode: 'session', sessionId: '../x' }],
    ['a session id of a shell', { ...shell('C:\\a'), sessionId: S1 }],
    ['a command of a session', { ...shell('C:\\a'), mode: 'session', command: 'npm run dev' }],
    ['a command of two lines', { ...shell('C:\\a'), command: 'a\nb' }],
    ['a page that is no web page', page('file:///C:/secret.txt')],
    ['a page without address', { mode: 'browser', title: null }],
  ])('refuses the set for %s', (_what, tab) => {
    expect(parseTabSetTabs([shell('C:\\ok'), tab])).toBeNull()
  })

  it('keeps layouts that fit and opens the parts of the others as tabs of their own', () => {
    const parsed = parseTabSetTabs([
      shell('A', { layout: row('0', '1') }),
      shell('B'),
      shell('C', { layout: row('2', '9') }),
      // Its second part is a part of the first split tab already.
      shell('D', { layout: row('3', '1') }),
      shell('E', { layout: row('4', 'x') }),
      shell('F', { layout: '5' }),
      shell('G', { layout: row('6', '6') }),
    ])
    expect(parsed?.map((t) => t.layout)).toEqual([row('0', '1'), undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it('takes a layout only on the first part of its split tab', () => {
    expect(parseTabSetTabs([shell('A'), shell('B', { layout: row('0', '1') })])?.map((t) => t.layout)).toEqual([undefined, undefined])
  })
})
