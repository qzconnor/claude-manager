import { describe, expect, it } from 'vitest'
import {
  cleanPrompt,
  collectSearchText,
  forEachEntry,
  parseTranscript,
  readConversation,
  readToolCall,
  SEARCH_ASSISTANT,
  SEARCH_USER,
  toolSummary,
} from './transcript-parser'

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
      messages: [
        { uuid: 'u1', role: 'user', timestamp: '2026-11-06T10:00:00.000Z', text: 'Fix the tests', tools: [], model: null },
        {
          uuid: 'a1',
          role: 'assistant',
          timestamp: '2026-11-06T10:00:01.000Z',
          text: 'Running them.',
          tools: [{ id: 'toolu_01', name: 'Bash', summary: 'npm test', status: 'error' }],
          model: MODEL,
        },
        {
          uuid: 'a4',
          role: 'assistant',
          timestamp: '2026-11-06T10:00:05.000Z',
          text: '',
          tools: [
            { id: 'toolu_02', name: 'Edit', summary: 'src/a.ts', status: 'ok' },
            { id: 'toolu_03', name: 'Read', summary: 'src/b.ts', status: null },
          ],
          model: MODEL,
        },
        { uuid: 'a5', role: 'assistant', timestamp: '2026-11-06T10:00:07.000Z', text: 'Done.\n\nAll green.', tools: [], model: MODEL },
        {
          uuid: 's1',
          role: 'system',
          timestamp: '2026-11-06T10:01:00.000Z',
          text: 'Konversation wurde komprimiert (/compact).',
          tools: [],
          model: null,
        },
        { uuid: 'u4', role: 'user', timestamp: '2026-11-06T10:01:04.000Z', text: '/cost', tools: [], model: null },
      ],
    })
  })

  it('keeps the latest messages when there are too many', () => {
    const { messages, truncated } = readConversation(conversation, 2)
    expect(truncated).toBe(true)
    expect(messages.map((m) => m.uuid)).toEqual(['s1', 'u4'])
    expect(readConversation(conversation, 6).truncated).toBe(false)
  })

  it('makes do without ids, names and timestamps', () => {
    const buf = jsonl(
      { type: 'user', message: { content: 'Hi' } },
      { type: 'assistant', message: { content: [text('Hello'), { type: 'tool_use', input: { command: 'ls' } }, null] } },
    )
    expect(readConversation(buf, 10).messages).toEqual([
      { uuid: '0', role: 'user', timestamp: null, text: 'Hi', tools: [], model: null },
      {
        uuid: '1',
        role: 'assistant',
        timestamp: null,
        text: 'Hello',
        tools: [{ id: null, name: 'Tool', summary: 'ls', status: null }],
        model: null,
      },
    ])
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
