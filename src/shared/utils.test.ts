import { describe, expect, it } from 'vitest'
import { SYSTEM_ACCOUNT_ID } from './defaults'
import type { Account, AccountIdentity, AccountKind } from './types'
import {
  canLendCredentials,
  foldCase,
  isPersonalOrganizationName,
  isPlainObject,
  limitLabel,
  maskSecret,
  mergeKnown,
  searchTerms,
  standardTwin,
} from './utils'

describe('isPlainObject', () => {
  it('accepts objects, rejects arrays, null and primitives', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ a: 1 })).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(undefined)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
    expect(isPlainObject(1)).toBe(false)
  })
})

describe('mergeKnown', () => {
  const base = () => ({
    name: 'a',
    size: 14,
    on: true,
    nullable: null as string | null,
    list: ['x'],
    nested: { deep: { value: 1, other: 2 }, flag: false },
  })

  it('returns the base unchanged when either side is not an object', () => {
    const b = base()
    expect(mergeKnown(b, null)).toBe(b)
    expect(mergeKnown(b, 'patch')).toBe(b)
    expect(mergeKnown(b, [1, 2])).toBe(b)
    expect(mergeKnown('base', { a: 1 })).toBe('base')
  })

  it('merges nested objects without touching the base', () => {
    const b = base()
    const merged = mergeKnown(b, { size: 16, nested: { deep: { value: 5 } } })
    expect(merged).toEqual({ ...base(), size: 16, nested: { deep: { value: 5, other: 2 }, flag: false } })
    expect(b).toEqual(base())
    expect(merged).not.toBe(b)
    expect(merged.nested).not.toBe(b.nested)
  })

  it('drops keys the base does not know, at every level', () => {
    const merged = mergeKnown(base(), { unknown: 1, nested: { stale: true, deep: { gone: 3 } } })
    expect(merged).toEqual(base())
    expect('unknown' in merged).toBe(false)
  })

  it('ignores a __proto__ key in the patch', () => {
    const merged = mergeKnown(base(), JSON.parse('{"__proto__": {"polluted": true}, "size": 20}'))
    expect(merged.size).toBe(20)
    expect((merged as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('ignores undefined and values of another type', () => {
    expect(mergeKnown(base(), { name: undefined, size: '16', on: 'yes', nested: 'flat' })).toEqual(base())
  })

  it('replaces arrays with a copy and ignores non-arrays for them', () => {
    const list = ['y', 'z']
    const merged = mergeKnown(base(), { list })
    expect(merged.list).toEqual(['y', 'z'])
    expect(merged.list).not.toBe(list)
    expect(mergeKnown(base(), { list: 'y' }).list).toEqual(['x'])
  })

  it('lets null replace a value and a value replace null', () => {
    expect(mergeKnown(base(), { nullable: 'set' }).nullable).toBe('set')
    expect(mergeKnown({ ...base(), nullable: 'set' }, { nullable: null }).nullable).toBeNull()
  })

  it('keeps a nested object when the patch sets it to null', () => {
    expect(mergeKnown(base(), { nested: null }).nested).toEqual(base().nested)
  })
})

describe('maskSecret', () => {
  it('hides short secrets completely', () => {
    expect(maskSecret('')).toBe('••••')
    expect(maskSecret('123456789012')).toBe('••••')
    expect(maskSecret('  123456789012  ')).toBe('••••')
  })

  it('keeps the Anthropic prefix and the last 4 characters', () => {
    expect(maskSecret('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz-a1b2')).toBe('sk-ant-oat01-…a1b2')
    expect(maskSecret('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ9z8y')).toBe('sk-ant-api03-…9z8y')
  })

  it('keeps the first 4 characters of other secrets', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd…mnop')
  })

  it('trims whitespace around the secret', () => {
    expect(maskSecret('  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz-a1b2\n')).toBe('sk-ant-oat01-…a1b2')
  })
})

describe('canLendCredentials', () => {
  it('lends tokens and API keys, not browser logins', () => {
    expect(canLendCredentials('token')).toBe(true)
    expect(canLendCredentials('apiKey')).toBe(true)
    expect(canLendCredentials('oauth')).toBe(false)
    expect(canLendCredentials('system')).toBe(false)
  })
})

describe('foldCase', () => {
  it('lower-cases, umlauts included', () => {
    expect(foldCase('ÄÖÜ Straße MIXED')).toBe('äöü straße mixed')
  })

  it('keeps the length, even for a dotted capital I', () => {
    const text = 'İstanbul İzmir'
    expect(foldCase(text)).toBe('istanbul izmir')
    expect(foldCase(text)).toHaveLength(text.length)
  })
})

describe('searchTerms', () => {
  it('splits on any whitespace, folds case and drops duplicates', () => {
    expect(searchTerms('  Foo\tbar\n FOO  baz ')).toEqual(['foo', 'bar', 'baz'])
  })

  it('returns nothing for a blank query', () => {
    expect(searchTerms('')).toEqual([])
    expect(searchTerms(' \t\n ')).toEqual([])
  })

  it('keeps at most 8 terms', () => {
    expect(searchTerms('a b c d e f g h i j')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  })
})

describe('isPersonalOrganizationName', () => {
  it("recognizes \"<email>'s Organization\", ignoring case", () => {
    expect(isPersonalOrganizationName("name@example.com's Organization")).toBe(true)
    expect(isPersonalOrganizationName("NAME@EXAMPLE.COM'S ORGANIZATION")).toBe(true)
  })

  it('rejects other names', () => {
    expect(isPersonalOrganizationName('Acme Organization')).toBe(false)
    expect(isPersonalOrganizationName("Acme's Organization Ltd")).toBe(false)
    expect(isPersonalOrganizationName('')).toBe(false)
  })
})

describe('limitLabel', () => {
  it('names the known limits', () => {
    expect(limitLabel('five_hour')).toBe('5-Stunden-Limit')
    expect(limitLabel('seven_day')).toBe('Wochenlimit')
    expect(limitLabel('seven_day_opus')).toBe('Wochenlimit für Opus')
    expect(limitLabel('seven_day_sonnet')).toBe('Wochenlimit für Sonnet')
  })

  it('falls back to a generic name', () => {
    expect(limitLabel(null)).toBe('Nutzungslimit')
    expect(limitLabel('something_new')).toBe('Nutzungslimit')
  })
})

describe('standardTwin', () => {
  function identity(email: string | null, organizationUuid: string | null = 'org-1'): AccountIdentity {
    return {
      email,
      displayName: null,
      organizationUuid,
      organizationName: null,
      organizationType: null,
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  function account(id: string, kind: AccountKind, ident: AccountIdentity): Account {
    return {
      id,
      name: id,
      kind,
      color: '#d97757',
      configDir: `/config/${id}`,
      customConfigDir: false,
      defaultCwd: null,
      extraArgs: [],
      createdAt: '2026-11-06T12:00:00Z',
      hasSecret: false,
      secretHint: null,
      authState: 'ok',
      identity: ident,
      tokenExpiresAt: null,
      expectedLogin: null,
    }
  }

  const standard = account(SYSTEM_ACCOUNT_ID, 'system', identity('Me@Example.com'))

  it('finds the browser login with the same email (any case) and organization', () => {
    const twin = account('b', 'oauth', identity('me@example.COM'))
    expect(standardTwin([account('a', 'oauth', identity('other@example.com')), standard, twin])).toBe(twin)
  })

  it('treats two missing organizations as the same', () => {
    const twin = account('b', 'oauth', identity('me@example.com', null))
    expect(standardTwin([account(SYSTEM_ACCOUNT_ID, 'system', identity('me@example.com', null)), twin])).toBe(twin)
  })

  it('ignores another organization of the same person', () => {
    expect(standardTwin([standard, account('b', 'oauth', identity('me@example.com', 'org-2'))])).toBeUndefined()
  })

  it('ignores setup tokens and API keys with the same login', () => {
    const accounts = [standard, account('t', 'token', identity('me@example.com')), account('k', 'apiKey', identity('me@example.com'))]
    expect(standardTwin(accounts)).toBeUndefined()
  })

  it('finds nothing without an email or without the standard account', () => {
    expect(standardTwin([account(SYSTEM_ACCOUNT_ID, 'system', identity(null)), account('b', 'oauth', identity(null))])).toBeUndefined()
    expect(standardTwin([account('b', 'oauth', identity('me@example.com'))])).toBeUndefined()
    expect(standardTwin([])).toBeUndefined()
  })
})
