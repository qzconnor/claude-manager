import type { AccountIdentity } from '@shared/types'
import { isPersonalOrganizationName } from '@shared/utils'

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' })
const dateTime = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' })
const time = new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat('de', { day: 'numeric', month: 'short' })
const dayMonthYear = new Intl.DateTimeFormat('de', { day: 'numeric', month: 'short', year: 'numeric' })
const weekdayTime = new Intl.DateTimeFormat('de', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const compact = new Intl.NumberFormat('de', { notation: 'compact', maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('de')
const oneDecimal = new Intl.NumberFormat('de', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const dollars = new Intl.NumberFormat('de', { style: 'currency', currency: 'USD' })
const wholeDollars = new Intl.NumberFormat('de', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })

/** Midnight of the day `ms` falls on, in local time. */
function startOfDay(ms: number): number {
  const day = new Date(ms)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * "vor 5 Minuten", "gestern", from 30 days on the date. A unit is used while its rounded count stays
 * below the next one: 59.6 minutes are "vor 1 Stunde", 23.6 hours a day. Days go by the calendar:
 * Monday 23:59 is "vorgestern" on Wednesday morning, Tuesday 00:00 "gestern" on Wednesday night.
 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '–'
  const diff = (ms - now) / 1000
  // Both ways: a time just past can lie a little ahead of a clock that ticks every 30 seconds.
  if (Math.abs(diff) < 45) return 'gerade eben'
  const minutes = Math.round(diff / 60)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  const hours = Math.round(diff / 3600)
  // Rounded so that a day with a clock change (23 or 25 hours) counts as one.
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000)
  // Nearly a day, but still today: in hours.
  if (Math.abs(hours) < 24 || days === 0) return rtf.format(hours, 'hour')
  if (Math.abs(days) < 30) return rtf.format(days, 'day')
  return dateTime.format(ms)
}

/** A time ahead, like the next fetch: "gleich" within 45 seconds, otherwise as `formatRelative`. */
export function formatUpcoming(iso: string | null | undefined, now = Date.now()): string {
  const ahead = iso ? Date.parse(iso) - now : NaN
  return ahead >= 0 && ahead < 45_000 ? 'gleich' : formatRelative(iso, now)
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–'
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '–' : dateTime.format(ms)
}

/**
 * Short, for a card: within the last week relative ("vor 3 Stunden", "gestern"), before that the day
 * ("16. Sept."), with the year only when it isn't this one.
 */
export function formatShortDate(iso: string | null | undefined, now = Date.now()): string {
  const ms = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) return '–'
  if (Math.abs(Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)) < 7) return formatRelative(iso, now)
  return (new Date(ms).getFullYear() === new Date(now).getFullYear() ? dayMonth : dayMonthYear).format(ms)
}

/**
 * From when to when something ran: "06.11.2026, 09:10 – 13:00" within a day (by local time), else both
 * ends in full. One time when both are the same.
 */
export function formatPeriod(start: string | null | undefined, end: string | null | undefined): string {
  const from = start ? Date.parse(start) : NaN
  const to = end ? Date.parse(end) : NaN
  if (Number.isNaN(from) || Number.isNaN(to)) return formatDateTime(Number.isNaN(from) ? end : start)
  if (dateTime.format(from) === dateTime.format(to)) return dateTime.format(from)
  return `${dateTime.format(from)} – ${(startOfDay(from) === startOfDay(to) ? time : dateTime).format(to)}`
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
  const when = diff < 86400000 ? time.format(ms) : weekdayTime.format(ms)
  return `in ${formatDuration(diff)} · ${when}`
}

/**
 * What is left until `iso`, as a clock counts down: "0:05", "12:34", "1:02:03", from a day on
 * "2 T. 4:03:10". "0:00" once it has come.
 */
export function formatCountdown(iso: string, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) || 0
  const days = Math.floor(left / 86400)
  const hours = Math.floor((left % 86400) / 3600)
  const minutes = Math.floor((left % 3600) / 60)
  const seconds = String(left % 60).padStart(2, '0')
  if (days) return `${days} T. ${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** A span like "2 Std. 13 Min." or "3 T. 4 Std." (minutes only below a day). */
export function formatDuration(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days} T.`)
  if (hours) parts.push(`${hours} Std.`)
  if (!days && mins) parts.push(`${mins} Min.`)
  return parts.join(' ') || '< 1 Min.'
}

export function formatTokens(value: number): string {
  return value < 10000 ? integer.format(value) : compact.format(value)
}

export function formatNumber(value: number): string {
  return integer.format(value)
}

/** US dollars, the German way: with cents below 100 $, less than a cent as "< 0,01 $". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return `< ${dollars.format(0.01)}`
  return (usd >= 100 ? wholeDollars : dollars).format(usd)
}

/** Sizes with German digits; a value that rounds up to the next unit is shown in it (1,0 MB, not 1024 KB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${integer.format(bytes)} B`
  const kb = Math.round(bytes / 1024)
  if (kb < 1024) return `${integer.format(kb)} KB`
  const mb = Math.round((bytes / 1024 ** 2) * 10) / 10
  if (mb < 1024) return `${oneDecimal.format(mb)} MB`
  return `${oneDecimal.format(bytes / 1024 ** 3)} GB`
}

/**
 * Writes the home folder as `~`, only for the folder itself and paths inside it (not `…\conno2` for
 * `…\conno`). Windows paths compare without regard to case, others with.
 */
export function shortenPath(path: string | null | undefined, home?: string | null): string {
  if (!path) return '–'
  if (home) {
    const windows = /^[a-z]:[\\/]/i.test(home)
    const head = path.slice(0, home.length)
    const rest = path.slice(home.length)
    const inside = rest === '' || /^[\\/]/.test(rest) || /[\\/]$/.test(home)
    if (inside && (windows ? head.toLowerCase() === home.toLowerCase() : head === home)) return `~${rest}`
  }
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
