import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'
import { SessionMarks } from './session-marks'
import { SessionNames } from './session-names'
import { SessionService } from './session-service'
import type { TerminalService } from './terminal-service'
import type { IndexedSession } from '../workers/indexer-protocol'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

describe('SessionNames', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-names-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps a name on one line, reports it and takes it away again', () => {
    const names = new SessionNames(dir)
    names.init()
    const changed = vi.fn()
    names.on('changed', changed)

    names.set(ID, '  Login\n bauen ')
    expect(names.get(ID)).toBe('Login bauen')
    expect(names.get(ID.toUpperCase())).toBe('Login bauen')
    // The same name again is no news.
    names.set(ID, 'Login bauen')
    names.set(ID, ' ')
    expect(names.get(ID)).toBeNull()
    expect(changed.mock.calls).toEqual([
      [ID, 'Login bauen'],
      [ID, null],
    ])
    expect(() => names.set('../etc', 'x')).toThrow('Ungültige Session-ID.')
  })

  it('reads the names it saved and skips broken entries', async () => {
    const names = new SessionNames(dir)
    names.init()
    names.set(ID, 'Backend')
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dir, 'session-names.json'), 'utf8'))).toEqual({ names: { [ID]: 'Backend' } }))

    writeFileSync(join(dir, 'session-names.json'), JSON.stringify({ names: { [ID]: 'Backend', [OTHER]: 3, 'kein-id': 'x' } }))
    const again = new SessionNames(dir)
    again.init()
    expect(again.get(ID)).toBe('Backend')
    expect(again.get(OTHER)).toBeNull()
  })
})

describe('SessionService with names', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-names-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function indexed(id: string, title: string): IndexedSession {
    return {
      id,
      projectKey: 'F--app',
      filePath: join(dir, `${id}.jsonl`),
      cwd: 'F:\\app',
      worktree: null,
      title,
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

  it('shows the name over the title Claude Code gives the session, also a new one', async () => {
    const names = new SessionNames(dir)
    names.init()
    let claudeTitle = 'Fix login bug'
    const accounts = {
      on: () => () => undefined,
      list: () => [{ id: 'a' }],
      paths: () => ({ projectsDir: dir }),
    } as unknown as AccountService
    const indexer = {
      request: async () => [indexed(ID, claudeTitle), indexed(OTHER, 'Other')],
    } as unknown as IndexerClient
    const service = new SessionService(accounts, indexer, {} as TerminalService, names, new SessionMarks(dir))
    const changed = vi.fn()
    service.on('changed', changed)

    service.rename(ID, 'Login')
    expect(changed).toHaveBeenCalledWith('a')
    claudeTitle = 'A title Claude made up later'
    const [group] = await service.list()
    expect(group?.sessions.map((s) => [s.id, s.title, s.name])).toEqual([
      [ID, 'Login', 'Login'],
      [OTHER, 'Other', null],
    ])

    service.rename(ID, '')
    const [after] = await service.list()
    expect(after?.sessions[0]).toMatchObject({ title: 'A title Claude made up later', name: null })
  })
})
