import type { AccountIdentity } from '@shared/types'
import { isPersonalOrganizationName } from '@shared/utils'

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' })
const dateTime = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' })
const time = new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit' })
const weekdayTime = new Intl.DateTimeFormat('de', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const compact = new Intl.NumberFormat('de', { notation: 'compact', maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('de')

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '–'
  const diff = (ms - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'gerade eben'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return dateTime.format(ms)
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–'
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '–' : dateTime.format(ms)
}

/** Clock time, with the weekday when it is more than a day away (e.g. "19:40", "Mo., 04:00"). */
export function formatClock(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '–'
  return Math.abs(ms - now) < 86400000 ? time.format(ms) : weekdayTime.format(ms)
}

/** "in 2 Std. 13 Min." style countdown plus the clock time, e.g. for limit resets. */
export function formatReset(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'unbekannt'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return 'unbekannt'
  const diff = ms - now
  if (diff <= 0) return 'jetzt'
  const minutes = Math.round(diff / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days} T.`)
  if (hours) parts.push(`${hours} Std.`)
  if (!days && mins) parts.push(`${mins} Min.`)
  const when = diff < 86400000 ? time.format(ms) : weekdayTime.format(ms)
  return `in ${parts.join(' ') || '< 1 Min.'} · ${when}`
}

export function formatTokens(value: number): string {
  return value < 10000 ? integer.format(value) : compact.format(value)
}

export function formatNumber(value: number): string {
  return integer.format(value)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function shortenPath(path: string | null | undefined, home?: string | null): string {
  if (!path) return '–'
  if (home && path.toLowerCase().startsWith(home.toLowerCase())) return `~${path.slice(home.length)}`
  return path
}

export function accountKindLabel(kind: string): string {
  switch (kind) {
    case 'system':
      return 'Standard-Login'
    case 'oauth':
      return 'OAuth-Login'
    case 'token':
      return 'Long-lived Token'
    case 'apiKey':
      return 'API-Key'
    default:
      return kind
  }
}

/** „Persönlich“ for a personal plan, otherwise the organization of the login, e.g. a team. */
export function organizationLabel(identity: AccountIdentity): string | null {
  const { organizationName: name, organizationType: type } = identity
  if (type === 'claude_pro' || type === 'claude_max') return 'Persönlich'
  if (!name) return null
  if (type === 'claude_team' || type === 'claude_enterprise') return name
  return isPersonalOrganizationName(name) ? 'Persönlich' : name
}

/** e.g. „name@firma.de · Persönlich“: tells two logins with the same email apart. */
export function identityLabel(identity: AccountIdentity): string | null {
  return [identity.email, organizationLabel(identity)].filter(Boolean).join(' · ') || null
}

export function planLabel(subscriptionType: string | null | undefined): string | null {
  if (!subscriptionType) return null
  const map: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' }
  return map[subscriptionType.toLowerCase()] ?? subscriptionType
}
