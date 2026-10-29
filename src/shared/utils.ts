import type { AccountKind } from './types'

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

/** Masks a secret for display: keeps a recognizable prefix and the last 4 characters. */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim()
  if (trimmed.length <= 12) return '••••'
  const prefixMatch = /^(sk-ant-[a-z]+\d*-)/.exec(trimmed)
  const prefix = prefixMatch ? prefixMatch[1] : trimmed.slice(0, 4)
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

/** Personal organizations are named "<email>'s Organization". */
export function isPersonalOrganizationName(name: string): boolean {
  return /'s Organization$/i.test(name)
}
