import { describe, expect, it } from 'vitest'
import {
  cleanPrompt,
  collectSearchText,
  forEachEntry,
  newTranscriptScan,
  parseTranscript,
  readConversation,
  readToolCall,
  scanResult,
  scanTranscript,
  SEARCH_ASSISTANT,
  SEARCH_USER,
  toolDetail,
  toolSummary,
} from './transcript-parser'
import type { TranscriptMessage, TranscriptToolCall } from '@shared/types'

const SESSION = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c'
const MODEL = 'claude-opus-4-5-20251101'

type Entry = Record<string, unknown>

const jsonl = (...entries: (Entry | string)[]) =>
  Buffer.from(entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n')

const common = { cwd: '/home/dev/app', sessionId: SESSION, userType: 'external' }

function user(content: string | Entry[], timestamp: string, extra: Entry = {}): Entry {
  return {
    parentUuid: null,
    isSidechain: false,
    ...common,
    type: 'user',
    message: { role: 'user', content },
    uuid: `u-${timestamp}`,
    timestamp,
    ...extra,
  }
}

/** One line of an answer; Claude Code writes one per content block, all with the same message id. */
function assistant(id: string, content: Entry[], timestamp: string, extra: Entry = {}, message: Entry = {}): Entry {
  return {
    parentUuid: null,
    isSidechain: false,
    ...common,
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 },
      ...message,
    },
    requestId: `req_${id}`,
    uuid: `a-${id}-${timestamp}`,
    timestamp,
    ...extra,
  }
}

const text = (value: string): Entry => ({ type: 'text', text: value })
const toolUse = (id: string, name: string, input: unknown): Entry => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: unknown, isError = false): Entry => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  is_error: isError,
})

describe('forEachEntry', () => {
  function entries(buf: Buffer): Entry[] {
    const seen: Entry[] = []
    forEachEntry(buf, (e) => seen.push(e))
    return seen
  }

  it('passes every JSON object line, also with CRLF and without a final newline', () => {
    expect(entries(Buffer.from('{"type":"user","n":1}\r\n\r\n{"type":"assistant","n":2}\n{"n":3}'))).toEqual([
      { type: 'user', n: 1 },
      { type: 'assistant', n: 2 },
      { n: 3 },
    ])
  })

  it('skips the bulky line types that are never needed', () => {
    const buf = jsonl(
      { type: 'api-request', body: 'x' },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'user', n: 1 },
      // Only the exact start of the line counts.
      { n: 2, type: 'api-request' },
    )
    expect(entries(buf)).toEqual([{ type: 'user', n: 1 }, { n: 2, type: 'api-request' }])
  })

  it('skips broken lines, a line still being written and values that are no objects', () => {
    const buf = Buffer.from('{"type":"user"\n42\n"text"\nnull\n{\n{"ok":true}\n{"type":"assistant","message":{"con')
    expect(entries(buf)).toEqual([{ ok: true }])
  })

  it('reads multi-byte characters', () => {
    expect(entries(Buffer.from('{"text":"Grüße ✓ 🔒"}\n'))).toEqual([{ text: 'Grüße ✓ 🔒' }])
  })
})

describe('cleanPrompt', () => {
  it('turns a slash command into what the user typed', () => {
    const raw =
      '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args> 123 </command-args>'
    expect(cleanPrompt(raw)).toBe('/review 123')
    expect(cleanPrompt('<command-name>compact</command-name>\n<command-args></command-args>')).toBe('/compact')
    expect(cleanPrompt('<command-name>/clear</command-name>')).toBe('/clear')
  })

  it('turns bash mode input into a ! command', () => {
    expect(cleanPrompt('<bash-input> git status </bash-input>')).toBe('! git status')
  })

  it('removes what Claude Code adds around the prompt', () => {
    expect(cleanPrompt('Fix the bug\n<system-reminder>\nThe user opened src/a.ts\n</system-reminder>\n')).toBe('Fix the bug')
    expect(cleanPrompt('<local-command-caveat>Caveat: …</local-command-caveat>')).toBe('')
    expect(cleanPrompt('<local-command-stdout>Compacted</local-command-stdout>')).toBe('')
    expect(cleanPrompt('<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>')).toBe('')
  })

  it('takes pasted text and leaves out background tasks reporting back', () => {
    expect(cleanPrompt('Schau:\n<pasted_content id="63cd">\nGucke dir die App an\n</pasted_content id="63cd">')).toBe('Schau:\nGucke dir die App an')
    expect(cleanPrompt('<task-notification>\n<summary>Done</summary>\n</task-notification>')).toBe('')
  })

  it('keeps other markup and text as it is', () => {
    expect(cleanPrompt('  Why does <div> overflow?  ')).toBe('Why does <div> overflow?')
    expect(cleanPrompt('<system-reminder>unclosed')).toBe('<system-reminder>unclosed')
  })
})

describe('parseTranscript', () => {
  const session = jsonl(
    { type: 'permission-mode', permissionMode: 'default', sessionId: SESSION },
    { type: 'summary', summary: 'Old summary', leafUuid: 'u-0' },
    user('Fix the   login\nbug', '2026-11-05T22:59:00.000Z', { gitBranch: 'main', version: '2.1.3' }),
    // An answer streamed in two lines.
    assistant('msg_01', [text('Looking.')], '2026-11-05T23:00:00.000Z'),
    assistant('msg_01', [toolUse('toolu_01', 'Read', { file_path: 'src/auth.ts' })], '2026-11-05T23:00:01.000Z'),
    user([toolResult('toolu_01', 'export function login() {}')], '2026-11-05T23:00:02.000Z'),
    user('<local-command-caveat>Caveat</local-command-caveat>', '2026-11-05T23:00:03.000Z', { isMeta: true }),
    assistant('msg_02', [text('Fixed.')], '2026-11-05T23:00:04.000Z', { gitBranch: 'fix/login', version: '2.1.4' }),
    { type: 'ai-title', aiTitle: 'Fix login bug', sessionId: SESSION },
    user('Subagent task', '2026-11-05T23:00:05.000Z', { isSidechain: true, cwd: '/elsewhere' }),
    assistant('msg_03', [text('Subagent answer')], '2026-11-05T23:00:06.000Z', { isSidechain: true }, { model: 'claude-haiku-4-5' }),
    user('Now add a test', '2026-11-05T23:01:00.000Z', { gitBranch: '' }),
    { type: 'last-prompt', lastPrompt: 'Now add a test please', sessionId: SESSION },
    { type: 'continued-in', continuedInSessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
  )

  it('summarizes a session', () => {
    expect(parseTranscript(session, SESSION, true).summary).toEqual({
      id: SESSION,
      cwd: '/home/dev/app',
      worktree: null,
      title: 'Fix login bug',
      firstPrompt: 'Fix the login bug',
      lastPrompt: 'Now add a test please',
      gitBranch: 'fix/login',
      model: MODEL,
      // Two prompts and two answers of the main conversation.
      messageCount: 4,
      createdAt: '2026-11-05T22:59:00.000Z',
      updatedAt: '2026-11-05T23:01:00.000Z',
      version: '2.1.4',
      continuedIn: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    })
  })

  it('counts the tokens of every request once, by local day', () => {
    // 23:00 UTC is already the next day in Berlin.
    expect(parseTranscript(session, SESSION, true).usage).toEqual([
      ['msg_01:req_msg_01', '2026-11-06', MODEL, 10, 20, 300, 4000],
      ['msg_02:req_msg_02', '2026-11-06', MODEL, 10, 20, 300, 4000],
      // Subagents cost tokens as well.
      ['msg_03:req_msg_03', '2026-11-06', 'claude-haiku-4-5', 10, 20, 300, 4000],
    ])
  })

  it('counts a message again when it was sent in another request, and skips odd and synthetic usage', () => {
    const buf = jsonl(
      assistant('msg_01', [text('a')], '2026-11-06T10:00:00.000Z', { requestId: 'req_a' }),
      assistant('msg_01', [text('b')], '2026-11-06T10:00:01.000Z', { requestId: 'req_b' }),
      assistant(
        'msg_02',
        [text('c')],
        '2026-11-06T10:00:02.000Z',
        { requestId: undefined },
        { model: undefined, usage: { input_tokens: 'many', output_tokens: 5 } },
      ),
      assistant('msg_03', [text('d')], 'not a date'),
      assistant('msg_04', [text('e')], '2026-11-06T10:00:03.000Z', { timestamp: undefined }),
      assistant('msg_05', [text('No response requested.')], '2026-11-06T10:00:04.000Z', {}, { model: '<synthetic>' }),
    )
    expect(parseTranscript(buf, SESSION, false).usage).toEqual([
      ['msg_01:req_a', '2026-11-06', MODEL, 10, 20, 300, 4000],
      ['msg_01:req_b', '2026-11-06', MODEL, 10, 20, 300, 4000],
      ['msg_02:', '2026-11-06', 'unknown', 0, 5, 0, 0],
    ])
  })

  it('reads on from where it was and leaves a line still being written for the next time', () => {
    const whole = parseTranscript(session, SESSION, true)
    // Cut inside a line: the part after the last newline is still being written.
    const cut = session.indexOf('"ai-title"') + 5
    const scan = newTranscriptScan(true)
    const first = scanTranscript(scan, session.subarray(0, cut))
    expect(session[first - 1]).toBe(0x0a)
    expect(first).toBeLessThan(cut)
    expect(scanResult(scan, SESSION).summary.title).toBe('Old summary')
    expect(first + scanTranscript(scan, session.subarray(first))).toBe(session.length)
    expect(scanResult(scan, SESSION)).toEqual(whole)
  })

  it('counts a message read twice once, also across reads', () => {
    const scan = newTranscriptScan(true)
    const line = jsonl(assistant('msg_01', [text('a')], '2026-11-06T10:00:00.000Z'))
    scanTranscript(scan, line)
    scanTranscript(scan, line)
    const { summary, usage } = scanResult(scan, SESSION)
    expect(summary.messageCount).toBe(1)
    expect(usage).toHaveLength(1)
  })

  it('prefers a title from /rename, then the generated one, the summary and the first prompt', () => {
    const title = (...entries: Entry[]) => parseTranscript(jsonl(...entries), SESSION, true).summary.title
    const prompt = user('First prompt', '2026-11-06T10:00:00.000Z')
    const summary = { type: 'summary', summary: 'Summary' }
    const ai = (aiTitle: string) => ({ type: 'ai-title', aiTitle })
    expect(title(prompt, summary, ai('AI'), { type: 'custom-title', customTitle: 'Mine' })).toBe('Mine')
    expect(title(prompt, summary, ai('AI'))).toBe('AI')
    expect(title(prompt, summary)).toBe('Summary')
    expect(title(prompt)).toBe('First prompt')
    expect(title()).toBe('Ohne Titel')
    expect(title(ai('First'), ai('Second'), ai(''))).toBe('Second')
  })

  it('shortens long prompts and titles to one line', () => {
    const long = `${'word '.repeat(20)}\n\n${'x'.repeat(300)}`
    const { summary } = parseTranscript(jsonl(user(long, '2026-11-06T10:00:00.000Z')), SESSION, true)
    expect(summary.firstPrompt).toHaveLength(300)
    expect(summary.firstPrompt).toMatch(/^word word .*x…$/)
    expect(summary.title).toHaveLength(160)
    expect(summary.title.endsWith('…')).toBe(true)
    expect(summary.lastPrompt).toBe(summary.firstPrompt)
  })

  it('shows slash commands as typed and skips prompts that are only noise', () => {
    const { summary } = parseTranscript(
      jsonl(
        user('<local-command-stdout>Login successful</local-command-stdout>', '2026-11-06T10:00:00.000Z'),
        user('<command-name>/model</command-name>\n<command-args>opus</command-args>', '2026-11-06T10:00:01.000Z'),
        user([text('Explain '), text('this'), { type: 'image', source: {} }], '2026-11-06T10:00:02.000Z'),
      ),
      SESSION,
      true,
    )
    expect(summary).toMatchObject({ firstPrompt: '/model opus', lastPrompt: 'Explain this', messageCount: 2 })
  })

  it('leaves the replies Claude Code writes itself out of the message count and the model', () => {
    const { summary } = parseTranscript(
      jsonl(
        user('Hi', '2026-11-06T10:00:00.000Z'),
        assistant('msg_01', [text('Hello')], '2026-11-06T10:00:01.000Z'),
        user('Go on', '2026-11-06T10:00:02.000Z'),
        assistant('msg_02', [text('API Error')], '2026-11-06T10:00:03.000Z', {}, { model: '<synthetic>' }),
      ),
      SESSION,
      true,
    )
    expect(summary).toMatchObject({ messageCount: 3, model: MODEL })
  })

  it('keeps the latest worktree the session worked in, also after it left it', () => {
    const state = (name: string) => ({
      type: 'worktree-state',
      worktreeSession: {
        originalCwd: 'F:\\Code\\app',
        worktreePath: `F:\\Code\\app\\.claude\\worktrees\\${name}`,
        worktreeName: name,
        worktreeBranch: `worktree-${name}`,
        sessionId: SESSION,
      },
      sessionId: SESSION,
    })
    const left = { type: 'worktree-state', worktreeSession: null, sessionId: SESSION }
    const { summary } = parseTranscript(jsonl(state('one'), state('two'), left), SESSION, true)
    expect(summary.worktree).toEqual({
      name: 'two',
      branch: 'worktree-two',
      path: 'F:\\Code\\app\\.claude\\worktrees\\two',
      originalCwd: 'F:\\Code\\app',
    })
    expect(parseTranscript(jsonl(left), SESSION, true).summary.worktree).toBeNull()
  })

  it('knows the folder /cd moved the session to last, where it is resumed', () => {
    const relocated = (relocatedCwd: string) => ({ type: 'relocated', sessionId: SESSION, relocatedCwd })
    const { summary } = parseTranscript(
      jsonl(
        user('Hallo', '2026-11-06T10:00:00.000Z'),
        relocated('/home/dev/first'),
        user('Weiter', '2026-11-06T10:01:00.000Z', { cwd: '/home/dev/first' }),
        relocated('/home/dev/site'),
      ),
      SESSION,
      true,
    )
    expect(summary.cwd).toBe('/home/dev/site')
    expect(parseTranscript(jsonl(user('Hallo', '2026-11-06T10:00:00.000Z')), SESSION, true).summary.cwd).toBe('/home/dev/app')
  })

  it('leaves the worktree out once /cd moved the session elsewhere', () => {
    const worktree = {
      originalCwd: 'F:\\Code\\app',
      worktreePath: 'F:\\Code\\app\\.claude\\worktrees\\one',
      worktreeName: 'one',
      worktreeBranch: 'worktree-one',
      sessionId: SESSION,
    }
    const state = { type: 'worktree-state', worktreeSession: worktree, sessionId: SESSION }
    const relocated = (relocatedCwd: string) => ({ type: 'relocated', sessionId: SESSION, relocatedCwd })
    const parse = (...entries: Entry[]) => parseTranscript(jsonl(...entries), SESSION, true).summary
    // Claude Code writes the metadata again at the end, `relocated` before `worktree-state`.
    expect(parse(state, relocated('D:\\Other'), state)).toMatchObject({ cwd: 'D:\\Other', worktree: null })
    expect(parse(relocated(worktree.worktreePath), state).worktree?.name).toBe('one')
    expect(parse(state, relocated('f:/code/app')).worktree?.name).toBe('one')
  })

  it('only collects token usage without the summary', () => {
    const { summary, usage } = parseTranscript(session, SESSION, false)
    expect(summary).toMatchObject({ cwd: null, gitBranch: null, version: null, model: null, firstPrompt: null, messageCount: 0 })
    expect(usage).toHaveLength(3)
  })

  it('handles an empty transcript', () => {
    expect(parseTranscript(Buffer.alloc(0), SESSION, true)).toEqual({
      summary: {
        id: SESSION,
        cwd: null,
        worktree: null,
        title: 'Ohne Titel',
        firstPrompt: null,
        lastPrompt: null,
        gitBranch: null,
        model: null,
        messageCount: 0,
        createdAt: null,
        updatedAt: null,
        version: null,
        continuedIn: null,
      },
      usage: [],
    })
  })
})

describe('collectSearchText', () => {
  it("keeps the user's prompts and Claude's answers, each after its marker", () => {
    const buf = jsonl(
      { type: 'file-history-snapshot', snapshot: { text: 'hidden' } },
      user('Why is the build slow?', '2026-11-06T10:00:00.000Z'),
      assistant('msg_01', [{ type: 'thinking', thinking: 'secret' }], '2026-11-06T10:00:01.000Z'),
      assistant('msg_01', [text('Let me check.'), toolUse('toolu_01', 'Bash', { command: 'npm run build' })], '2026-11-06T10:00:02.000Z'),
      user([toolResult('toolu_01', 'built in 93s')], '2026-11-06T10:00:03.000Z'),
      assistant('msg_02', [text('  ')], '2026-11-06T10:00:04.000Z'),
      assistant('msg_03', [text('The type check runs twice.')], '2026-11-06T10:00:05.000Z'),
      assistant('msg_04', [text('API Error')], '2026-11-06T10:00:06.000Z', {}, { model: '<synthetic>' }),
      user('Caveat', '2026-11-06T10:00:07.000Z', { isMeta: true }),
      user('Subagent prompt', '2026-11-06T10:00:08.000Z', { isSidechain: true }),
      user('<command-name>/compact</command-name>', '2026-11-06T10:00:09.000Z'),
    )
    expect(collectSearchText(buf)).toEqual({
      text: [
        `${SEARCH_USER}Why is the build slow?`,
        `${SEARCH_ASSISTANT}Let me check.`,
        `${SEARCH_ASSISTANT}The type check runs twice.`,
        `${SEARCH_USER}/compact`,
      ].join(''),
      end: buf.length,
    })
  })

  it('reads only complete lines and tells where to carry on', () => {
    const complete = jsonl(user('first', '2026-11-06T10:00:00.000Z'))
    const partial = Buffer.from(JSON.stringify(user('second', '2026-11-06T10:00:01.000Z')).slice(0, 40))
    expect(collectSearchText(Buffer.concat([complete, partial]))).toEqual({ text: `${SEARCH_USER}first`, end: complete.length })
    expect(collectSearchText(partial)).toEqual({ text: '', end: 0 })
    expect(collectSearchText(Buffer.alloc(0))).toEqual({ text: '', end: 0 })
  })

  it('handles CRLF and broken lines', () => {
    const buf = Buffer.from(`${JSON.stringify(user('a', 't'))}\r\n{"type":"user",\r\n${JSON.stringify(user('b', 't'))}\r\n`)
    expect(collectSearchText(buf)).toEqual({ text: `${SEARCH_USER}a${SEARCH_USER}b`, end: buf.length })
  })

  it('replaces markers inside the text', () => {
    expect(collectSearchText(jsonl(user(`a${SEARCH_ASSISTANT}b${SEARCH_USER}c`, 't'))).text).toBe(`${SEARCH_USER}a b c`)
  })
})

describe('toolSummary', () => {
  it('picks the most telling parameter', () => {
    expect(toolSummary('Bash', { description: 'List files', command: 'ls -la' })).toBe('ls -la')
    expect(toolSummary('Read', { file_path: '/home/dev/app/a.ts', limit: 20 })).toBe('/home/dev/app/a.ts')
    expect(toolSummary('Glob', { path: 'src', pattern: '**/*.ts' })).toBe('src')
    expect(toolSummary('Grep', { pattern: 'TODO', glob: '*.ts' })).toBe('TODO')
    expect(toolSummary('WebFetch', { url: 'https://example.com', prompt: 'Summarize' })).toBe('https://example.com')
    expect(toolSummary('WebSearch', { query: 'vitest mocks' })).toBe('vitest mocks')
    expect(toolSummary('Task', { description: 'Find usages', prompt: 'Long prompt', subagent_type: 'Explore' })).toBe('Find usages')
    expect(toolSummary('Skill', { skill: 'pdf' })).toBe('pdf')
  })

  it('skips empty and non-string values', () => {
    expect(toolSummary('Bash', { command: '', file_path: 42, path: 'src' })).toBe('src')
  })

  it('falls back to the input as JSON', () => {
    expect(toolSummary('TodoWrite', { todos: [{ content: 'Test', status: 'pending' }] })).toBe(
      '{"todos":[{"content":"Test","status":"pending"}]}',
    )
    expect(toolSummary('Tool', {})).toBe('{}')
  })

  it('makes one line of at most 200 characters', () => {
    expect(toolSummary('Bash', { command: 'git commit -m "a\n\nb"' })).toBe('git commit -m "a b"')
    const summary = toolSummary('Bash', { command: 'x'.repeat(500) })
    expect(summary).toHaveLength(200)
    expect(summary.endsWith('x…')).toBe(true)
  })

  it('returns nothing without an input and the name for an input that is no JSON', () => {
    expect(toolSummary('Bash', null)).toBe('')
    expect(toolSummary('Bash', 'ls')).toBe('')
    expect(toolSummary('Odd', { size: 10n })).toBe('Odd')
  })
})

/** A message of the history with what is the same for most. */
function said(message: Pick<TranscriptMessage, 'uuid' | 'role' | 'kind' | 'timestamp' | 'text'> & Partial<TranscriptMessage>): TranscriptMessage {
  return { output: null, failed: false, tools: [], model: message.role === 'assistant' ? MODEL : null, ...message }
}

/** A tool call of the history, as the parser makes it of a `tool_use` block. */
function call(id: string | null, name: string, summary: string, status: TranscriptToolCall['status'], extra: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return { id, name, summary, detail: null, description: null, command: null, status, ...extra }
}

describe('readConversation', () => {
  const conversation = jsonl(
    user('Fix the tests', '2026-11-06T10:00:00.000Z', { uuid: 'u1' }),
    assistant('msg_01', [{ type: 'thinking', thinking: '…' }], '2026-11-06T10:00:01.000Z', { uuid: 'a1' }),
    assistant('msg_01', [text('Running them.')], '2026-11-06T10:00:02.000Z', { uuid: 'a2' }),
    assistant('msg_01', [toolUse('toolu_01', 'Bash', { command: 'npm test' })], '2026-11-06T10:00:03.000Z', { uuid: 'a3' }),
    user([toolResult('toolu_01', '1 failed', true)], '2026-11-06T10:00:04.000Z', { uuid: 'u2' }),
    assistant(
      'msg_02',
      [toolUse('toolu_02', 'Edit', { file_path: 'src/a.ts' }), toolUse('toolu_03', 'Read', { file_path: 'src/b.ts' })],
      '2026-11-06T10:00:05.000Z',
      { uuid: 'a4' },
    ),
    user([toolResult('toolu_02', 'ok')], '2026-11-06T10:00:06.000Z', { uuid: 'u3' }),
    assistant('msg_03', [text('Done.')], '2026-11-06T10:00:07.000Z', { uuid: 'a5' }),
    assistant('msg_03', [text('All green.')], '2026-11-06T10:00:08.000Z', { uuid: 'a6' }),
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', uuid: 's1', timestamp: '2026-11-06T10:01:00.000Z' },
    user('Caveat', '2026-11-06T10:01:01.000Z', { isMeta: true }),
    assistant('msg_04', [text('Sidechain')], '2026-11-06T10:01:02.000Z', { isSidechain: true }),
    assistant('msg_05', [text('No response requested.')], '2026-11-06T10:01:03.000Z', {}, { model: '<synthetic>' }),
    user('<command-name>/cost</command-name>', '2026-11-06T10:01:04.000Z', { uuid: 'u4' }),
  )

  it('builds the conversation with tool calls and their outcome', () => {
    expect(readConversation(conversation, 100)).toEqual({
      truncated: false,
      total: 6,
      messages: [
        said({ uuid: 'u1', role: 'user', kind: 'prompt', timestamp: '2026-11-06T10:00:00.000Z', text: 'Fix the tests' }),
        said({
          uuid: 'a1',
          role: 'assistant',
          kind: 'answer',
          timestamp: '2026-11-06T10:00:01.000Z',
          text: 'Running them.',
          tools: [call('toolu_01', 'Bash', 'npm test', 'error', { command: 'npm test' })],
        }),
        said({
          uuid: 'a4',
          role: 'assistant',
          kind: 'answer',
          timestamp: '2026-11-06T10:00:05.000Z',
          text: '',
          tools: [call('toolu_02', 'Edit', 'src/a.ts', 'ok'), call('toolu_03', 'Read', 'src/b.ts', null)],
        }),
        said({ uuid: 'a5', role: 'assistant', kind: 'answer', timestamp: '2026-11-06T10:00:07.000Z', text: 'Done.\n\nAll green.' }),
        said({ uuid: 's1', role: 'system', kind: 'compact', timestamp: '2026-11-06T10:01:00.000Z', text: 'Konversation wurde komprimiert (/compact).' }),
        said({ uuid: 'u4', role: 'user', kind: 'command', timestamp: '2026-11-06T10:01:04.000Z', text: '/cost' }),
      ],
    })
  })

  it('keeps the latest messages when there are too many', () => {
    const { messages, truncated, total } = readConversation(conversation, 2)
    expect(truncated).toBe(true)
    expect(total).toBe(6)
    expect(messages.map((m) => m.uuid)).toEqual(['s1', 'u4'])
    expect(readConversation(conversation, 6).truncated).toBe(false)
  })

  it('makes do without ids, names and timestamps', () => {
    const buf = jsonl(
      { type: 'user', message: { content: 'Hi' } },
      { type: 'assistant', message: { content: [text('Hello'), { type: 'tool_use', input: { command: 'ls' } }, null] } },
    )
    expect(readConversation(buf, 10).messages).toEqual([
      said({ uuid: '0', role: 'user', kind: 'prompt', timestamp: null, text: 'Hi' }),
      said({ uuid: '1', role: 'assistant', kind: 'answer', timestamp: null, text: 'Hello', tools: [call(null, 'Tool', 'ls', null)], model: null }),
    ])
  })

  it('shows a slash command with what it printed, also as an entry of its own of newer versions', () => {
    const t = '2026-11-06T10:00:00.000Z'
    const local = (content: string, uuid: string): Entry => ({ type: 'system', subtype: 'local_command', content, uuid, timestamp: t, isMeta: false })
    const buf = jsonl(
      user('<local-command-caveat>Caveat: …</local-command-caveat>', t, { isMeta: true }),
      user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>', t, { uuid: 'c1' }),
      user('<local-command-stdout>Set model to \u001b[1mSonnet\u001b[22m</local-command-stdout>', t, { uuid: 'o1' }),
      user('<command-name>/clear</command-name>\n<command-args></command-args>', t, { uuid: 'c2' }),
      local('<local-command-stdout></local-command-stdout>', 'o2'),
      local('<command-name>/context</command-name>\n<command-args></command-args>', 'c3'),
      local('<local-command-stdout>(no content)</local-command-stdout>', 'o3'),
      local('<command-name>/doctor</command-name>', 'c4'),
      local('<local-command-stderr>Not available</local-command-stderr>', 'o4'),
      // Output without a command before it isn't shown.
      local('<local-command-stdout>stray</local-command-stdout>', 'o5'),
    )
    expect(readConversation(buf, 10).messages).toEqual([
      said({ uuid: 'c1', role: 'user', kind: 'command', timestamp: t, text: '/model sonnet', output: 'Set model to Sonnet' }),
      said({ uuid: 'c2', role: 'user', kind: 'command', timestamp: t, text: '/clear' }),
      said({ uuid: 'c3', role: 'user', kind: 'command', timestamp: t, text: '/context' }),
      said({ uuid: 'c4', role: 'user', kind: 'command', timestamp: t, text: '/doctor', output: 'Not available', failed: true }),
    ])
  })

  it('shows a command typed after ! with what it printed, errors too', () => {
    const t = '2026-11-06T10:00:00.000Z'
    const buf = jsonl(
      user('<bash-input> git status </bash-input>', t, { uuid: 'b1' }),
      user('<bash-stdout>On branch main\n</bash-stdout><bash-stderr></bash-stderr>', t, { uuid: 'o1' }),
      user('<bash-input>Stop-Process -Id 1</bash-input>', t, { uuid: 'b2' }),
      user('<bash-stdout></bash-stdout><bash-stderr>bash: Stop-Process: command not found\n</bash-stderr>', t, { uuid: 'o2' }),
      user('Why did that fail?', t, { uuid: 'u1' }),
      // A command's output after a prompt doesn't go to the command before it.
      user('<bash-stdout>late</bash-stdout>', t, { uuid: 'o3' }),
    )
    expect(readConversation(buf, 10).messages).toEqual([
      said({ uuid: 'b1', role: 'user', kind: 'shell', timestamp: t, text: 'git status', output: 'On branch main' }),
      said({ uuid: 'b2', role: 'user', kind: 'shell', timestamp: t, text: 'Stop-Process -Id 1', output: 'bash: Stop-Process: command not found', failed: true }),
      said({ uuid: 'u1', role: 'user', kind: 'prompt', timestamp: t, text: 'Why did that fail?' }),
    ])
  })

  it('shows a background task reporting back by its summary, with its result', () => {
    const t = '2026-11-06T10:00:00.000Z'
    const notice = (status: string, summary: string, result = '') =>
      `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n${result ? `<result>${result}</result>\n` : ''}</task-notification>`
    const buf = jsonl(
      user(notice('completed', 'Agent "Tests" finished', '## Report\nAll green.'), t, { uuid: 't1' }),
      user(notice('failed', 'Background command "npm run build" failed with exit code 1'), t, { uuid: 't2' }),
      user('<task-notification>\n<status>killed</status>\n</task-notification>', t, { uuid: 't3' }),
    )
    expect(readConversation(buf, 10).messages).toEqual([
      said({ uuid: 't1', role: 'user', kind: 'task', timestamp: t, text: 'Agent "Tests" finished', output: '## Report\nAll green.' }),
      said({ uuid: 't2', role: 'user', kind: 'task', timestamp: t, text: 'Background command "npm run build" failed with exit code 1', failed: true }),
      said({ uuid: 't3', role: 'user', kind: 'task', timestamp: t, text: 'Eine Hintergrundaufgabe hat sich gemeldet.', failed: true }),
    ])
  })

  it('shows what a compaction kept as a summary, not as a prompt, and keeps pasted text in its tags', () => {
    const t = '2026-11-06T10:00:00.000Z'
    const prompt = 'Schau dir das an:\n\n<pasted_content id="63cd">\nZeile 1\n</pasted_content id="63cd">\n'
    const buf = jsonl(
      user('This session is being continued.\n\n<system-reminder>\nTools: Read\n</system-reminder>\nSummary:\n1. Fixed it', t, {
        uuid: 's1',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      user(prompt, t, { uuid: 'u1' }),
    )
    expect(readConversation(buf, 10).messages).toEqual([
      said({ uuid: 's1', role: 'user', kind: 'summary', timestamp: t, text: 'This session is being continued.\n\n\nSummary:\n1. Fixed it' }),
      said({ uuid: 'u1', role: 'user', kind: 'prompt', timestamp: t, text: prompt.trim() }),
    ])
  })

  it('sends a shell command whole up to 4000 characters, with what Claude said it is for', () => {
    const long = `echo ${'x'.repeat(5000)}`
    const buf = jsonl(
      assistant(
        'msg_01',
        [
          toolUse('toolu_01', 'PowerShell', { command: 'Get-ChildItem\n  | Select-Object Name', description: 'List the files' }),
          toolUse('toolu_02', 'Bash', { command: long }),
          toolUse('toolu_03', 'Read', { file_path: 'src/a.ts', offset: 10, limit: 50 }),
        ],
        't',
      ),
    )
    const [answer] = readConversation(buf, 10).messages
    expect(answer.tools[0]).toEqual(
      call('toolu_01', 'PowerShell', 'Get-ChildItem | Select-Object Name', null, { command: 'Get-ChildItem\n  | Select-Object Name', description: 'List the files' }),
    )
    expect(answer.tools[1].command).toHaveLength(4001)
    expect(answer.tools[1].command!.endsWith('x…')).toBe(true)
    expect(answer.tools[2]).toEqual(call('toolu_03', 'Read', 'src/a.ts', null, { detail: 'Zeilen 10–59' }))
  })
})

describe('toolDetail', () => {
  it('says which lines or pages a Read took', () => {
    expect(toolDetail('Read', { file_path: 'a', offset: 10, limit: 50 })).toBe('Zeilen 10–59')
    expect(toolDetail('Read', { file_path: 'a', offset: 200 })).toBe('ab Zeile 200')
    expect(toolDetail('Read', { file_path: 'a', limit: 30 })).toBe('Zeilen 1–30')
    expect(toolDetail('Read', { file_path: 'a.pdf', pages: '1-5' })).toBe('Seiten 1-5')
    expect(toolDetail('Read', { file_path: 'a', offset: -1, limit: 'x' })).toBeNull()
  })

  it('says where a search looked and how many edits or tasks a call has', () => {
    expect(toolDetail('Grep', { pattern: 'x', path: 'src', glob: '*.ts' })).toBe('in src · *.ts')
    expect(toolDetail('Grep', { pattern: 'x', type: 'py' })).toBe('in py')
    expect(toolDetail('Glob', { pattern: '**/*.vue' })).toBeNull()
    expect(toolDetail('Edit', { file_path: 'a', replace_all: true })).toBe('alle Stellen')
    expect(toolDetail('MultiEdit', { file_path: 'a', edits: [{}, {}] })).toBe('2 Änderungen')
    expect(toolDetail('TodoWrite', { todos: [{}] })).toBe('1 Aufgabe')
    expect(toolDetail('Agent', { description: 'x', subagent_type: 'Explore' })).toBe('Explore')
    expect(toolDetail('WebSearch', { query: 'x' })).toBeNull()
    expect(toolDetail('Read', null)).toBeNull()
  })
})

describe('readToolCall', () => {
  const buf = jsonl(
    user('Run it', '2026-11-06T10:00:00.000Z'),
    assistant('msg_01', [text('Running.'), toolUse('toolu_01', 'Bash', { command: 'npm test', timeout: 60000, env: { CI: '1' } })], 't'),
    assistant('msg_02', [toolUse('toolu_011', 'Read', { file_path: 'other.ts' })], 't'),
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01" broken',
    user([toolResult('toolu_01', 'Tests: 1 failed', true)], 't'),
    user([toolResult('toolu_011', [text('line 1'), { type: 'image', source: {} }, text('line 2'), { foo: 1 }])], 't'),
  )

  it('returns the input in its order and the output', () => {
    expect(readToolCall(buf, 'toolu_01')).toEqual({
      id: 'toolu_01',
      name: 'Bash',
      input: [
        { key: 'command', value: 'npm test' },
        { key: 'timeout', value: '60000' },
        { key: 'env', value: '{\n  "CI": "1"\n}' },
      ],
      output: 'Tests: 1 failed',
      isError: true,
      truncated: false,
    })
  })

  it('matches the id exactly and shows other blocks of the output as placeholders', () => {
    expect(readToolCall(buf, 'toolu_011')).toMatchObject({
      name: 'Read',
      input: [{ key: 'file_path', value: 'other.ts' }],
      output: 'line 1\n[image]\nline 2\n[Inhalt]',
      isError: false,
    })
  })

  it('handles a call without result and a result without call', () => {
    const pending = jsonl(assistant('msg_01', [toolUse('toolu_09', 'Write', { file_path: 'a.ts' })], 't'))
    expect(readToolCall(pending, 'toolu_09')).toMatchObject({ name: 'Write', output: null, isError: false })
    const orphan = jsonl(user([toolResult('toolu_08', 'ok')], 't'))
    expect(readToolCall(orphan, 'toolu_08')).toEqual({
      id: 'toolu_08',
      name: 'Tool',
      input: [],
      output: 'ok',
      isError: false,
      truncated: false,
    })
  })

  it('is null for an unknown id', () => {
    expect(readToolCall(buf, 'toolu_99')).toBeNull()
    expect(readToolCall(buf, 'toolu_0')).toBeNull()
  })

  it('cuts values that are too long for the window', () => {
    const long = jsonl(
      assistant('msg_01', [toolUse('toolu_01', 'Write', { file_path: 'a.ts', content: 'x'.repeat(200_005) })], 't'),
      user([toolResult('toolu_01', 'y'.repeat(200_000))], 't'),
    )
    const detail = readToolCall(long, 'toolu_01')
    expect(detail?.truncated).toBe(true)
    expect(detail?.input[1].value).toBe(`${'x'.repeat(200_000)}\n… (5 weitere Zeichen ausgeblendet)`)
    expect(detail?.output).toBe('y'.repeat(200_000))
  })
})
