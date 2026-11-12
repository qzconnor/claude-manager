import { describe, expect, it } from 'vitest'
import type { Account, AccountIdentity, ExpectedLogin } from '@shared/types'
import { expectedIdentity, isUnexpectedLogin } from './expected-login'

const EXPECTED: ExpectedLogin = {
  email: 'Me@Example.com',
  accountUuid: 'acc-1',
  organizationUuid: 'org-1',
  organizationName: "me@example.com's Organization",
}

function account(identity: Partial<AccountIdentity>, fields: Partial<Account> = {}): Account {
  return {
    id: 'a',
    name: 'A',
    kind: 'oauth',
    color: '#d97757',
    configDir: '/config/a',
    customConfigDir: false,
    defaultCwd: null,
    extraArgs: [],
    createdAt: '2026-11-06T12:00:00Z',
    hasSecret: false,
    secretHint: null,
    authState: 'ok',
    identity: { ...expectedIdentity(EXPECTED), ...identity },
    tokenExpiresAt: null,
    loginEndsAt: null,
    tokenSavedAt: null,
    renewable: false,
    expectedLogin: EXPECTED,
    ...fields,
  }
}

describe('expectedIdentity', () => {
  it('takes email and organization, leaves the rest unknown', () => {
    expect(expectedIdentity(EXPECTED)).toEqual({
      email: 'Me@Example.com',
      displayName: null,
      organizationUuid: 'org-1',
      organizationName: "me@example.com's Organization",
      organizationType: null,
      subscriptionType: null,
      rateLimitTier: null,
    })
  })
})

describe('isUnexpectedLogin', () => {
  it('accepts the expected login, email in any case', () => {
    expect(isUnexpectedLogin(account({}))).toBe(false)
    expect(isUnexpectedLogin(account({ email: 'me@EXAMPLE.com' }))).toBe(false)
  })

  it('flags another email', () => {
    expect(isUnexpectedLogin(account({ email: 'other@example.com' }))).toBe(true)
  })

  it('flags another organization of the same person', () => {
    expect(isUnexpectedLogin(account({ organizationUuid: 'org-2' }))).toBe(true)
  })

  it('accepts the email when either organization is unknown', () => {
    expect(isUnexpectedLogin(account({ organizationUuid: null }))).toBe(false)
    expect(isUnexpectedLogin(account({ organizationUuid: 'org-2' }, { expectedLogin: { ...EXPECTED, organizationUuid: null } }))).toBe(
      false,
    )
  })

  it('says nothing without an expectation, a login or an email', () => {
    expect(isUnexpectedLogin(account({ email: 'other@example.com' }, { expectedLogin: null }))).toBe(false)
    expect(isUnexpectedLogin(account({ email: 'other@example.com' }, { authState: 'missing' }))).toBe(false)
    expect(isUnexpectedLogin(account({ email: null }))).toBe(false)
  })

  it('still checks an expired login', () => {
    expect(isUnexpectedLogin(account({ email: 'other@example.com' }, { authState: 'expired' }))).toBe(true)
  })
})
