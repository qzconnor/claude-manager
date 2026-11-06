import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Account } from '@shared/types'
import { claudePaths } from '../lib/claude-paths'
import { claudeInChromeStatus, connectsClaudeInChrome, envFlag } from './claude-in-chrome'

describe('connectsClaudeInChrome', () => {
  it('follows "Enabled by default" for claude.ai logins', () => {
    expect(connectsClaudeInChrome({ kind: 'system' }, { claudeInChromeDefaultEnabled: true })).toBe(true)
    expect(connectsClaudeInChrome({ kind: 'oauth' }, { claudeInChromeDefaultEnabled: true })).toBe(true)
    expect(connectsClaudeInChrome({ kind: 'oauth' }, { claudeInChromeDefaultEnabled: false })).toBe(false)
    expect(connectsClaudeInChrome({ kind: 'oauth' }, {})).toBe(false)
    expect(connectsClaudeInChrome({ kind: 'oauth' }, null)).toBe(false)
  })

  it('never counts token and API key accounts, which cannot connect', () => {
    expect(connectsClaudeInChrome({ kind: 'token' }, { claudeInChromeDefaultEnabled: true })).toBe(false)
    expect(connectsClaudeInChrome({ kind: 'apiKey' }, { claudeInChromeDefaultEnabled: true })).toBe(false)
  })
})

describe('envFlag', () => {
  it('reads the usual spellings', () => {
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'on']) expect(envFlag(on)).toBe(true)
    for (const off of ['0', 'false', 'no', 'off']) expect(envFlag(off)).toBe(false)
    for (const neither of [undefined, '', 'maybe']) expect(envFlag(neither)).toBeUndefined()
  })
})

describe('claudeInChromeStatus', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function source(configs: Record<string, object | null>, kinds: Record<string, Account['kind']> = {}) {
    dir = mkdtempSync(join(tmpdir(), 'cic-'))
    const accounts = Object.keys(configs).map((id) => ({ id, name: `Name ${id}`, kind: kinds[id] ?? 'oauth' }) as Account)
    for (const [id, config] of Object.entries(configs)) {
      if (config) writeFileSync(join(dir, `${id}.json`), JSON.stringify(config))
    }
    return {
      list: () => accounts,
      paths: (id: string) => ({ ...claudePaths(join(dir, id), true), globalConfigFile: join(dir, `${id}.json`) }),
    }
  }

  it('names the accounts that connect by default', () => {
    const accounts = source({ a: { claudeInChromeDefaultEnabled: true }, b: { claudeInChromeDefaultEnabled: false }, c: null })
    expect(claudeInChromeStatus(accounts, {})).toEqual({ accounts: [{ id: 'a', name: 'Name a' }], env: false })
  })

  it('lets CLAUDE_CODE_ENABLE_CFC decide for every account', () => {
    const accounts = source({ a: { claudeInChromeDefaultEnabled: true } })
    expect(claudeInChromeStatus(accounts, { CLAUDE_CODE_ENABLE_CFC: '1' })).toEqual({ accounts: [], env: true })
    expect(claudeInChromeStatus(accounts, { CLAUDE_CODE_ENABLE_CFC: '0' })).toEqual({ accounts: [], env: false })
  })
})
