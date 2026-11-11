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
