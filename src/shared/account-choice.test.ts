import { describe, expect, it } from 'vitest'
import { accountChoices, suggestedChoice, type AccountChoiceContext } from './account-choice'
import type { Account, AccountKind, AccountUsage, AuthState } from './types'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const LATER = '2026-11-06T15:00:00.000Z'
const EARLIER = '2026-11-06T11:00:00.000Z'

function account(id: string, kind: AccountKind, extra: { email?: string; authState?: AuthState } = {}): Account {
  return {
    id,
    name: id,
    kind,
    authState: extra.authState ?? 'ok',
    identity: { email: extra.email ?? null, organizationUuid: extra.email ? 'org' : null },
  } as Account
}

function usage(accountId: string, fiveHour: number, sevenDay: number | null = null): AccountUsage {
  const window = (key: string, percent: number) => ({ key, label: key, percent, resetsAt: null, severity: null })
  return {
    accountId,
    status: 'ok',
    fiveHour: window('five_hour', fiveHour),
    sevenDay: sevenDay === null ? null : window('seven_day', sevenDay),
  } as AccountUsage
}

function context(accounts: Account[], extra: Partial<AccountChoiceContext> = {}): AccountChoiceContext {
  return { accounts, usage: () => undefined, blocked: [], now: NOW, ...extra }
}

const ids = (choices: { account: Account }[]) => choices.map((c) => c.account.id)

describe('accountChoices with what is known of an account', () => {
  const own = account('own', 'oauth')
  const other = account('other', 'oauth')
  const token = account('token', 'token')

  it('takes the last known numbers when the latest query failed, until the window resets', () => {
    const full = { ...usage('other', 100), status: 'rate-limited' } as AccountUsage
    const reset = { ...full, fiveHour: { ...full.fiveHour!, resetsAt: EARLIER } } as AccountUsage
    const offline = { ...usage('token', 100), status: 'error', fiveHour: { ...usage('token', 100).fiveHour!, resetsAt: LATER } } as AccountUsage
    const choices = accountChoices(context([own, other, token], { usage: (id) => (id === 'other' ? full : id === 'token' ? offline : undefined) }), 'own', 'own')
    expect(choices.map((c) => [c.account.id, c.limited])).toEqual([
      ['other', true],
      ['token', true],
    ])
    expect(suggestedChoice(choices)).toBeUndefined()
    const later = accountChoices(context([own, other], { usage: () => reset }), 'own', 'own')
    expect(later[0]!.limited).toBe(false)
  })

  it('counts a token Anthropic refuses, and an account without credentials, as logged out', () => {
    const refused = { ...usage('token', 10), status: 'unauthorized' } as AccountUsage
    const gone = { ...usage('other', 10), status: 'no-credentials' } as AccountUsage
    const choices = accountChoices(context([own, other, token], { usage: (id) => (id === 'token' ? refused : gone) }), 'own', 'own')
    expect(choices.every((c) => c.disabled)).toBe(true)
    // A browser login without permission for the usage API can still work.
    const forbidden = { ...usage('other', 10), status: 'unauthorized' } as AccountUsage
    expect(accountChoices(context([own, other], { usage: () => forbidden }), 'own', 'own')[0]!.disabled).toBe(false)
  })
})

describe('accountChoices', () => {
  const own = account('own', 'oauth')
  const other = account('other', 'oauth')
  const token = account('token', 'token')
  const key = account('key', 'apiKey')

  it('leaves out the current account and puts lenders first, then browser logins', () => {
    const choices = accountChoices(context([own, other, token, key]), 'own', 'own')
    expect(ids(choices)).toEqual(['token', 'key', 'other'])
    expect(choices.map((c) => c.copies)).toEqual([false, false, true])
  })

  it('does not copy back to the account that holds the session', () => {
    const choices = accountChoices(context([own, other, token]), 'own', 'token')
    expect(ids(choices)).toEqual(['own', 'other'])
    expect(choices.find((c) => c.account.id === 'own')?.copies).toBe(false)
  })

  it('puts accounts at a limit and logged-out accounts last', () => {
    const out = account('out', 'token', { authState: 'missing' })
    const choices = accountChoices(
      context([own, out, other, token], {
        usage: (id) => (id === 'token' ? usage('token', 100) : id === 'other' ? usage('other', 40, 70) : undefined),
      }),
      'own',
      'own',
    )
    expect(ids(choices)).toEqual(['other', 'out', 'token'])
    expect(choices.map((c) => c.standing)).toEqual([
      { kind: 'usage', label: 'Woche', percent: 70 },
      { kind: 'logged-out' },
      { kind: 'usage', label: '5 Std.', percent: 100 },
    ])
    expect(choices.map((c) => [c.limited, c.disabled])).toEqual([
      [false, false],
      [false, true],
      [true, false],
    ])
  })

  it('counts an account as limited while a session stopped at its limit, until the reset', () => {
    const blocked = [
      { accountId: 'token', resetsAt: LATER },
      { accountId: 'key', resetsAt: EARLIER },
    ]
    const choices = accountChoices(context([own, token, key], { blocked }), 'own', 'own')
    expect(choices.map((c) => [c.account.id, c.standing.kind, c.limited])).toEqual([
      ['key', 'pay-per-use', false],
      ['token', 'blocked', true],
    ])
  })

  it('blocks an account without a known reset until it is forgotten', () => {
    const choices = accountChoices(context([own, token], { blocked: [{ accountId: 'token', resetsAt: null }] }), 'own', 'own')
    expect(choices[0].standing).toEqual({ kind: 'blocked', resetsAt: null })
  })

  it('blocks accounts with the same login along', () => {
    const standard = account('system', 'system', { email: 'me@example.com' })
    const twin = account('twin', 'oauth', { email: 'ME@example.com' })
    const stranger = account('stranger', 'oauth', { email: 'you@example.com' })
    const choices = accountChoices(
      context([standard, twin, stranger], { blocked: [{ accountId: 'twin', resetsAt: LATER }] }),
      'twin',
      'twin',
    )
    expect(choices.map((c) => [c.account.id, c.limited])).toEqual([
      ['stranger', false],
      ['system', true],
    ])
  })

  it('knows nothing without any numbers', () => {
    const choices = accountChoices(
      context([own, other], { usage: () => ({ ...usage('other', 100), status: 'error', fiveHour: null }) as AccountUsage }),
      'own',
      'own',
    )
    expect(choices[0]).toMatchObject({ standing: { kind: 'unknown' }, limited: false })
  })
})

describe('suggestedChoice', () => {
  it('takes the first account that is logged in and not at a limit', () => {
    const own = account('own', 'oauth')
    const token = account('token', 'token')
    const other = account('other', 'oauth')
    const choices = accountChoices(context([own, token, other], { usage: (id) => (id === 'token' ? usage(id, 100) : undefined) }), 'own', 'own')
    expect(suggestedChoice(choices)?.account.id).toBe('other')
    expect(suggestedChoice(choices.filter((c) => c.account.id === 'token'))).toBeUndefined()
  })
})
