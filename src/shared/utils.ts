import { SYSTEM_ACCOUNT_ID } from './defaults'
import type { Account, AccountIdentity, AccountKind } from './types'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively merges `patch` into `base` and returns a new object.
 * Arrays and primitives in `patch` replace the value in `base`; `undefined` is ignored.
 * Keys that don't exist in `base` are dropped, so stale or unknown settings never leak in.
 */
export function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(base)) {
    if (!(key in patch)) continue
    const next = patch[key]
    const current = (base as Record<string, unknown>)[key]
    if (next === undefined) continue
    if (isPlainObject(current)) {
      out[key] = mergeKnown(current, next)
    } else if (Array.isArray(current)) {
      if (Array.isArray(next)) out[key] = [...next]
    } else if (current === null || next === null || typeof next === typeof current) {
      out[key] = next
    }
  }
  return out as T
}

/** Characters of a secret that stay hidden at least; with fewer, prefix and end would give it away. */
const MIN_HIDDEN = 8

/**
 * Masks a secret for display: keeps a recognizable prefix and the last 4 characters. The Anthropic
 * prefix (`sk-ant-oat01-`) only tells the kind of key, so it stays even when the rest is hidden.
 */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim()
  const anthropic = /^(sk-ant-[a-z]+\d*-)/.exec(trimmed)?.[1]
  const prefix = anthropic ?? trimmed.slice(0, 4)
  if (trimmed.length - prefix.length - 4 < MIN_HIDDEN) return anthropic ? `${anthropic}••••` : '••••'
  return `${prefix}…${trimmed.slice(-4)}`
}

/**
 * Whether a session in another account's config dir can run with this account's credentials.
 * Tokens and API keys travel through the environment; a browser login only works in its own
 * config dir, where Claude Code can refresh it — sessions are copied there instead.
 */
export function canLendCredentials(kind: AccountKind): boolean {
  return kind === 'token' || kind === 'apiKey'
}

/**
 * Lower case for the session search, the same in the window and in the indexer. Keeps the length,
 * so positions found in the result also hold in the original text: only İ would grow
 * (to i and a combining dot), it becomes a plain i.
 */
export function foldCase(text: string): string {
  return text.replaceAll('İ', 'i').toLowerCase()
}

/** The words of a search query in lower case; a match has to contain every one of them. */
export function searchTerms(query: string): string[] {
  return [...new Set(foldCase(query).split(/\s+/).filter(Boolean))].slice(0, 8)
}

/** Personal organizations are named "<email>'s Organization". */
export function isPersonalOrganizationName(name: string): boolean {
  return /'s Organization$/i.test(name)
}

/** Name of a limit Claude Code reports (`rateLimitType`). */
export function limitLabel(type: string | null): string {
  switch (type) {
    case 'five_hour':
      return '5-Stunden-Limit'
    case 'seven_day':
      return 'Wochenlimit'
    case 'seven_day_opus':
      return 'Wochenlimit für Opus'
    case 'seven_day_sonnet':
      return 'Wochenlimit für Sonnet'
    default:
      return 'Nutzungslimit'
  }
}

/**
 * The browser login account with the same login as the standard account. Account switchers
 * like cswap log ~/.claude into one of the other accounts, so the standard account would show
 * the same limits twice. Setup tokens don't count: they can't read the limits.
 */
export function standardTwin(accounts: Account[]): Account | undefined {
  const standard = accounts.find((a) => a.id === SYSTEM_ACCOUNT_ID)
  return standard ? accounts.find((a) => a.kind === 'oauth' && sameLogin(a.identity, standard.identity)) : undefined
}

function sameLogin(a: AccountIdentity, b: AccountIdentity): boolean {
  return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase() && a.organizationUuid === b.organizationUuid
}
