import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudePaths } from './claude-paths'
import {
  assertNoNewerCopy,
  copySession,
  findTranscript,
  liveSessionIds,
  newTitleScan,
  projectKey,
  readLiveSession,
  readSessionLimit,
  readSessionTitles,
  readTurnOutcome,
  scannedTitle,
  sessionFiles,
  turnOutcome,
  worktreeAt,
  type TitleScan,
} from './session-files'

const SESSION = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c'
const OTHER_SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
/** The turn under test starts here. */
const T0 = Date.parse('2026-11-06T12:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

type Entry = Record<string, unknown>

const jsonl = (...entries: (Entry | string)[]) =>
  entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n'

function user(content: string | Entry[], seconds: number, extra: Entry = {}): Entry {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: `u-${seconds}`,
    timestamp: at(seconds),
    sessionId: SESSION,
    ...extra,
  }
}

function assistant(content: Entry[], seconds: number, extra: Entry = {}): Entry {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    message: { id: `msg_${seconds}`, role: 'assistant', model: 'claude-opus-4-5', content },
    uuid: `a-${seconds}`,
    timestamp: at(seconds),
    sessionId: SESSION,
    ...extra,
  }
}

const text = (value: string): Entry => ({ type: 'text', text: value })
const toolUse = (id: string, name: string, input: unknown): Entry => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: string, isError = false): Entry => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  is_error: isError,
})
const turnDuration = (seconds: number): Entry => ({
  type: 'system',
  subtype: 'turn_duration',
  durationMs: 4200,
  timestamp: at(seconds),
  isMeta: false,
})

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('projectKey', () => {
  it('replaces everything but ASCII letters and digits with a dash, as Claude Code does', () => {
    expect(projectKey('C:\\Users\\dev\\My Project')).toBe('C--Users-dev-My-Project')
    expect(projectKey('/home/dev/.config/app_v2')).toBe('-home-dev--config-app-v2')
    expect(projectKey('D:\\Projekte\\Grüße')).toBe('D--Projekte-Gr--e')
  })
})

describe('findTranscript', () => {
  const cwd = '/home/dev/app'

  async function transcript(folder: string, sessionId = SESSION): Promise<string> {
    await mkdir(join(dir, folder), { recursive: true })
    const file = join(dir, folder, `${sessionId}.jsonl`)
    await writeFile(file, '')
    return file
  }

  it("finds the transcript in the folder of the session's working directory", async () => {
    const file = await transcript(projectKey(cwd))
    await transcript('elsewhere')
    expect(await findTranscript(dir, SESSION, cwd)).toBe(file)
  })

  it('stops at the folder of the working directory when it exists', async () => {
    await mkdir(join(dir, projectKey(cwd)))
    await transcript('elsewhere')
    expect(await findTranscript(dir, SESSION, cwd)).toBeNull()
  })

  it('finds the transcript of a session in a worktree of the working directory', async () => {
    await transcript(projectKey(cwd), OTHER_SESSION)
    await transcript(`${projectKey(cwd)}-other`)
    const file = await transcript(projectKey(`${cwd}/.claude/worktrees/login-fix`))
    expect(await findTranscript(dir, SESSION, cwd)).toBe(file)
  })

  it('searches all projects when the folder name is unknown or shortened', async () => {
    const file = await transcript('-very-long-path-shortened-1a2b3c')
    await transcript('other', OTHER_SESSION)
    expect(await findTranscript(dir, SESSION, cwd)).toBe(file)
    expect(await findTranscript(dir, SESSION)).toBe(file)
    expect(await findTranscript(dir, SESSION, null)).toBe(file)
  })

  it('is null when nothing has been written yet', async () => {
    await transcript('other', OTHER_SESSION)
    await writeFile(join(dir, `${SESSION}.jsonl`), '')
    expect(await findTranscript(dir, SESSION)).toBeNull()
    expect(await findTranscript(join(dir, 'missing'), SESSION, cwd)).toBeNull()
  })
})

describe('readLiveSession', () => {
  const PID = 4242
  const SINCE = T0

  async function sessionFile(data: unknown, pid = PID): Promise<void> {
    await writeFile(join(dir, `${pid}.json`), typeof data === 'string' ? data : JSON.stringify(data))
  }

  async function liveId(sessionsDir: string, pid: number, since: number): Promise<string | null> {
    return (await readLiveSession(sessionsDir, pid, since))?.sessionId ?? null
  }

  it('reads the session Claude Code has open in the process and its folder', async () => {
    await sessionFile({ pid: PID, sessionId: SESSION, cwd: '/home/dev/app', startedAt: SINCE + 2000 })
    expect(await readLiveSession(dir, PID, SINCE)).toEqual({ sessionId: SESSION, cwd: '/home/dev/app' })
    await sessionFile({ pid: PID, sessionId: SESSION, cwd: '' })
    expect(await readLiveSession(dir, PID, SINCE)).toEqual({ sessionId: SESSION, cwd: null })
  })

  it('accepts a file without start time and one started shortly before', async () => {
    await sessionFile({ pid: PID, sessionId: SESSION })
    expect(await liveId(dir, PID, SINCE)).toBe(SESSION)
    await sessionFile({ pid: PID, sessionId: SESSION, startedAt: SINCE - 59_000 })
    expect(await liveId(dir, PID, SINCE)).toBe(SESSION)
  })

  it('ignores a file left behind by an earlier process with the same pid', async () => {
    await sessionFile({ pid: PID, sessionId: SESSION, startedAt: SINCE - 61_000 })
    expect(await liveId(dir, PID, SINCE)).toBeNull()
  })

  it('ignores files of another pid, invalid session ids and broken files', async () => {
    await sessionFile({ pid: PID + 1, sessionId: SESSION })
    expect(await liveId(dir, PID, SINCE)).toBeNull()
    await sessionFile({ pid: PID, sessionId: 'not-a-session' })
    expect(await liveId(dir, PID, SINCE)).toBeNull()
    await sessionFile({ pid: String(PID), sessionId: SESSION })
    expect(await liveId(dir, PID, SINCE)).toBeNull()
    await sessionFile('{"pid":4242,"sessionId":"3f2b')
    expect(await liveId(dir, PID, SINCE)).toBeNull()
    expect(await liveId(dir, PID + 2, SINCE)).toBeNull()
  })
})

describe('worktreeAt', () => {
  it('tells the worktree from the folder Claude Code works in', () => {
    expect(worktreeAt('C:\\dev\\app\\.claude\\worktrees\\login-fix', 'C:\\dev\\app')).toEqual({
      name: 'login-fix',
      branch: null,
      path: 'C:\\dev\\app\\.claude\\worktrees\\login-fix',
      originalCwd: 'C:\\dev\\app',
    })
    expect(worktreeAt('/home/dev/app/.claude/worktrees/demo/', '/home/dev/app/src')?.name).toBe('demo')
  })

  it('is null for other folders, also inside a worktree', () => {
    expect(worktreeAt('C:\\dev\\app', 'C:\\dev\\app')).toBeNull()
    expect(worktreeAt('C:\\dev\\app\\.claude\\worktrees', 'C:\\dev\\app')).toBeNull()
    expect(worktreeAt('/home/dev/app/.claude/worktrees/demo/src', '/home/dev/app')).toBeNull()
    expect(worktreeAt('/.claude/worktrees/demo', '/')).toBeNull()
  })
})

describe('liveSessionIds', () => {
  /** No process has this pid on Windows or Linux. */
  const DEAD_PID = 2147483646

  it('collects the sessions of running processes', async () => {
    await writeFile(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION }))
    await writeFile(join(dir, `${DEAD_PID}.json`), JSON.stringify({ pid: DEAD_PID, sessionId: OTHER_SESSION }))
    expect(await liveSessionIds(dir)).toEqual(new Set([SESSION]))
  })

  it('skips files whose pid does not match, odd names and broken files', async () => {
    await writeFile(join(dir, `${process.pid}.json`), JSON.stringify({ pid: DEAD_PID, sessionId: SESSION }))
    // pid 0 would address the whole process group.
    await writeFile(join(dir, '0.json'), JSON.stringify({ pid: 0, sessionId: SESSION }))
    await writeFile(join(dir, 'notes.json'), JSON.stringify({ pid: process.pid, sessionId: SESSION }))
    await writeFile(join(dir, `${process.pid}.json.tmp`), JSON.stringify({ pid: process.pid, sessionId: SESSION }))
    expect(await liveSessionIds(dir)).toEqual(new Set())
    await writeFile(join(dir, `${process.pid}.json`), '{"pid":')
    expect(await liveSessionIds(dir)).toEqual(new Set())
  })

  it('is empty without a sessions folder', async () => {
    expect(await liveSessionIds(join(dir, 'missing'))).toEqual(new Set())
  })
})

describe('sessionFiles', () => {
  it('lists the folders Claude Code keeps for the session that exist', async () => {
    const paths = claudePaths(dir, true)
    const project = join(paths.projectsDir, '-home-dev-app')
    const transcript = join(project, `${SESSION}.jsonl`)
    await mkdir(join(project, SESSION, 'subagents'), { recursive: true })
    await mkdir(join(dir, 'tasks', SESSION), { recursive: true })
    await mkdir(join(dir, 'file-history', OTHER_SESSION), { recursive: true })
    // A file of that name is no folder.
    await mkdir(join(dir, 'session-env'), { recursive: true })
    await writeFile(join(dir, 'session-env', SESSION), '')
    expect(await sessionFiles(paths, SESSION, transcript)).toEqual([join(project, SESSION), join(dir, 'tasks', SESSION)])
  })

  it('lists nothing for an id that is no session id', async () => {
    const paths = claudePaths(dir, true)
    expect(await sessionFiles(paths, '..', join(paths.projectsDir, 'x', 'a.jsonl'))).toEqual([])
  })
})

describe('turnOutcome', () => {
  const outcome = (...entries: (Entry | string)[]) => turnOutcome(jsonl(...entries), T0)
  const empty = { ended: false, interrupted: false, waiting: null, answer: null }

  it('reports a finished turn with its answer', () => {
    expect(
      outcome(
        user('Fix the login bug', 0),
        assistant([text('Looking into it.')], 2),
        assistant([text('  Fixed the redirect in auth.ts.\n')], 8),
        turnDuration(9),
      ),
    ).toEqual({ ended: true, interrupted: false, waiting: null, answer: 'Fixed the redirect in auth.ts.' })
  })

  it('reports the latest text while the turn is still running', () => {
    expect(outcome(user('Fix it', 0), assistant([text('Looking into it.')], 2))).toEqual({ ...empty, answer: 'Looking into it.' })
  })

  it('takes the last non-empty text block of a message', () => {
    expect(outcome(user('Hi', 0), assistant([text('first'), text('second'), text('  ')], 1)).answer).toBe('second')
  })

  it('finds the answer before tool calls that got their result', () => {
    expect(
      outcome(
        user('Where is the config read?', 0),
        assistant([text('I will search.'), toolUse('toolu_01', 'Grep', { pattern: 'readConfig' })], 1),
        user([toolResult('toolu_01', 'src/config.ts')], 2),
        assistant([toolUse('toolu_02', 'Read', { file_path: '/home/dev/app/src/config.ts' })], 3),
        user([toolResult('toolu_02', '...')], 4),
        assistant([text('In src/config.ts.')], 5),
      ).answer,
    ).toBe('In src/config.ts.')
    expect(
      outcome(
        user('Where?', 0),
        assistant([text('I will search.'), toolUse('toolu_01', 'Grep', { pattern: 'x' })], 1),
        user([toolResult('toolu_01', 'found')], 2),
      ),
    ).toEqual({ ...empty, answer: 'I will search.' })
  })

  it('reports a question Claude asks the user', () => {
    const question = { questions: [{ question: ' Which database should I use? ', header: 'DB', options: [] }] }
    expect(
      outcome(user('Set up storage', 0), assistant([text('One question first.'), toolUse('toolu_01', 'AskUserQuestion', question)], 1)),
    ).toEqual({ ...empty, waiting: { tool: 'AskUserQuestion', detail: 'Which database should I use?' } })
  })

  it("reports a plan waiting for approval with the plan's heading", () => {
    const plan = { plan: '\n\n## Plan: Split the parser\n\n1. Move the types\n2. Add tests' }
    expect(outcome(user('Plan it', 0), assistant([toolUse('toolu_01', 'ExitPlanMode', plan)], 1)).waiting).toEqual({
      tool: 'ExitPlanMode',
      detail: 'Plan: Split the parser',
    })
    expect(outcome(user('Plan it', 0), assistant([toolUse('toolu_01', 'ExitPlanMode', { plan: '' })], 1)).waiting).toEqual({
      tool: 'ExitPlanMode',
      detail: '',
    })
  })

  it('reports a permission prompt with the command or file', () => {
    const bash = toolUse('toolu_01', 'Bash', { command: 'npm  run\ntest', description: 'Run tests' })
    expect(outcome(user('Run the tests', 0), assistant([bash], 1)).waiting).toEqual({ tool: 'Bash', detail: 'npm run test' })
    expect(outcome(user('Go', 0), assistant([toolUse('toolu_01', '', { file_path: '/tmp/a.txt' })], 1)).waiting).toEqual({
      tool: 'Tool',
      detail: '/tmp/a.txt',
    })
  })

  it('waits for an unanswered tool call that follows the text in the same message', () => {
    expect(
      outcome(user('Edit it', 0), assistant([text('Editing now.'), toolUse('toolu_01', 'Edit', { file_path: 'a.ts' })], 1)),
    ).toEqual({ ...empty, waiting: { tool: 'Edit', detail: 'a.ts' } })
  })

  it('reports a turn the user stopped', () => {
    expect(outcome(user('Fix it', 0), assistant([text('Working.')], 1), user([text('[Request interrupted by user]')], 2))).toEqual({
      ...empty,
      interrupted: true,
    })
  })

  it('reports a declined tool call as stopped', () => {
    expect(
      outcome(
        user('Delete the build folder', 0),
        assistant([toolUse('toolu_01', 'Bash', { command: 'rm -rf build' })], 1),
        user([toolResult('toolu_01', "The user doesn't want to proceed with this tool use.", true)], 2),
        user([text('[Request interrupted by user for tool use]')], 2),
      ),
    ).toEqual({ ...empty, interrupted: true })
  })

  it('ignores an interruption of an earlier turn', () => {
    expect(outcome(user([text('[Request interrupted by user]')], -30))).toEqual(empty)
  })

  it("ignores an earlier turn's answer and end while the current one isn't written yet", () => {
    expect(outcome(user('Old prompt', -60), assistant([text('Old answer')], -50), turnDuration(-49))).toEqual(empty)
  })

  it('stops at the prompt that opened the turn', () => {
    expect(outcome(assistant([text('Earlier answer')], 1), user('New prompt', 2))).toEqual(empty)
  })

  it('skips sidechain and meta entries', () => {
    expect(
      outcome(
        user('Review it', 0),
        assistant([text('Looks good.')], 3),
        user('<local-command-caveat>Caveat: generated by local commands</local-command-caveat>', 4, { isMeta: true }),
        assistant([toolUse('toolu_09', 'Read', { file_path: 'x' })], 5, { isSidechain: true }),
        user([text('subagent prompt')], 5, { isSidechain: true }),
      ),
    ).toEqual({ ...empty, answer: 'Looks good.' })
  })

  it('skips broken lines and a line still being written', () => {
    const content =
      jsonl(user('Hi', 0), '{"type":"assistant", broken', assistant([text('Hello!')], 1)) +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hel'
    expect(turnOutcome(content, T0)).toEqual({ ...empty, answer: 'Hello!' })
  })

  it('ignores entries without a timestamp as not fresh', () => {
    expect(outcome(user('Hi', 0), assistant([text('Hello')], 1, { timestamp: undefined }))).toEqual(empty)
  })
})

describe('readTurnOutcome', () => {
  it('reads the end of a transcript larger than the part it reads', async () => {
    const file = join(dir, `${SESSION}.jsonl`)
    // Old history, so the read starts in the middle of a line.
    const filler = Array.from({ length: 300 }, (_, i) => user(`old prompt ${i} ${'x'.repeat(1000)}`, -3600 + i))
    await writeFile(file, jsonl(...filler, user('Fix it', 0), assistant([text('Fixed.')], 1), turnDuration(2)))
    expect((await stat(file)).size).toBeGreaterThan(256 * 1024)
    expect(await readTurnOutcome(file, T0)).toEqual({ ended: true, interrupted: false, waiting: null, answer: 'Fixed.' })
  })

  it('reads a small transcript whole', async () => {
    const file = join(dir, `${SESSION}.jsonl`)
    await writeFile(file, jsonl(user('Fix it', 0), assistant([toolUse('toolu_01', 'Bash', { command: 'ls' })], 1)))
    expect((await readTurnOutcome(file, T0)).waiting).toEqual({ tool: 'Bash', detail: 'ls' })
  })
})

describe('readSessionLimit', () => {
  const NOW = T0
  const SINCE = T0 - 60 * 60 * 1000
  const RESET_SECONDS = (T0 + 2 * 60 * 60 * 1000) / 1000

  function limit(seconds: number, extra: Entry = {}, content: Entry[] = [text("You've hit your session limit · resets 3pm")]): Entry {
    return assistant(content, seconds, {
      message: { id: `msg_${seconds}`, role: 'assistant', model: '<synthetic>', content },
      error: 'rate_limit',
      isApiErrorMessage: true,
      quotaLimits: { rateLimitType: 'five_hour', resetsAt: RESET_SECONDS },
      ...extra,
    })
  }

  async function read(...entries: (Entry | string)[]) {
    const file = join(dir, `${SESSION}.jsonl`)
    await writeFile(file, jsonl(...entries))
    return readSessionLimit(file, SINCE, NOW)
  }

  it('reports a limit that was the latest answer', async () => {
    expect(await read(user('Continue', -120), limit(-110))).toEqual({
      type: 'five_hour',
      resetsAt: new Date(RESET_SECONDS * 1000).toISOString(),
      message: "You've hit your session limit · resets 3pm",
    })
  })

  it('still reports it after a new prompt that got no answer yet', async () => {
    expect(await read(limit(-110), user('Continue', -10))).not.toBeNull()
  })

  it('is null when an answer followed the limit', async () => {
    expect(await read(limit(-110), user('Continue', -100), assistant([text('Sure.')], -90))).toBeNull()
  })

  it("ignores subagents' answers", async () => {
    expect(await read(limit(-110), assistant([text('Subagent done.')], -90, { isSidechain: true }))).not.toBeNull()
  })

  it('ignores a limit hit before `since`', async () => {
    expect(await read(limit(-2 * 60 * 60))).toBeNull()
  })

  it('ignores a limit that has been reset', async () => {
    expect(await read(limit(-110, { quotaLimits: { rateLimitType: 'five_hour', resetsAt: (NOW - 1000) / 1000 } }))).toBeNull()
  })

  it('assumes five hours without a reset time from Claude Code', async () => {
    const file = join(dir, `${SESSION}.jsonl`)
    await writeFile(file, jsonl(limit(-110, { quotaLimits: undefined })))
    expect(await readSessionLimit(file, SINCE, NOW)).toEqual({
      type: null,
      resetsAt: null,
      message: "You've hit your session limit · resets 3pm",
    })
    expect(await readSessionLimit(file, SINCE, NOW + 5 * 60 * 60 * 1000 - 200 * 1000)).not.toBeNull()
    expect(await readSessionLimit(file, SINCE, NOW + 5 * 60 * 60 * 1000)).toBeNull()
  })

  it('joins the text blocks and falls back to a default message', async () => {
    expect((await read(limit(-10, {}, [text('Limit reached.'), text('Try later.')])))?.message).toBe('Limit reached. Try later.')
    expect((await read(limit(-10, {}, [])))?.message).toBe('Nutzungslimit erreicht')
  })

  it('is null for a transcript without answers and skips broken lines', async () => {
    expect(await read(user('Hi', -10))).toBeNull()
    expect(await read(limit(-10), '{"type":"assistant","message":')).not.toBeNull()
    await writeFile(join(dir, 'empty.jsonl'), '')
    expect(await readSessionLimit(join(dir, 'empty.jsonl'), SINCE, NOW)).toBeNull()
  })
})

describe('session titles', () => {
  const file = () => join(dir, `${SESSION}.jsonl`)
  const customTitle = (title: string) => ({ type: 'custom-title', customTitle: title, sessionId: SESSION })
  const aiTitle = (title: string) => ({ type: 'ai-title', aiTitle: title, sessionId: SESSION })
  const summary = (title: string) => ({ type: 'summary', summary: title, leafUuid: 'u-1' })

  async function scan(content: string, previous: TitleScan = newTitleScan()): Promise<TitleScan> {
    await writeFile(file(), content)
    await readSessionTitles(file(), previous)
    return previous
  }

  it('starts empty', () => {
    expect(newTitleScan()).toEqual({ offset: 0, custom: null, ai: null, summary: null, worktree: null })
    expect(scannedTitle(newTitleScan())).toBeNull()
  })

  it('prefers the title set with /rename over the generated one and an old summary', () => {
    const scan = (custom: string | null, ai: string | null, summary: string | null) => ({ offset: 0, custom, ai, summary, worktree: null })
    expect(scannedTitle(scan('Mine', 'Generated', 'Old'))).toBe('Mine')
    expect(scannedTitle(scan(null, 'Generated', 'Old'))).toBe('Generated')
    expect(scannedTitle(scan(null, null, 'Old'))).toBe('Old')
  })

  it('reads the latest title of each kind', async () => {
    const content = jsonl(
      summary('Old summary'),
      user('Fix the login', 0),
      aiTitle('Fix login redirect'),
      assistant([text('Done')], 1),
      aiTitle('  Fix login redirect loop  '),
      customTitle('Login 🔒'),
    )
    const result = await scan(content)
    expect(result).toEqual({
      offset: Buffer.byteLength(content),
      custom: 'Login 🔒',
      ai: 'Fix login redirect loop',
      summary: 'Old summary',
      worktree: null,
    })
    expect(scannedTitle(result)).toBe('Login 🔒')
  })

  it('ignores empty titles and the markers inside entries of another type', async () => {
    const result = await scan(
      jsonl(
        aiTitle('Real title'),
        aiTitle('   '),
        { type: 'custom-title', customTitle: 42 },
        user([{ type: 'summary', summary: 'not a title' }], 0),
        assistant([{ type: 'custom-title', customTitle: 'not a title' }], 1),
      ),
    )
    expect(result).toMatchObject({ custom: null, ai: 'Real title', summary: null })
  })

  it('reads only what was appended since the last scan', async () => {
    const first = jsonl(user('Hi', 0), aiTitle('First'))
    const result = await scan(first)
    expect(result).toMatchObject({ offset: Buffer.byteLength(first), ai: 'First' })
    await appendFile(file(), jsonl(customTitle('Renamed')))
    await readSessionTitles(file(), result)
    expect(result).toEqual({ offset: (await stat(file())).size, custom: 'Renamed', ai: 'First', summary: null, worktree: null })
  })

  it('follows the worktree the session works in, until it leaves it', async () => {
    const worktree = {
      originalCwd: '/home/dev/app',
      worktreePath: '/home/dev/app/.claude/worktrees/login',
      worktreeName: 'login',
      worktreeBranch: 'worktree-login',
    }
    const result = await scan(jsonl(user('Hi', 0), { type: 'worktree-state', worktreeSession: worktree, sessionId: SESSION }))
    expect(result.worktree).toEqual({
      name: 'login',
      branch: 'worktree-login',
      path: '/home/dev/app/.claude/worktrees/login',
      originalCwd: '/home/dev/app',
    })
    await appendFile(file(), jsonl({ type: 'worktree-state', worktreeSession: null, sessionId: SESSION }))
    await readSessionTitles(file(), result)
    expect(result.worktree).toBeNull()
  })

  it('reads a line still being written once it is complete', async () => {
    const complete = jsonl(user('Hi', 0))
    const partial = JSON.stringify(aiTitle('Title'))
    const result = await scan(complete + partial.slice(0, 20))
    expect(result).toMatchObject({ offset: Buffer.byteLength(complete), ai: null })
    await appendFile(file(), `${partial.slice(20)}\n`)
    await readSessionTitles(file(), result)
    expect(result).toMatchObject({ offset: (await stat(file())).size, ai: 'Title' })
  })

  it('starts over when the file got shorter', async () => {
    const result = await scan(jsonl(user('A long first prompt', 0), aiTitle('Old title'), customTitle('Old name')))
    const replaced = jsonl(aiTitle('New'))
    await scan(replaced, result)
    expect(result).toEqual({ offset: Buffer.byteLength(replaced), custom: null, ai: 'New', summary: null, worktree: null })
  })

  it('does nothing when nothing was appended', async () => {
    const result = await scan(jsonl(aiTitle('Title')))
    const before = { ...result }
    await readSessionTitles(file(), result)
    expect(result).toEqual(before)
  })

  it('skips lines longer than a chunk, such as pasted images', async () => {
    const image = user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1536 * 1024) } }], 0)
    const content = jsonl(aiTitle('Before'), image, customTitle('After'), aiTitle('Last'))
    const result = await scan(content)
    expect(result).toEqual({ offset: Buffer.byteLength(content), custom: 'After', ai: 'Last', summary: null, worktree: null })
  })

  it('leaves a long line still being written for the next scan', async () => {
    const head = jsonl(aiTitle('Before'))
    const result = await scan(head + 'B'.repeat(1536 * 1024))
    expect(result).toMatchObject({ offset: Buffer.byteLength(head), ai: 'Before' })
    await appendFile(file(), `\n${jsonl(customTitle('After'))}`)
    await readSessionTitles(file(), result)
    expect(result).toMatchObject({ offset: (await stat(file())).size, custom: 'After', ai: 'Before' })
  })

  it('reads a title that crosses the border between two chunks', async () => {
    // Pads the file so that the title line starts just before the first megabyte ends.
    const title = JSON.stringify(customTitle('Across'))
    const pad = user('p', 0)
    const padLength = 1024 * 1024 - 10 - Buffer.byteLength(JSON.stringify(pad)) - 2
    const padded = { ...pad, message: { role: 'user', content: 'p'.repeat(padLength + 1) } }
    const content = jsonl(padded, title)
    expect(content.indexOf(title)).toBeLessThan(1024 * 1024)
    expect(content.indexOf(title) + title.length).toBeGreaterThan(1024 * 1024)
    expect((await scan(content)).custom).toBe('Across')
  })
})

describe('copySession', () => {
  const PROJECT = '-home-dev-app'
  let from: ReturnType<typeof claudePaths>
  let to: ReturnType<typeof claudePaths>
  let transcript: string
  const target = () => join(to.projectsDir, PROJECT, `${SESSION}.jsonl`)
  const SOURCE_TIME = new Date('2026-11-01T10:00:00Z')

  beforeEach(async () => {
    from = claudePaths(join(dir, 'a'), true)
    to = claudePaths(join(dir, 'b'), true)
    transcript = join(from.projectsDir, PROJECT, `${SESSION}.jsonl`)
    await mkdir(join(from.projectsDir, PROJECT), { recursive: true })
    await writeFile(transcript, jsonl(user('Hi', 0), assistant([text('Hello')], 1)))
    await utimes(transcript, SOURCE_TIME, SOURCE_TIME)
  })

  async function existingCopy(content: string, mtime: Date): Promise<void> {
    await mkdir(join(to.projectsDir, PROJECT), { recursive: true })
    await writeFile(target(), content)
    await utimes(target(), mtime, mtime)
  }

  it('copies the transcript, the folder next to it and the snapshots for /rewind', async () => {
    await mkdir(join(from.projectsDir, PROJECT, SESSION, 'subagents'), { recursive: true })
    await writeFile(join(from.projectsDir, PROJECT, SESSION, 'subagents', 'agent-1.jsonl'), '{}\n')
    await mkdir(join(from.configDir, 'file-history', SESSION), { recursive: true })
    await writeFile(join(from.configDir, 'file-history', SESSION, 'abc@v1'), 'snapshot')
    await mkdir(join(from.configDir, 'tasks', SESSION), { recursive: true })

    await copySession(from, to, SESSION, transcript, 'Work')

    expect(await readFile(target(), 'utf8')).toBe(await readFile(transcript, 'utf8'))
    expect(Math.abs((await stat(target())).mtimeMs - SOURCE_TIME.getTime())).toBeLessThan(1000)
    expect(await readFile(join(to.projectsDir, PROJECT, SESSION, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{}\n')
    expect(await readFile(join(to.configDir, 'file-history', SESSION, 'abc@v1'), 'utf8')).toBe('snapshot')
    expect((await readdir(to.configDir)).sort()).toEqual(['file-history', 'projects'])
  })

  it('copies a transcript without anything next to it', async () => {
    await copySession(from, to, SESSION, transcript, 'Work')
    expect(await readdir(join(to.projectsDir, PROJECT))).toEqual([`${SESSION}.jsonl`])
  })

  it('replaces an older copy and one written at about the same time', async () => {
    await existingCopy('old', new Date(SOURCE_TIME.getTime() - 60_000))
    await copySession(from, to, SESSION, transcript, 'Work')
    expect(await readFile(target(), 'utf8')).toBe(await readFile(transcript, 'utf8'))

    await existingCopy('same time', new Date(SOURCE_TIME.getTime() + 500))
    await expect(assertNoNewerCopy(to, SESSION, transcript, 'Work')).resolves.toBeUndefined()
  })

  it('refuses to replace a newer copy and copies nothing', async () => {
    await mkdir(join(from.projectsDir, PROJECT, SESSION), { recursive: true })
    await existingCopy('newer', new Date(SOURCE_TIME.getTime() + 5000))
    await expect(copySession(from, to, SESSION, transcript, 'Work')).rejects.toThrow('„Work“')
    expect(await readFile(target(), 'utf8')).toBe('newer')
    expect(await readdir(join(to.projectsDir, PROJECT))).toEqual([`${SESSION}.jsonl`])
  })

  it('passes when there is no copy yet', async () => {
    await expect(assertNoNewerCopy(to, SESSION, transcript, 'Work')).resolves.toBeUndefined()
  })
})
