import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

import type { AccountService } from './account-service'
import type { IndexerClient } from './indexer-client'
import type { SessionNames } from './session-names'
import { SessionService } from './session-service'
import type { TerminalService } from './terminal-service'
import type { IndexedSession } from '../workers/indexer-protocol'

/** Accounts with a projects folder each; `changed` as the account service sends it, also for a new token. */
class FakeAccounts extends EventEmitter {
  dirs = new Map<string, string>()
  list() {
    return [...this.dirs.keys()].map((id) => ({ id }))
  }
  paths(id: string) {
    return { projectsDir: this.dirs.get(id) ?? '' }
  }
}

let root: string
let accounts: FakeAccounts
let service: SessionService
let reported: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-service-'))
  accounts = new FakeAccounts()
  accounts.dirs.set('a', join(root, 'a', 'projects'))
  accounts.dirs.set('b', join(root, 'b', 'projects'))
  service = new SessionService(
    accounts as unknown as AccountService,
    {} as IndexerClient,
    {} as TerminalService,
    new EventEmitter() as unknown as SessionNames,
  )
  service.init()
  reported = []
  service.on('changed', (id) => reported.push(id))
})

afterEach(() => {
  service.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('SessionService: accounts', () => {
  it('reports an account that came, went or keeps its sessions elsewhere now', () => {
    // Nothing that changes the lists (a new token, another name).
    accounts.emit('changed')
    expect(reported).toEqual([])

    // With an existing folder its sessions are there at once, without a change the watcher would see.
    accounts.dirs.set('c', join(root, 'c', 'projects'))
    accounts.emit('changed')
    expect(reported).toEqual(['c'])

    accounts.dirs.delete('b')
    accounts.emit('changed')
    expect(reported).toEqual(['c', 'b'])

    accounts.dirs.set('a', join(root, 'elsewhere', 'projects'))
    accounts.emit('changed')
    expect(reported).toEqual(['c', 'b', 'a'])
  })
})

describe('SessionService: sessions that changed a file', () => {
  const session = (id: string, cwd: string): IndexedSession => ({
    id,
    cwd,
    worktree: null,
    title: id,
    firstPrompt: null,
    lastPrompt: null,
    gitBranch: null,
    model: null,
    messageCount: 3,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    version: null,
    continuedIn: null,
    projectKey: 'p',
    filePath: join(root, `${id}.jsonl`),
    sizeBytes: 10,
    fileUpdatedAt: '2026-11-02T00:00:00.000Z',
  })

  it('lists them across accounts, a shared folder once, the latest change first', async () => {
    accounts.dirs.set('c', accounts.dirs.get('a')!)
    const asked: unknown[] = []
    const indexer = {
      request: async (request: { method: string; projectsDir: string; path: string }) => {
        asked.push(request)
        if (request.projectsDir === accounts.dirs.get('b')) throw new Error('kaputt')
        return [
          { session: session('s1', '/f/Projekte/App'), at: '2026-11-05T10:00:00.000Z' },
          { session: session('s2', 'F:\Projekte\App'), at: '2026-11-06T10:00:00.000Z' },
        ]
      },
    }
    const names = Object.assign(new EventEmitter(), { get: (id: string) => (id === 's2' ? 'Benannt' : undefined) })
    const files = new SessionService(
      accounts as unknown as AccountService,
      indexer as unknown as IndexerClient,
      {} as TerminalService,
      names as unknown as SessionNames,
    )

    const edits = await files.editedBy('F:\Projekte\App\a.ts')
    expect(asked).toEqual([
      { method: 'editedBy', projectsDir: accounts.dirs.get('a'), path: 'F:\Projekte\App\a.ts' },
      { method: 'editedBy', projectsDir: accounts.dirs.get('b'), path: 'F:\Projekte\App\a.ts' },
    ])
    expect(edits.map((e) => [e.session.accountId, e.session.id, e.session.title, e.changedAt])).toEqual([
      ['a', 's2', 'Benannt', '2026-11-06T10:00:00.000Z'],
      ['a', 's1', 's1', '2026-11-05T10:00:00.000Z'],
    ])
    files.dispose()
  })

  it('shows no more than 50', async () => {
    accounts.dirs.delete('b')
    const many = Array.from({ length: 60 }, (_, i) => ({
      session: session(`s${i}`, '/x'),
      at: `2026-11-05T10:${String(i).padStart(2, '0')}:00.000Z`,
    }))
    const files = new SessionService(
      accounts as unknown as AccountService,
      { request: async () => many } as unknown as IndexerClient,
      {} as TerminalService,
      Object.assign(new EventEmitter(), { get: () => undefined }) as unknown as SessionNames,
    )
    const edits = await files.editedBy('/x/a.ts')
    expect(edits).toHaveLength(50)
    expect(edits[0].session.id).toBe('s59')
    expect(edits[49].session.id).toBe('s10')
    files.dispose()
  })
})
