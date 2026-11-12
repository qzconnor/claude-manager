import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'
import { SessionMarks } from './session-marks'
import type { SessionNames } from './session-names'
import { SessionService } from './session-service'
import type { TerminalService } from './terminal-service'
import type { IndexedSession } from '../workers/indexer-protocol'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-marks-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const saved = () => JSON.parse(readFileSync(join(dir, 'session-marks.json'), 'utf8'))

describe('SessionMarks', () => {
  it('pins a session, tags it and reports each change once', () => {
    const marks = new SessionMarks(dir)
    marks.init()
    const changed = vi.fn()
    marks.on('changed', changed)
    expect(marks.get(ID)).toEqual({ pinned: false, tags: [] })

    marks.setPinned(ID, true)
    marks.setTags(ID, [' #Bug ', 'bug', 'Release\nnotes', '', 7])
    expect(marks.get(ID.toUpperCase())).toEqual({ pinned: true, tags: ['Bug', 'Release notes'] })
    // The same again is no news.
    marks.setPinned(ID, true)
    marks.setTags(ID, ['Bug', 'Release notes'])
    expect(changed.mock.calls).toEqual([[ID], [ID]])

    marks.setPinned(ID, false)
    expect(marks.get(ID)).toEqual({ pinned: false, tags: ['Bug', 'Release notes'] })
    expect(() => marks.setPinned('../etc', true)).toThrow('Ungültige Session-ID.')
    expect(() => marks.setTags('', [])).toThrow('Ungültige Session-ID.')
  })

  it('keeps no more than ten tags, none longer than 30 characters', () => {
    const marks = new SessionMarks(dir)
    marks.setTags(ID, [...Array.from({ length: 12 }, (_, i) => `t${i}`), 'x'.repeat(40)])
    expect(marks.get(ID).tags).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`))
    marks.setTags(OTHER, ['x'.repeat(40)])
    expect(marks.get(OTHER).tags).toEqual(['x'.repeat(30)])
  })

  it('saves only sessions with a pin or tags, and reads them again without broken entries', async () => {
    const marks = new SessionMarks(dir)
    marks.init()
    marks.setPinned(ID, true)
    marks.setTags(OTHER, ['Bug'])
    await vi.waitFor(() => expect(saved()).toEqual({ marks: { [ID]: { pinned: true }, [OTHER]: { tags: ['Bug'] } } }))
    marks.setTags(OTHER, [])
    await vi.waitFor(() => expect(saved()).toEqual({ marks: { [ID]: { pinned: true } } }))

    writeFileSync(
      join(dir, 'session-marks.json'),
      JSON.stringify({
        marks: {
          [ID.toUpperCase()]: { pinned: true, tags: ['A', 'a', 3] },
          [OTHER]: { pinned: 'ja', tags: 'Bug' },
          'kein-id': { pinned: true },
        },
      }),
    )
    const again = new SessionMarks(dir)
    again.init()
    expect(again.get(ID)).toEqual({ pinned: true, tags: ['A'] })
    expect(again.get(OTHER)).toEqual({ pinned: false, tags: [] })
    expect(again.get('kein-id')).toEqual({ pinned: false, tags: [] })
  })

  it('starts empty without a file or with a broken one', () => {
    const marks = new SessionMarks(dir)
    marks.init()
    expect(marks.get(ID)).toEqual({ pinned: false, tags: [] })
    writeFileSync(join(dir, 'session-marks.json'), '{kaputt')
    const broken = new SessionMarks(dir)
    broken.init()
    expect(broken.get(ID)).toEqual({ pinned: false, tags: [] })
  })
})

describe('SessionService with pins and tags', () => {
  function indexed(id: string): IndexedSession {
    return {
      id,
      projectKey: 'F--app',
      filePath: join(dir, `${id}.jsonl`),
      cwd: 'F:\\app',
      worktree: null,
      title: id === ID ? 'Login' : 'Other',
      firstPrompt: null,
      lastPrompt: null,
      gitBranch: null,
      model: null,
      messageCount: 2,
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-01T09:00:00.000Z',
      fileUpdatedAt: '2026-11-01T09:00:00.000Z',
      sizeBytes: 10,
      version: null,
    } as IndexedSession
  }

  it('lists them with every account and says each account changed', async () => {
    const marks = new SessionMarks(dir)
    const accounts = {
      on: () => () => undefined,
      list: () => [{ id: 'a' }, { id: 'b' }],
      paths: () => ({ projectsDir: dir }),
    } as unknown as AccountService
    const indexer = { request: async () => [indexed(ID), indexed(OTHER)] } as unknown as IndexerClient
    const names = Object.assign(new EventEmitter(), { get: () => null }) as unknown as SessionNames
    const service = new SessionService(accounts, indexer, {} as TerminalService, names, marks)
    const changed = vi.fn()
    service.on('changed', changed)

    service.pin(ID, true)
    expect(changed.mock.calls).toEqual([['a'], ['b']])
    service.tag(OTHER, ['Bug', 'Release'])
    const [group] = await service.list('a')
    expect(group?.sessions.map((s) => [s.id, s.pinned, s.tags])).toEqual([
      [ID, true, []],
      [OTHER, false, ['Bug', 'Release']],
    ])
    // A copy: changing the list doesn't change what is kept.
    group?.sessions[1]?.tags.push('x')
    expect(marks.get(OTHER).tags).toEqual(['Bug', 'Release'])
  })
})
