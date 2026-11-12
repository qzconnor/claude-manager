import { describe, expect, it } from 'vitest'
import { fenced, inlineCode, markdownFileName, sessionMarkdown } from './session-markdown'
import type { SessionSummary, TranscriptMessage } from './types'

const summary: SessionSummary = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  accountId: 'a',
  projectKey: 'F--app',
  cwd: 'F:\\app',
  worktree: null,
  title: 'Login *reparieren*',
  name: null,
  pinned: true,
  tags: ['Bug', 'Auth'],
  firstPrompt: null,
  lastPrompt: null,
  gitBranch: 'main',
  model: 'claude-opus-4-7',
  messageCount: 4,
  messageCountExact: true,
  createdAt: '2026-11-10T08:00:00.000Z',
  updatedAt: '2026-11-11T09:30:00.000Z',
  sizeBytes: 100,
  version: null,
}

function message(kind: TranscriptMessage['kind'], text: string, more: Partial<TranscriptMessage> = {}): TranscriptMessage {
  const role = kind === 'answer' ? 'assistant' : kind === 'compact' ? 'system' : 'user'
  return { uuid: text, role, kind, timestamp: null, text, output: null, failed: false, tools: [], model: null, ...more }
}

const md = (messages: TranscriptMessage[], options = {}) => sessionMarkdown(summary, messages, { timeZone: 'UTC', ...options })

describe('sessionMarkdown', () => {
  it('starts with the title and what the session is about', () => {
    const head = md([]).trimEnd().split('\n\n')
    expect(head[0]).toBe('# Login \\*reparieren\\*')
    expect(head[1].split('\n')).toEqual([
      '- **Ordner:** `F:\\app`',
      '- **Branch:** `main`',
      '- **Modell:** Opus 4.7',
      '- **Begonnen:** 10.11.2026, 08:00',
      '- **Zuletzt aktiv:** 11.11.2026, 09:30',
      '- **Tags:** Bug, Auth',
      '- **Session-ID:** `0f8fad5b-d9cb-469f-a165-70867728950e`',
    ])
    expect(md([]).endsWith('`\n')).toBe(true)
  })

  it('names the worktree instead of the branch and leaves out what the session does not record', () => {
    const bare = {
      ...summary,
      cwd: null,
      model: null,
      tags: [],
      worktree: { name: 'wt', branch: 'feat', path: 'F:\\wt', originalCwd: 'F:\\app' },
    }
    const head = sessionMarkdown(bare, [], { timeZone: 'UTC' }).split('\n\n')[1]
    expect(head).toContain('- **Worktree:** `wt` (Branch `feat`)')
    expect(head).not.toMatch(/Ordner|Branch:|Modell|Tags/)
  })

  it('names a model it does not know by its id', () => {
    const text = sessionMarkdown({ ...summary, model: 'eigenes_modell' }, [message('answer', 'Hi', { model: '<synthetic>' })], {
      timeZone: 'UTC',
    })
    expect(text).toContain('- **Modell:** eigenes\\_modell')
    expect(text).toContain('### Claude · \\<synthetic\\>')
  })

  it('says how many of the oldest messages are missing', () => {
    expect(md([], { omitted: 1 })).toContain('> Die älteste Nachricht fehlt, der Verlauf ist zu lang.')
    expect(md([], { omitted: 12000 })).toContain('> Die ältesten 12.000 Nachrichten fehlen, der Verlauf ist zu lang.')
  })

  it('heads each day and each turn of an author, with the time', () => {
    const text = md([
      message('prompt', 'Fix the login', { timestamp: '2026-11-10T08:01:00.000Z' }),
      message('answer', 'Looking at it.', { timestamp: '2026-11-10T08:02:00.000Z', model: 'claude-opus-4-7' }),
      message('answer', 'Done.', { timestamp: '2026-11-10T08:03:00.000Z' }),
      // The next day the same author's turn has its heading again.
      message('answer', 'Still done.', { timestamp: '2026-11-11T08:00:00.000Z' }),
      message('prompt', 'Thanks', { timestamp: '2026-11-11T09:00:00.000Z' }),
    ])
    const body = text.slice(text.indexOf('## '))
    expect(body).toBe(
      [
        '## Dienstag, 10. November 2026',
        '### Du · 08:01',
        'Fix the login',
        '### Claude · Opus 4.7 · 08:02',
        'Looking at it.',
        'Done.',
        '## Mittwoch, 11. November 2026',
        '### Claude · 08:00',
        'Still done.',
        '### Du · 09:00',
        'Thanks',
      ].join('\n\n') + '\n',
    )
  })

  it('lists Claude’s tool calls under its answer, a failed one marked', () => {
    const text = md([
      message('answer', '', {
        tools: [
          // The whole command, not the summary of it.
          {
            id: '1',
            name: 'Bash',
            summary: 'npm test',
            detail: null,
            description: 'Run the tests',
            command: 'npm test -- --run',
            status: 'error',
          },
          { id: '2', name: 'Read', summary: 'src/a.ts', detail: 'Zeilen 1–20', description: null, command: null, status: 'ok' },
        ],
      }),
    ])
    expect(text).toContain('### Claude\n\n- **Bash** `npm test -- --run` – Run the tests (Fehler)\n- **Read** `src/a.ts` Zeilen 1–20\n')
  })

  it('puts pasted text, commands and their output in code blocks', () => {
    const text = md([
      message('prompt', 'Look at this:\n<pasted_content id="1">\nError: ```boom```\n</pasted_content id="1">'),
      message('command', '/model opus', { output: 'Set model to Opus' }),
      message('shell', 'git status', { output: 'fatal: not a git repository', failed: true }),
    ])
    expect(text).toContain(
      '### Du\n\nLook at this:\n\n````\nError: ```boom```\n````\n\n```\n/model opus\n```\n\nAusgabe:\n\n```\nSet model to Opus\n```',
    )
    expect(text).toContain('```bash\n! git status\n```\n\nAusgabe (mit Fehlern):\n\n```\nfatal: not a git repository\n```')
  })

  it('shows compactions, what they kept and background tasks between the turns', () => {
    const text = md([
      message('prompt', 'One'),
      message('compact', 'Gespräch komprimiert'),
      message('summary', 'We fixed the login.'),
      message('task', 'Tests laufen', { failed: true, output: 'Two failed' }),
      message('prompt', 'Two'),
    ])
    expect(text).toContain(
      [
        '### Du',
        'One',
        '---',
        '*Gespräch komprimiert*',
        '<details>\n<summary>Zusammenfassung des bisherigen Gesprächs</summary>\n\nWe fixed the login.\n\n</details>',
        '**Hintergrundaufgabe (fehlgeschlagen):** Tests laufen',
        'Two failed',
        // After them the user's turn has its heading again.
        '### Du',
        'Two',
      ].join('\n\n'),
    )
    // Also after a compaction alone.
    expect(md([message('prompt', 'One'), message('compact', 'Gespräch komprimiert'), message('prompt', 'Two')])).toContain(
      '*Gespräch komprimiert*\n\n### Du\n\nTwo',
    )
  })
})

describe('fenced and inlineCode', () => {
  it('fences with more backticks than the text has in a row', () => {
    expect(fenced('a\n\n')).toBe('```\na\n```')
    expect(fenced('x ```` y', 'bash')).toBe('`````bash\nx ```` y\n`````')
  })

  it('puts code in a line, on one line, also with backticks in it', () => {
    expect(inlineCode('npm  test')).toBe('`npm  test`')
    expect(inlineCode('a\n  b')).toBe('`a b`')
    expect(inlineCode('echo `date`')).toBe('`` echo `date` ``')
  })
})

describe('markdownFileName', () => {
  it('names the file after the title without what Windows does not take', () => {
    expect(markdownFileName('Fix: login/logout?')).toBe('Fix login logout.md')
    expect(markdownFileName('  Ende.  ')).toBe('Ende.md')
    expect(markdownFileName('x'.repeat(100))).toBe(`${'x'.repeat(80)}.md`)
  })

  it('falls back to „Session“ for an empty title or a device name', () => {
    expect(markdownFileName('???')).toBe('Session.md')
    expect(markdownFileName('CON')).toBe('Session.md')
  })
})
