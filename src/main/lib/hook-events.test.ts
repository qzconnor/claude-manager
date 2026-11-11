import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyHookCall,
  commitsInShell,
  fileActivity,
  HOOK_EVENTS,
  hookSettings,
  idleHookState,
  interruptedHookState,
  mergeHookSettings,
  newHookState,
  parseHookCall,
  readUserSettings,
  userSettingsValue,
  type HookEvent,
  type HookState,
} from './hook-events'

const SESSION = '0b6c1f9e-7a7d-4a3e-9f57-2b8e1c4d5a6f'
const NOW = '2026-11-07T12:00:00.000Z'

describe('hookSettings', () => {
  it('sends every event to the app with the token and a short timeout', () => {
    const { hooks } = hookSettings('http://127.0.0.1:4000/hooks', 'secret')
    expect(Object.keys(hooks)).toEqual([...HOOK_EVENTS])
    for (const matchers of Object.values(hooks)) {
      expect(matchers).toEqual([
        { hooks: [{ type: 'http', url: 'http://127.0.0.1:4000/hooks', headers: { Authorization: 'Bearer secret' }, timeout: 3 }] },
      ])
    }
  })
})

describe('mergeHookSettings', () => {
  const ours = hookSettings('http://127.0.0.1:4000/hooks', 'secret')
  const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }

  it('keeps the user’s other settings and hooks, theirs first', () => {
    const merged = mergeHookSettings({ model: 'opus', permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [own], Notification: [own] } }, ours)
    expect(merged.model).toBe('opus')
    expect(merged.permissions).toEqual({ allow: ['Bash'] })
    const hooks = merged.hooks as Record<string, unknown[]>
    expect(hooks.PreToolUse).toEqual([own, ...ours.hooks.PreToolUse!])
    expect(hooks.Notification).toEqual([own])
    expect(hooks.Stop).toEqual(ours.hooks.Stop)
  })

  it('adds the hooks to settings without any', () => {
    expect(mergeHookSettings({ model: 'opus' }, ours)).toEqual({ model: 'opus', hooks: ours.hooks })
    expect(mergeHookSettings({ hooks: 'nonsense' }, ours)).toEqual({ hooks: ours.hooks })
  })
})

describe('userSettingsValue', () => {
  it('is null without --settings', () => {
    expect(userSettingsValue(['--model', 'opus'])).toBeNull()
  })

  it('reads both forms and takes the last one, as Claude Code does', () => {
    expect(userSettingsValue(['--settings=a.json'])).toBe('a.json')
    expect(userSettingsValue(['--settings', '{"model":"opus"}'])).toBe('{"model":"opus"}')
    expect(userSettingsValue(['--settings', 'a.json', '--model', 'opus', '--settings=b.json'])).toBe('b.json')
  })

  it('says invalid for an option without a value', () => {
    expect(userSettingsValue(['--settings'])).toBe('invalid')
    expect(userSettingsValue(['--settings', '--model', 'opus'])).toBe('invalid')
    expect(userSettingsValue(['--settings='])).toBe('invalid')
  })

  it('stops at --, after which come no options', () => {
    expect(userSettingsValue(['--', '--settings=a.json'])).toBeNull()
  })
})

describe('readUserSettings', () => {
  const files: Record<string, string> = {
    [resolve('/work', 'own.json')]: `${String.fromCharCode(0xfeff)}{"model":"opus"}`,
    [resolve('/abs', 'list.json')]: '[1, 2]',
  }
  const readFile = (path: string) => {
    const text = files[path]
    if (text === undefined) throw new Error('ENOENT')
    return text
  }

  it('reads JSON given inline', () => {
    expect(readUserSettings(' {"model":"opus"}', '/work', readFile)).toEqual({ model: 'opus' })
  })

  it('reads a file relative to the session’s folder, with a byte order mark', () => {
    expect(readUserSettings('own.json', '/work', readFile)).toEqual({ model: 'opus' })
  })

  it('is null for settings that can’t be read', () => {
    expect(readUserSettings('missing.json', '/work', readFile)).toBeNull()
    expect(readUserSettings('{model}', '/work', readFile)).toBeNull()
    expect(readUserSettings(resolve('/abs', 'list.json'), '/work', readFile)).toBeNull()
  })
})

describe('parseHookCall', () => {
  const call = (name: string, fields: Record<string, unknown> = {}) =>
    parseHookCall({ hook_event_name: name, session_id: SESSION, cwd: '/work', ...fields })
  const event = (name: string, fields: Record<string, unknown> = {}) => call(name, fields)?.event ?? null

  it('reads the session every event comes with, also those of subagents', () => {
    expect(call('UserPromptSubmit')).toEqual({ sessionId: SESSION, event: { kind: 'prompt' } })
    expect(call('PreToolUse', { tool_name: 'Bash', tool_input: {}, agent_id: 'a1' })?.sessionId).toBe(SESSION)
    expect(call('UserPromptSubmit', { session_id: 'not-a-session' })?.sessionId).toBeNull()
  })

  it('reads the tool that starts, with what it runs on', () => {
    expect(event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } })).toEqual({
      kind: 'tool',
      tool: 'Bash',
      detail: 'npm test',
      agent: null,
    })
    expect(event('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, agent_id: 'x' })).toMatchObject({ agent: 'x' })
  })

  it('takes a question or a plan as a wait for the user', () => {
    const questions = [{ question: 'Welche Variante?' }]
    expect(event('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions } })).toEqual({
      kind: 'input',
      tool: 'AskUserQuestion',
      detail: 'Welche Variante?',
    })
    expect(event('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan: Hooks\n\nmehr' } })).toEqual({
      kind: 'input',
      tool: 'ExitPlanMode',
      detail: 'Plan: Hooks',
    })
  })

  it('takes a permission request or an MCP server’s question as a wait for the user', () => {
    expect(event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })).toEqual({
      kind: 'input',
      tool: 'Bash',
      detail: 'rm -rf dist',
    })
    expect(event('Elicitation', { mcp_server_name: 'github', message: 'Token?' })).toEqual({ kind: 'input', tool: 'github', detail: 'Token?' })
  })

  it('reads the end of a turn with the answer or the error', () => {
    expect(event('Stop', { last_assistant_message: 'Fertig.', background_tasks: [] })).toEqual({
      kind: 'stop',
      message: 'Fertig.',
      background: false,
    })
    expect(event('StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' })).toEqual({
      kind: 'failure',
      error: 'rate_limit',
      message: 'API Error: Rate limit reached',
    })
  })

  it('knows a turn that waits for a subagent in the background', () => {
    const tasks = [{ id: 'a1', type: 'subagent', status: 'running', agent_type: 'general-purpose' }]
    expect(event('Stop', { last_assistant_message: 'Ich warte.', background_tasks: tasks })).toMatchObject({ background: true })
    expect(event('Stop', { background_tasks: [{ ...tasks[0], status: 'completed' }] })).toMatchObject({ background: false })
  })

  it('reads subagents and compaction', () => {
    expect(event('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' })).toEqual({ kind: 'subagent', id: 'a1', running: true })
    expect(event('SubagentStop', { agent_id: 'a1' })).toEqual({ kind: 'subagent', id: 'a1', running: false })
    expect(event('PreCompact', { trigger: 'auto' })).toEqual({ kind: 'compact', running: true })
    expect(event('PostCompact', { trigger: 'auto' })).toEqual({ kind: 'compact', running: false })
  })

  it('ignores events it doesn’t know and bodies that aren’t events', () => {
    expect(call('SessionStart')).toBeNull()
    expect(call('FileChanged')).toBeNull()
    expect(parseHookCall(null)).toBeNull()
    expect(parseHookCall('Stop')).toBeNull()
  })
})

describe('applyHookCall', () => {
  const run = (events: HookEvent[], state: HookState = newHookState(), sessionId: string | null = SESSION) => {
    const ends = []
    for (const event of events) {
      const next = applyHookCall(state, { sessionId, event }, NOW)
      state = next.state
      if (next.end) ends.push(next.end)
    }
    return { state, ends }
  }
  const bash: HookEvent = { kind: 'tool', tool: 'Bash', detail: 'npm test', agent: null }
  const stop = (message: string | null, background = false): HookEvent => ({ kind: 'stop', message, background })

  it('takes the session from the first call', () => {
    expect(run([{ kind: 'prompt' }]).state.sessionId).toBe(SESSION)
    expect(run([{ kind: 'prompt' }], newHookState(), null).state.sessionId).toBeNull()
  })

  it('shows the tool of the session’s own turn while it runs', () => {
    expect(run([bash]).state.activity).toEqual({ tool: 'Bash', detail: 'npm test', since: NOW })
    expect(run([bash, { kind: 'toolDone', agent: null }]).state.activity).toBeNull()
  })

  it('leaves the tools of subagents out', () => {
    const { state } = run([bash, { kind: 'tool', tool: 'Read', detail: 'a.ts', agent: 'x' }, { kind: 'toolDone', agent: 'x' }])
    expect(state.activity?.tool).toBe('Bash')
  })

  it('tells the end of a turn with the answer once', () => {
    const { state, ends } = run([{ kind: 'prompt' }, bash, { kind: 'toolDone', agent: null }, stop('Fertig.')])
    expect(ends).toEqual([{ kind: 'done', tool: null, detail: 'Fertig.' }])
    expect(state.ended).toBe(true)
  })

  it('waits for the turn after a subagent in the background', () => {
    const subagent: HookEvent = { kind: 'subagent', id: 'a1', running: true }
    const waiting = run([{ kind: 'prompt' }, subagent, stop('Ich warte auf den Subagent.', true)])
    expect(waiting.ends).toEqual([])
    expect(waiting.state.ended).toBe(false)
    const after = run([{ kind: 'subagent', id: 'a1', running: false }, { kind: 'prompt' }, stop('fertig')], waiting.state)
    expect(after.ends).toEqual([{ kind: 'done', tool: null, detail: 'fertig' }])
  })

  it('tells a wait for the user, and goes on after the answer', () => {
    const { state, ends } = run([bash, { kind: 'input', tool: 'Bash', detail: 'npm test' }])
    expect(ends).toEqual([{ kind: 'input', tool: 'Bash', detail: 'npm test' }])
    expect(state.ended).toBe(true)
    expect(run([{ kind: 'toolDone', agent: null }], state).state.ended).toBe(false)
  })

  it('tells the same wait once, also when Claude Code asks for it twice', () => {
    const question: HookEvent = { kind: 'input', tool: 'AskUserQuestion', detail: 'Welche Variante?' }
    expect(run([question, question]).ends).toHaveLength(1)
    expect(run([question, { kind: 'toolDone', agent: null }, { kind: 'prompt' }, question]).ends).toHaveLength(2)
  })

  it('tells a subagent’s next permission after the first was answered', () => {
    const ask: HookEvent = { kind: 'input', tool: 'Bash', detail: 'npm test' }
    expect(run([ask, { kind: 'toolDone', agent: 'x' }, ask]).ends).toHaveLength(2)
  })

  it('tells a rate limit as a limit, other errors as the end of the turn', () => {
    expect(run([{ kind: 'failure', error: 'rate_limit', message: 'Limit' }]).ends).toEqual([{ kind: 'limit', tool: null, detail: 'Limit' }])
    expect(run([{ kind: 'failure', error: 'overloaded', message: 'API Error: Overloaded' }]).ends).toEqual([
      { kind: 'done', tool: null, detail: 'API Error: Overloaded' },
    ])
  })

  it('counts subagents that run', () => {
    const start = (id: string): HookEvent => ({ kind: 'subagent', id, running: true })
    expect(run([start('a'), start('b'), start('a')]).state.subagents).toEqual(['b', 'a'])
    expect(run([start('a'), start('b'), { kind: 'subagent', id: 'a', running: false }]).state.subagents).toEqual(['b'])
  })

  it('ends what runs with the turn, also what ended without telling', () => {
    const busy = run([bash, { kind: 'subagent', id: 'a', running: true }, { kind: 'compact', running: true }]).state
    expect(run([stop('fertig')], busy).state).toMatchObject({ activity: null, subagents: [], compacting: false })
    // Subagents in the background run on.
    expect(run([stop(null, true)], busy).state).toMatchObject({ subagents: ['a'], compacting: false })
  })

  it('counts a subagent again that works after it was lost track of', () => {
    const tool: HookEvent = { kind: 'tool', tool: 'Read', detail: 'a.ts', agent: 'b' }
    expect(run([tool]).state.subagents).toEqual(['b'])
    expect(run([{ kind: 'subagent', id: 'b', running: true }, tool]).state.subagents).toEqual(['b'])
  })

  it('stops a compaction and a running tool once Claude Code stays idle (Esc)', () => {
    const busy = run([bash, { kind: 'compact', running: true }]).state
    expect(idleHookState(busy)).toMatchObject({ activity: null, compacting: false })
    // Waits for a permission: the tool is still to come.
    const waiting = run([bash, { kind: 'input', tool: 'Bash', detail: 'rm -rf build' }]).state
    expect(idleHookState(waiting).activity).toEqual(waiting.activity)
  })

  it('stops the subagents of a turn ended with Esc', () => {
    const busy = run([bash, { kind: 'subagent', id: 'a', running: true }]).state
    expect(interruptedHookState(busy)).toMatchObject({ activity: null, subagents: [], compacting: false })
  })

  it('starts afresh with another session in the process (/clear)', () => {
    const busy = run([bash, { kind: 'subagent', id: 'a', running: true }, { kind: 'compact', running: true }]).state
    const other = '1c7d2e0f-8b8e-4b4f-a068-3c9f2d5e6b70'
    expect(run([{ kind: 'prompt' }], busy, other).state).toEqual({ ...newHookState(), sessionId: other })
  })
})

describe('fileActivity', () => {
  const body = (name: string, tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    hook_event_name: name,
    tool_name: tool,
    tool_input: input,
    cwd: resolve('/work'),
    tool_use_id: 'toolu_1',
    ...extra,
  })

  it('tells the file a tool reads or writes, relative paths from the folder Claude works in', () => {
    expect(fileActivity(body('PreToolUse', 'Read', { file_path: resolve('/work/src/a.ts') }))).toEqual({
      touches: [{ path: resolve('/work/src/a.ts'), kind: 'read' }],
    })
    expect(fileActivity(body('PreToolUse', 'Edit', { file_path: 'src/b.ts' }))?.touches).toEqual([{ path: resolve('/work/src/b.ts'), kind: 'write' }])
    expect(fileActivity(body('PreToolUse', 'NotebookEdit', { notebook_path: resolve('/work/n.ipynb') }))?.touches?.[0]?.kind).toBe('write')
    // Only before the tool runs.
    expect(fileActivity(body('PostToolUse', 'Read', { file_path: resolve('/work/a.ts') }))).toBeNull()
  })

  it('tells the file a search looks in and the files it found', () => {
    expect(fileActivity(body('PreToolUse', 'Grep', { pattern: 'x', path: 'src/a.ts' }))).toEqual({
      maybe: [{ path: resolve('/work/src/a.ts'), kind: 'search' }],
    })
    expect(fileActivity(body('PreToolUse', 'Grep', { pattern: 'x' }))).toBeNull()
    const glob = body('PostToolUse', 'Glob', { pattern: '**/*.ts' }, { tool_response: { filenames: ['src/a.ts', resolve('/other/b.ts')], numFiles: 2 } })
    expect(fileActivity(glob)?.maybe).toEqual([
      { path: resolve('/work/src/a.ts'), kind: 'search' },
      { path: resolve('/other/b.ts'), kind: 'search' },
    ])
    // Grep's lines start with the file.
    const lines = body('PostToolUse', 'Grep', { pattern: 'x', output_mode: 'content' }, { tool_response: { mode: 'content', filenames: [], content: 'src/a.ts:3:x = 1\nsrc/a.ts-4-y\nlib/c.ts:9:x' } })
    expect(fileActivity(lines)?.maybe?.map((touch) => touch.path)).toEqual([resolve('/work/src/a.ts'), resolve('/work/lib/c.ts')])
  })

  it('follows a shell command: the files it names, its start and its end', () => {
    expect(fileActivity(body('PreToolUse', 'Bash', { command: 'cat a.ts && grep -n x b.ts > out.txt' }))).toEqual({
      maybe: [
        { path: resolve('/work/a.ts'), kind: 'read' },
        { path: resolve('/work/x'), kind: 'search' },
        { path: resolve('/work/b.ts'), kind: 'search' },
      ],
      shell: { id: 'toolu_1', cwd: resolve('/work'), end: false, writes: [] },
    })
    expect(fileActivity(body('PostToolUseFailure', 'PowerShell', { command: 'Set-Content -Path out.txt -Value 1' }))).toEqual({
      shell: { id: 'toolu_1', cwd: resolve('/work'), end: true, writes: [resolve('/work/out.txt'), resolve('/work/1')] },
    })
  })

  it('tells a commit by the folder the command ran in, once it ran', () => {
    expect(fileActivity(body('PostToolUse', 'Bash', { command: 'git add -A && git commit -m "fix"' }))?.commit).toBe(resolve('/work'))
    expect(fileActivity(body('PostToolUse', 'Bash', { command: 'git -C ../other commit --amend' }))?.commit).toBe(resolve('/work'))
    expect(fileActivity(body('PreToolUse', 'Bash', { command: 'git commit -m x' }))?.commit).toBeUndefined()
    expect(fileActivity(body('PostToolUseFailure', 'Bash', { command: 'git commit -m x' }))?.commit).toBeUndefined()
    expect(fileActivity(body('PostToolUse', 'Bash', { command: 'git log --oneline' }))?.commit).toBeUndefined()
  })

  it('tells a commit from PowerShell as from bash', () => {
    expect(fileActivity(body('PostToolUse', 'PowerShell', { command: 'git add -A; git commit -m "fix"' }))?.commit).toBe(resolve('/work'))
    expect(fileActivity(body('PreToolUse', 'PowerShell', { command: 'git commit -m x' }))?.commit).toBeUndefined()
  })

  it('comes with the call', () => {
    const call = parseHookCall({ ...body('PreToolUse', 'Write', { file_path: resolve('/work/c.ts') }), session_id: SESSION })
    expect(call?.files?.touches).toEqual([{ path: resolve('/work/c.ts'), kind: 'write' }])
  })
})

describe('commitsInShell', () => {
  it('finds git commit, also with options between', () => {
    expect(commitsInShell('git commit -m "fix"')).toBe(true)
    expect(commitsInShell('git -C ../repo commit --amend')).toBe(true)
    expect(commitsInShell('npm test && git commit -am x')).toBe(true)
    expect(commitsInShell('/usr/bin/git commit')).toBe(true)
  })

  it('finds it in PowerShell too, and over continued lines', () => {
    expect(commitsInShell('git.exe commit -m x')).toBe(true)
    expect(commitsInShell("& 'C:\\Program Files\\Git\\cmd\\git.exe' commit -F msg.txt")).toBe(true)
    expect(commitsInShell('GIT commit -m x')).toBe(true)
    expect(commitsInShell('git `\n  commit -m x')).toBe(true)
    expect(commitsInShell('git -C repo \\\n  commit -m x')).toBe(true)
    expect(commitsInShell('git Commit -m x')).toBe(false)
  })

  it('finds no commit in other commands or across separators', () => {
    expect(commitsInShell('git status')).toBe(false)
    expect(commitsInShell('git log; echo commit')).toBe(false)
    expect(commitsInShell('echo git | grep commit')).toBe(false)
    expect(commitsInShell('gitk commit')).toBe(false)
  })

  it('takes no time for a long command full of git', () => {
    const started = Date.now()
    expect(commitsInShell('git '.repeat(100_000))).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
