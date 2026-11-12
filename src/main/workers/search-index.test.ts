import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readJson, writeJsonAtomic } from '../lib/json-file'
import { SearchIndex, type SearchFile } from './search-index'
import { SEARCH_USER } from './transcript-parser'

// Writes for real, and counts how often.
vi.mock('../lib/json-file', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/json-file')>()
  return { ...original, writeJsonAtomic: vi.fn(original.writeJsonAtomic) }
})

const PROJECT = '-home-dev-app'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

let dir: string
let projects: string
let cacheFile: string
let listFiles: ReturnType<typeof vi.fn<(projectsDir: string) => Promise<SearchFile[]>>>

const jsonl = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-11-06T10:00:00.000Z' })
const assistant = (text: string) => ({
  type: 'assistant',
  message: { id: 'msg_01', role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text }] },
  timestamp: '2026-11-06T10:00:01.000Z',
})

const file = (sessionId: string) => join(projects, PROJECT, `${sessionId}.jsonl`)

async function transcript(sessionId: string, content: string, minutesAgo = 0): Promise<void> {
  await writeFile(file(sessionId), content)
  const time = new Date(Date.parse('2026-11-06T12:00:00Z') - minutesAgo * 60_000)
  await utimes(file(sessionId), time, time)
}

/** Lets the refresh interval pass without running the timer that saves the index. */
function later(): void {
  vi.setSystemTime(Date.now() + 3000)
}

const ids = (hits: { sessionId: string }[]) => hits.map((hit) => hit.sessionId)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  dir = await mkdtemp(join(tmpdir(), 'cm-test-'))
  projects = join(dir, 'projects')
  cacheFile = join(dir, 'cache', 'search-index.json')
  await mkdir(join(projects, PROJECT), { recursive: true })
  listFiles = vi.fn(async (projectsDir: string) => {
    const names = await readdir(join(projectsDir, PROJECT))
    return names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ path: join(projectsDir, PROJECT, name), sessionId: name.slice(0, -'.jsonl'.length) }))
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('SearchIndex', () => {
  beforeEach(async () => {
    await transcript(A, jsonl(user('How do I size the database pool?'), assistant('Set the pool size in config.ts.')), 30)
    await transcript(B, jsonl(user('The Database migration fails'), assistant('Run the migration again.')), 5)
    await transcript(C, jsonl(user('Hello'), assistant('Hi! How can I help?')), 1)
  })

  it('finds the sessions that contain every word, newest first', async () => {
    const index = new SearchIndex(cacheFile, listFiles)
    expect(ids(await index.search(projects, 'database', 10))).toEqual([B, A])
    expect(ids(await index.search(projects, 'DATABASE  pool', 10))).toEqual([A])
    expect(ids(await index.search(projects, 'database help', 10))).toEqual([])
    expect(ids(await index.search(projects, 'database', 1))).toEqual([B])
    expect(await index.search(projects, '  ', 10)).toEqual([])
  })

  it('shows the match in its message with the role', async () => {
    const index = new SearchIndex(cacheFile, listFiles)
    expect(await index.search(projects, 'migration', 10)).toEqual([
      { sessionId: B, role: 'user', snippet: 'The Database migration fails', matches: 2 },
    ])
    expect(await index.search(projects, 'config', 10)).toEqual([
      { sessionId: A, role: 'assistant', snippet: 'Set the pool size in config.ts.', matches: 1 },
    ])
  })

  it('prefers a match at the start of a word', async () => {
    await transcript(C, jsonl(user('Is the digital signature checked before git push?')))
    const [hit] = await new SearchIndex(cacheFile, listFiles).search(projects, 'git', 10)
    expect(hit).toEqual({ sessionId: C, role: 'user', snippet: 'Is the digital signature checked before git push?', matches: 2 })
  })

  it('cuts a long message around the match, at a word, without markdown', async () => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
    await transcript(C, jsonl(assistant(`${words}The **retry** uses \`backoff\` with jitter. ${words.repeat(5)}`)))
    const [hit] = await new SearchIndex(cacheFile, listFiles).search(projects, 'backoff', 10)
    // 50 characters of context, moved to the next word, and 200 characters in all before the markdown goes.
    expect(hit).toEqual({
      sessionId: C,
      role: 'assistant',
      snippet:
        '…elit sed do eiusmod tempor The retry uses backoff with jitter. lorem ipsum dolor sit amet consectetur ' +
        'adipiscing elit sed do eiusmod tempor lorem ipsum dolor sit amet consectetur adipiscing elit…',
      matches: 1,
    })
  })

  it('reads a grown transcript from where it left off', async () => {
    const index = new SearchIndex(cacheFile, listFiles)
    expect(ids(await index.search(projects, 'pool', 10))).toEqual([A])
    // Transcripts only grow: a change before the end is not read again.
    const content = await readFile(file(A), 'utf8')
    await writeFile(file(A), content.replace('pool', 'tank') + jsonl(user('Add a cache layer')))
    later()
    expect(ids(await index.search(projects, 'cache layer', 10))).toEqual([A])
    expect(ids(await index.search(projects, 'pool', 10))).toEqual([A])
    expect(ids(await index.search(projects, 'tank', 10))).toEqual([])
  })

  it('reads a line once it is complete', async () => {
    const line = JSON.stringify(user('Pending question'))
    await appendFile(file(C), line.slice(0, 50))
    const index = new SearchIndex(cacheFile, listFiles)
    expect(ids(await index.search(projects, 'pending', 10))).toEqual([])
    await appendFile(file(C), `${line.slice(50)}\n`)
    later()
    expect(ids(await index.search(projects, 'pending', 10))).toEqual([C])
    expect(ids(await index.search(projects, 'hello', 10))).toEqual([C])
  })

  it('reads a transcript again when it was replaced', async () => {
    const index = new SearchIndex(cacheFile, listFiles)
    expect(ids(await index.search(projects, 'pool', 10))).toEqual([A])
    const { size } = await stat(file(A))
    await writeFile(file(A), jsonl(user(`Rewritten ${'x'.repeat(size)}`)))
    later()
    expect(ids(await index.search(projects, 'pool', 10))).toEqual([])
    expect(ids(await index.search(projects, 'rewritten', 10))).toEqual([A])

    await writeFile(file(A), jsonl(user('Short')))
    later()
    expect(ids(await index.search(projects, 'rewritten', 10))).toEqual([])
    expect(ids(await index.search(projects, 'short', 10))).toEqual([A])
  })

  it('forgets deleted transcripts and skips ones that vanished while listing', async () => {
    const index = new SearchIndex(cacheFile, listFiles)
    expect(ids(await index.search(projects, 'database', 10))).toEqual([B, A])
    await rm(file(B))
    later()
    expect(ids(await index.search(projects, 'database', 10))).toEqual([A])
    listFiles.mockResolvedValueOnce([{ path: file(B), sessionId: B }, { path: file(A), sessionId: A }])
    later()
    expect(ids(await index.search(projects, 'database', 10))).toEqual([A])
  })

  it('checks the transcripts for changes at most every two seconds', async () => {
    const index = new SearchIndex(cacheFile, listFiles)
    await Promise.all([index.search(projects, 'a', 10), index.search(projects, 'b', 10)])
    await index.search(projects, 'c', 10)
    expect(listFiles).toHaveBeenCalledTimes(1)
    await transcript(C, jsonl(user('Brand new')))
    expect(ids(await index.search(projects, 'brand', 10))).toEqual([])
    later()
    expect(ids(await index.search(projects, 'brand', 10))).toEqual([C])
    expect(listFiles).toHaveBeenCalledTimes(2)
  })

  it('uses the saved index for transcripts that did not change', async () => {
    const { size, mtimeMs } = await stat(file(A))
    const entry = { size, mtimeMs, offset: size, text: `${SEARCH_USER}remembered words` }
    await mkdir(join(dir, 'cache'))
    await writeFile(cacheFile, JSON.stringify({ version: 1, files: { [file(A)]: entry } }))
    const index = new SearchIndex(cacheFile, listFiles)
    expect(ids(await index.search(projects, 'remembered', 10))).toEqual([A])
    expect(ids(await index.search(projects, 'pool', 10))).toEqual([])
  })

  it('ignores a saved index of another version', async () => {
    const { size, mtimeMs } = await stat(file(A))
    const entry = { size, mtimeMs, offset: size, text: `${SEARCH_USER}remembered words` }
    await mkdir(join(dir, 'cache'))
    await writeFile(cacheFile, JSON.stringify({ version: 0, files: { [file(A)]: entry } }))
    const index = new SearchIndex(cacheFile, listFiles)
    expect(ids(await index.search(projects, 'remembered', 10))).toEqual([])
    expect(ids(await index.search(projects, 'pool', 10))).toEqual([A])
  })

  it('saves the index a few seconds after a change, with the entries of other folders', async () => {
    const elsewhere = join(dir, 'other-config', 'projects', PROJECT, `${A}.jsonl`)
    const kept = { size: 10, mtimeMs: 1, offset: 10, text: `${SEARCH_USER}elsewhere` }
    // Another account's transcript, not searched here but still there.
    await mkdir(join(dir, 'other-config', 'projects', PROJECT), { recursive: true })
    await writeFile(elsewhere, '')
    await mkdir(join(dir, 'cache'))
    await writeFile(cacheFile, JSON.stringify({ version: 1, files: { [elsewhere]: kept } }))
    const index = new SearchIndex(cacheFile, listFiles)
    await index.search(projects, 'pool', 10)
    await rm(file(C))
    later()
    await index.search(projects, 'pool', 10)

    vi.advanceTimersByTime(5000)
    const saved = await vi.waitFor(async () => {
      const data = await readJson<{ version: number; files: Record<string, { text: string; offset: number }> }>(cacheFile)
      expect(data?.files[file(A)]).toBeDefined()
      return data!
    })
    expect(saved.version).toBe(1)
    expect(Object.keys(saved.files).sort()).toEqual([file(A), file(B), elsewhere].sort())
    expect(saved.files[elsewhere]).toEqual(kept)
    expect(saved.files[file(A)]).toMatchObject({
      offset: (await stat(file(A))).size,
      text: `${SEARCH_USER}How do I size the database pool?\u0002Set the pool size in config.ts.`,
    })
  })

  it('drops the text of transcripts that are gone, also from folders it does not search', async () => {
    // E.g. of an account removed together with its folder.
    const gone = join(dir, 'removed-config', 'projects', PROJECT, `${A}.jsonl`)
    await mkdir(join(dir, 'cache'))
    await writeFile(cacheFile, JSON.stringify({ version: 1, files: { [gone]: { size: 10, mtimeMs: 1, offset: 10, text: `${SEARCH_USER}gone` } } }))
    const index = new SearchIndex(cacheFile, listFiles)
    await index.search(projects, 'pool', 10)

    const saved = await vi.waitFor(async () => {
      vi.advanceTimersByTime(5000)
      const data = await readJson<{ files: Record<string, unknown> }>(cacheFile)
      expect(data?.files[file(A)]).toBeDefined()
      return data!
    })
    expect(Object.keys(saved.files).sort()).toEqual([file(A), file(B), file(C)].sort())
  })

  it('saves a folder that keeps changing once a minute', async () => {
    const index = new SearchIndex(cacheFile, listFiles)
    await index.search(projects, 'pool', 10)
    vi.mocked(writeJsonAtomic).mockClear()
    vi.advanceTimersByTime(5000)
    expect(writeJsonAtomic).toHaveBeenCalledTimes(1)

    // A session at work: its transcript grows, and it is searched again 20 s later.
    await appendFile(file(A), jsonl(user('More about the pool')))
    vi.advanceTimersByTime(20_000)
    await index.search(projects, 'pool', 10)
    vi.advanceTimersByTime(5000)
    expect(writeJsonAtomic).toHaveBeenCalledTimes(1)
    // A minute after the first save.
    vi.advanceTimersByTime(35_000)
    expect(writeJsonAtomic).toHaveBeenCalledTimes(2)
    await vi.waitFor(async () => expect((await readJson<{ files: Record<string, { text: string }> }>(cacheFile))?.files[file(A)]?.text).toContain('More about'))
  })
})
