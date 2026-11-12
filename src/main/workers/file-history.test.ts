import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { absolutePath, changeTexts, MAX_COMPARED_BYTES, readFileHistory, rewindPreview, sessionChanges, VersionReader } from './file-history'

type Entry = Record<string, unknown>
const jsonl = (...entries: Entry[]) => Buffer.from(entries.map((e) => `${JSON.stringify(e)}\n`).join(''))

let root: string
let history: string
let work: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'file-history-'))
  history = join(root, 'file-history', 'session')
  work = join(root, 'work')
  mkdirSync(history, { recursive: true })
  mkdirSync(work, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const prompt = (uuid: string, content: unknown, timestamp = '2026-11-05T10:00:00.000Z'): Entry => ({
  parentUuid: null,
  type: 'user',
  message: { role: 'user', content },
  uuid,
  timestamp,
})
const backup = (name: string | null, version: number, dir: string | null = work) => ({
  backupFileName: name,
  version,
  backupTime: '2026-11-05T10:00:00.000Z',
  ...(dir ? { realParentDir: dir } : {}),
})
const snapshot = (messageId: string, files: Record<string, unknown>, timestamp: string, update = false): Entry => ({
  type: 'file-history-snapshot',
  messageId,
  snapshot: { messageId, trackedFileBackups: files, timestamp },
  isSnapshotUpdate: update,
})
const delta = (snapshotMessageId: string, trackingPath: string, b: unknown): Entry => ({
  type: 'file-history-delta',
  messageId: 'tool',
  snapshotMessageId,
  trackingPath,
  backup: b,
  timestamp: '2026-11-05T10:00:01.000Z',
})
const saved = (name: string, text: string | Buffer) => writeFileSync(join(history, name), text)
const now = (name: string, text: string | Buffer) => writeFileSync(join(work, name), text)

/**
 * Prompt 1 changes a.ts (1 2 3 → 1 zwei 3) and makes b.ts; prompt 2 adds a line to a.ts and deletes b.ts.
 */
function twoTurns(): Buffer {
  saved('a@v1', '1\n2\n3\n')
  saved('a@v2', '1\nzwei\n3\n')
  saved('b@v2', 'neu\n')
  now('a.ts', '1\nzwei\n3\nvier\n')
  return jsonl(
    prompt('p1', 'Fix a <system-reminder>noise</system-reminder>'),
    snapshot('p1', {}, '2026-11-05T10:00:00.000Z'),
    delta('p1', 'a.ts', backup('a@v1', 1)),
    delta('p1', 'b.ts', backup(null, 1)),
    snapshot('p2', { 'a.ts': backup('a@v2', 2), 'b.ts': backup('b@v2', 2) }, '2026-11-05T11:00:00.000Z'),
    prompt('p2', [{ type: 'text', text: 'Weiter' }, { type: 'image', source: {} }], '2026-11-05T11:00:00.000Z'),
  )
}

describe('readFileHistory', () => {
  it('reads the snapshots, the files added during a turn and the prompts', () => {
    const h = readFileHistory(twoTurns())
    expect(h.checkpoints.map((c) => [c.id, c.at, [...c.files.keys()]])).toEqual([
      ['p1', '2026-11-05T10:00:00.000Z', ['a.ts', 'b.ts']],
      ['p2', '2026-11-05T11:00:00.000Z', ['a.ts', 'b.ts']],
    ])
    expect(h.tracked).toEqual(['a.ts', 'b.ts'])
    expect(Object.fromEntries(h.prompts)).toEqual({ p1: 'Fix a', p2: 'Weiter' })
  })

  it('replaces a snapshot with its update, keeps a file once added and skips what it can’t use', () => {
    const h = readFileHistory(
      jsonl(
        snapshot('p1', { 'a.ts': backup('a@v1', 1) }, 't1'),
        // Added again: the first stays.
        delta('p1', 'a.ts', backup('a@v9', 9)),
        snapshot('p1', { 'c.ts': backup('c@v1', 1) }, 't1', true),
        // A name that would lead out of the folder, a broken backup, no path.
        delta('p1', 'evil.ts', backup('../../secret', 1)),
        delta('p1', 'odd.ts', 'not a backup'),
        delta('p1', '', backup('x@v1', 1)),
        // For a snapshot not seen: the latest.
        delta('gone', 'd.ts', backup(null, 1)),
        { type: 'file-history-snapshot', messageId: 'p3' },
      ),
    )
    expect(h.checkpoints).toHaveLength(1)
    expect([...h.checkpoints[0]!.files.keys()]).toEqual(['c.ts', 'd.ts'])
    expect(h.tracked).toEqual(['a.ts', 'c.ts', 'd.ts'])
    expect(h.prompts.size).toBe(0)

    // A file the turn knows keeps its state at the prompt.
    const again = readFileHistory(jsonl(snapshot('p1', { 'a.ts': backup('a@v1', 1) }, 't1'), delta('p1', 'a.ts', backup('a@v9', 9))))
    expect(again.checkpoints[0]!.files.get('a.ts')?.name).toBe('a@v1')
  })

  it('takes only a prompt of the user as the text of a snapshot', () => {
    const h = readFileHistory(jsonl({ type: 'assistant', uuid: 'p1', message: { content: 'Not a prompt' } }, snapshot('p1', {}, 't1')))
    expect(h.prompts.size).toBe(0)
  })

  it('finds the prompt of a snapshot far from it, and takes a command as typed', () => {
    const filler = Array.from({ length: 700 }, (_, i) => ({ type: 'assistant', uuid: `f${i}`, message: { content: 'x'.repeat(1000) } }))
    const h = readFileHistory(
      jsonl(
        prompt('p1', '<command-name>/review</command-name><command-args>12</command-args>'),
        ...filler,
        snapshot('p1', {}, 't1'),
        snapshot('p2', {}, 't2'),
      ),
    )
    expect(Object.fromEntries(h.prompts)).toEqual({ p1: '/review 12' })
  })
})

describe('absolutePath', () => {
  it('takes the real folder, else an absolute path, else the session folder', () => {
    const h = readFileHistory(
      jsonl(
        snapshot(
          'p1',
          {
            'src\\a.ts': backup('a@v1', 1, 'F:\\Projekte\\app\\src'),
            '/abs/b.ts': backup('b@v1', 1, null),
            'rel/c.ts': backup('c@v1', 1, null),
          },
          't1',
        ),
      ),
    )
    expect(absolutePath(h, 'src\\a.ts', null)).toBe('F:\\Projekte\\app\\src\\a.ts')
    expect(absolutePath(h, '/abs/b.ts', null)).toBe('/abs/b.ts')
    expect(absolutePath(h, 'rel/c.ts', '/home/dev/app')).toBe('/home/dev/app/rel/c.ts')
    expect(absolutePath(h, 'rel/c.ts', null)).toBeNull()
  })
})

describe('sessionChanges', () => {
  it('shows what each prompt changed, the latest up to now', async () => {
    const changes = await sessionChanges(readFileHistory(twoTurns()), new VersionReader(history), null)
    expect(changes).toEqual({
      files: 2,
      turns: [
        {
          id: 'p1',
          at: '2026-11-05T10:00:00.000Z',
          prompt: 'Fix a',
          latest: false,
          files: [
            { path: join(work, 'a.ts'), kind: 'modified', added: 1, removed: 1, note: null },
            { path: join(work, 'b.ts'), kind: 'added', added: 1, removed: 0, note: null },
          ],
        },
        {
          id: 'p2',
          at: '2026-11-05T11:00:00.000Z',
          prompt: 'Weiter',
          latest: true,
          files: [
            { path: join(work, 'a.ts'), kind: 'modified', added: 1, removed: 0, note: null },
            { path: join(work, 'b.ts'), kind: 'deleted', added: 0, removed: 1, note: null },
          ],
        },
      ],
    })
  })

  it('leaves out prompts and files without a change, also a new backup of the same content', async () => {
    saved('a@v1', 'x\n')
    saved('a@v2', 'x\n')
    now('a.ts', 'x\n')
    const changes = await sessionChanges(
      readFileHistory(
        jsonl(
          snapshot('p1', { 'a.ts': backup('a@v1', 1) }, 't1'),
          // Same backup: not even read.
          snapshot('p2', { 'a.ts': backup('a@v1', 1) }, 't2'),
          snapshot('p3', { 'a.ts': backup('a@v2', 2) }, 't3'),
        ),
      ),
      new VersionReader(history),
      null,
    )
    expect(changes).toEqual({ turns: [], files: 0 })
  })

  it('says why lines aren’t counted: a backup gone, a binary file, one too big', async () => {
    saved('bin@v1', Buffer.from([1, 0, 2]))
    now('bin.dat', Buffer.from([1, 0, 3]))
    saved('big@v1', 'small\n')
    now('big.txt', Buffer.alloc(MAX_COMPARED_BYTES + 1, 'a'))
    now('gone.ts', 'now\n')
    const changes = await sessionChanges(
      readFileHistory(
        jsonl(
          snapshot('p1', { 'bin.dat': backup('bin@v1', 1), 'big.txt': backup('big@v1', 1), 'gone.ts': backup('gone@v1', 1) }, 't1'),
        ),
      ),
      new VersionReader(history),
      null,
    )
    expect(changes.turns[0]!.files.map((f) => [f.path.slice(work.length + 1), f.kind, f.added, f.note])).toEqual([
      ['big.txt', 'modified', null, 'tooLarge'],
      ['bin.dat', 'modified', null, 'binary'],
      ['gone.ts', 'modified', null, 'unavailable'],
    ])
  })

  it('compares a file the next snapshot doesn’t know with its state before Claude changed it', async () => {
    saved('a@v1', 'old\n')
    saved('a@v2', 'mid\n')
    now('a.ts', 'mid\n')
    const h = readFileHistory(
      jsonl(snapshot('p1', { 'a.ts': backup('a@v2', 2) }, 't1'), snapshot('p0', { 'a.ts': backup('a@v1', 1) }, 't0'), snapshot('p2', {}, 't2')),
    )
    const changes = await sessionChanges(h, new VersionReader(history), null)
    // p1 → p2: back to v1 (as /rewind sees it), p0 → p2 the same, p2 → now: v1 → now.
    expect(changes.turns.map((t) => [t.id, t.files[0]!.added, t.files[0]!.removed])).toEqual([
      ['p1', 1, 1],
      ['p2', 1, 1],
    ])
  })
})

describe('rewindPreview', () => {
  it('shows how /rewind to a prompt would set the files back', async () => {
    const h = readFileHistory(twoTurns())
    const reader = new VersionReader(history)
    // To the first prompt: a.ts back to how it was, b.ts stays gone.
    expect(await rewindPreview(h, 'p1', reader, null)).toEqual([{ path: join(work, 'a.ts'), kind: 'modified', added: 1, removed: 2, note: null }])
    // To the second: a.ts loses its last line, b.ts comes back.
    expect(await rewindPreview(h, 'p2', reader, null)).toEqual([
      { path: join(work, 'a.ts'), kind: 'modified', added: 0, removed: 1, note: null },
      { path: join(work, 'b.ts'), kind: 'added', added: 1, removed: 0, note: null },
    ])
    await expect(rewindPreview(h, 'nope', reader, null)).rejects.toThrow('Diesen Prompt gibt es')
  })
})

describe('changeTexts', () => {
  it('gives both versions of a change, and nothing of a file the history doesn’t have', async () => {
    const h = readFileHistory(twoTurns())
    const reader = new VersionReader(history)
    const a = join(work, 'a.ts')
    expect(await changeTexts(h, 'p1', a, 'turn', reader, null)).toEqual({ before: '1\n2\n3\n', after: '1\nzwei\n3\n', note: null })
    expect(await changeTexts(h, 'p2', join(work, 'b.ts'), 'turn', reader, null)).toEqual({ before: 'neu\n', after: null, note: null })
    expect(await changeTexts(h, 'p1', a, 'rewind', reader, null)).toEqual({ before: '1\nzwei\n3\nvier\n', after: '1\n2\n3\n', note: null })
    now('other.ts', 'secret')
    await expect(changeTexts(h, 'p1', join(work, 'other.ts'), 'turn', reader, null)).rejects.toThrow('nicht geändert')
    await expect(changeTexts(h, 'p1', join(work, 'b.ts'), 'rewind', reader, null)).resolves.toEqual({ before: null, after: null, note: null })
  })

  it('says why it has no texts', async () => {
    saved('bin@v1', Buffer.from([0, 1]))
    now('bin.dat', 'text')
    const h = readFileHistory(jsonl(snapshot('p1', { 'bin.dat': backup('bin@v1', 1) }, 't1')))
    expect(await changeTexts(h, 'p1', join(work, 'bin.dat'), 'turn', new VersionReader(history), null)).toEqual({
      before: null,
      after: null,
      note: 'binary',
    })
  })
})
