import { describe, expect, it } from 'vitest'
import type { AccountIdentity } from '@shared/types'
import {
  accountKindLabel,
  formatBytes,
  formatClock,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatReset,
  formatTokens,
  identityLabel,
  organizationLabel,
  planLabel,
  shortenPath,
} from './format'

// Friday, 13:00 in Berlin (CET).
const NOW = Date.parse('2026-11-06T12:00:00Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offset: number) => new Date(NOW + offset).toISOString()

describe('formatRelative', () => {
  it('shows a dash for missing or invalid dates', () => {
    expect(formatRelative(null, NOW)).toBe('–')
    expect(formatRelative(undefined, NOW)).toBe('–')
    expect(formatRelative('', NOW)).toBe('–')
    expect(formatRelative('yesterday', NOW)).toBe('–')
  })

  it('says "gerade eben" within 45 seconds, and "gleich" ahead', () => {
    expect(formatRelative(at(0), NOW)).toBe('gerade eben')
    expect(formatRelative(at(-44 * SECOND), NOW)).toBe('gerade eben')
    expect(formatRelative(at(44 * SECOND), NOW)).toBe('gleich')
  })

  it('counts days by the calendar, not in blocks of 24 hours', () => {
    // Wednesday 23:59 on Friday at 6:00: 30 hours, but the day before yesterday.
    expect(formatRelative('2026-11-04T22:59:00Z', Date.parse('2026-11-06T05:00:00Z'))).toBe('vorgestern')
    // Thursday 0:00 on Friday at 23:00: 47 hours, but yesterday.
    expect(formatRelative('2026-11-04T23:00:00Z', Date.parse('2026-11-05T22:00:00Z') + DAY)).toBe('gestern')
    // Nearly a day, still today.
    expect(formatRelative('2026-11-05T23:10:00Z', Date.parse('2026-11-06T22:50:00Z'))).toBe('vor 24 Stunden')
  })

  it('counts minutes, hours and days', () => {
    expect(formatRelative(at(-45 * SECOND), NOW)).toBe('vor 1 Minute')
    expect(formatRelative(at(-5 * MINUTE), NOW)).toBe('vor 5 Minuten')
    expect(formatRelative(at(5 * MINUTE), NOW)).toBe('in 5 Minuten')
    expect(formatRelative(at(-3 * HOUR), NOW)).toBe('vor 3 Stunden')
    expect(formatRelative(at(2 * HOUR), NOW)).toBe('in 2 Stunden')
    expect(formatRelative(at(-DAY), NOW)).toBe('gestern')
    expect(formatRelative(at(2 * DAY), NOW)).toBe('übermorgen')
    expect(formatRelative(at(-29 * DAY), NOW)).toBe('vor 29 Tagen')
  })

  it('moves on to the next unit when the count rounds up to it', () => {
    expect(formatRelative(at(-59.6 * MINUTE), NOW)).toBe('vor 1 Stunde')
    expect(formatRelative(at(-59.4 * MINUTE), NOW)).toBe('vor 59 Minuten')
    expect(formatRelative(at(-23.6 * HOUR), NOW)).toBe('gestern')
    expect(formatRelative(at(23.6 * HOUR), NOW)).toBe('morgen')
    expect(formatRelative(at(-23.4 * HOUR), NOW)).toBe('vor 23 Stunden')
    expect(formatRelative(at(-29.6 * DAY), NOW)).toBe('07.10.2026, 23:36')
  })

  it('shows the date from 30 days on', () => {
    // 30 days earlier it was still summer time.
    expect(formatRelative(at(-30 * DAY), NOW)).toBe('07.10.2026, 14:00')
  })
})

describe('formatDateTime', () => {
  it('formats in the local time zone, summer time included', () => {
    expect(formatDateTime('2026-11-06T12:00:00Z')).toBe('06.11.2026, 13:00')
    expect(formatDateTime('2026-07-01T12:00:00Z')).toBe('01.07.2026, 14:00')
  })

  it('shows a dash for missing or invalid dates', () => {
    expect(formatDateTime(null)).toBe('–')
    expect(formatDateTime(undefined)).toBe('–')
    expect(formatDateTime('not a date')).toBe('–')
  })
})

describe('formatClock', () => {
  it('shows only the time within a day, both ways', () => {
    expect(formatClock(at(6 * HOUR + 40 * MINUTE), NOW)).toBe('19:40')
    expect(formatClock(at(DAY - MINUTE), NOW)).toBe('12:59')
    expect(formatClock(at(-(DAY - MINUTE)), NOW)).toBe('13:01')
  })

  it('adds the weekday from a day away on', () => {
    expect(formatClock('2026-11-09T03:00:00Z', NOW)).toBe('Mo., 04:00')
    expect(formatClock(at(DAY), NOW)).toBe('Sa., 13:00')
    expect(formatClock(at(-2 * DAY), NOW)).toBe('Mi., 13:00')
  })

  it('shows a dash for missing or invalid dates', () => {
    expect(formatClock(null, NOW)).toBe('–')
    expect(formatClock('nope', NOW)).toBe('–')
  })
})

describe('formatReset', () => {
  it('says "unbekannt" without a valid date', () => {
    expect(formatReset(null, NOW)).toBe('unbekannt')
    expect(formatReset(undefined, NOW)).toBe('unbekannt')
    expect(formatReset('soon', NOW)).toBe('unbekannt')
  })

  it('says "jetzt" once the time has come', () => {
    expect(formatReset(at(0), NOW)).toBe('jetzt')
    expect(formatReset(at(-HOUR), NOW)).toBe('jetzt')
  })

  it('counts hours and minutes down, with the clock time', () => {
    expect(formatReset(at(2 * HOUR + 13 * MINUTE), NOW)).toBe('in 2 Std. 13 Min. · 15:13')
    expect(formatReset(at(HOUR), NOW)).toBe('in 1 Std. · 14:00')
    expect(formatReset(at(25 * MINUTE), NOW)).toBe('in 25 Min. · 13:25')
  })

  it('rounds to whole minutes and says "< 1 Min." below half a minute', () => {
    expect(formatReset(at(20 * SECOND), NOW)).toBe('in < 1 Min. · 13:00')
    expect(formatReset(at(30 * SECOND), NOW)).toBe('in 1 Min. · 13:00')
    expect(formatReset(at(4 * MINUTE + 31 * SECOND), NOW)).toBe('in 5 Min. · 13:04')
  })

  it('leaves the minutes out when days are left, and adds the weekday', () => {
    expect(formatReset(at(2 * DAY + 5 * HOUR + 30 * MINUTE), NOW)).toBe('in 2 T. 5 Std. · So., 18:30')
    expect(formatReset(at(3 * DAY), NOW)).toBe('in 3 T. · Mo., 13:00')
  })
})

describe('formatTokens', () => {
  it('writes small counts in full', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(9999)).toBe('9.999')
  })

  it('shortens large counts', () => {
    // Intl puts a no-break space before the unit.
    const plain = (text: string) => text.replace(/\s/g, ' ')
    expect(plain(formatTokens(1_500_000))).toBe('1,5 Mio.')
    expect(plain(formatTokens(2_340_000_000))).toBe('2,3 Mrd.')
  })
})

describe('formatNumber', () => {
  it('groups thousands the German way', () => {
    expect(formatNumber(1_234_567)).toBe('1.234.567')
    expect(formatNumber(42)).toBe('42')
  })
})

describe('formatBytes', () => {
  it('uses bytes below 1 KB and whole KB below 1 MB, with German digits', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1.023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('2 KB')
    expect(formatBytes(500 * 1024)).toBe('500 KB')
    expect(formatBytes(1023 * 1024)).toBe('1.023 KB')
  })

  it('switches to MB with one decimal and a comma at 1 MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1,0 MB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1,5 MB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3,0 MB')
  })

  it('shows a size that rounds up to the next unit in it', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1,0 MB')
    expect(formatBytes(1024 * 1024 - 400)).toBe('1,0 MB')
    expect(formatBytes(1024 * 1024 - 600)).toBe('1.023 KB')
    expect(formatBytes(1024 ** 3 - 1)).toBe('1,0 GB')
    expect(formatBytes(2.25 * 1024 ** 3)).toBe('2,3 GB')
  })
})

describe('shortenPath', () => {
  it('shows a dash without a path', () => {
    expect(shortenPath(null)).toBe('–')
    expect(shortenPath(undefined, '/home/me')).toBe('–')
    expect(shortenPath('', '/home/me')).toBe('–')
  })

  it('replaces the home directory with ~', () => {
    expect(shortenPath('/home/me/projects/app', '/home/me')).toBe('~/projects/app')
    expect(shortenPath('/home/me', '/home/me')).toBe('~')
  })

  it('compares the home directory ignoring case (Windows paths)', () => {
    expect(shortenPath('c:\\users\\Me\\Projects', 'C:\\Users\\me')).toBe('~\\Projects')
  })

  it('only shortens the home folder itself and paths inside it', () => {
    expect(shortenPath('/home/bobby/x', '/home/bob')).toBe('/home/bobby/x')
    expect(shortenPath('C:\\Users\\conno2\\app', 'C:\\Users\\conno')).toBe('C:\\Users\\conno2\\app')
    expect(shortenPath('C:\\Users\\conno\\app', 'C:\\Users\\conno')).toBe('~\\app')
    expect(shortenPath('/home/me/app', '/home/me/')).toBe('~app')
  })

  it('compares other than Windows paths with case', () => {
    expect(shortenPath('/home/Me/app', '/home/me')).toBe('/home/Me/app')
  })

  it('leaves other paths alone', () => {
    expect(shortenPath('/srv/app', '/home/me')).toBe('/srv/app')
    expect(shortenPath('/home/me/app', null)).toBe('/home/me/app')
    expect(shortenPath('/home/me/app')).toBe('/home/me/app')
  })
})

describe('accountKindLabel', () => {
  it('names each kind and passes unknown ones through', () => {
    expect(accountKindLabel('system')).toBe('Standard-Login')
    expect(accountKindLabel('oauth')).toBe('OAuth-Login')
    expect(accountKindLabel('token')).toBe('Long-lived Token')
    expect(accountKindLabel('apiKey')).toBe('API-Key')
    expect(accountKindLabel('other')).toBe('other')
  })
})

function identity(fields: Partial<AccountIdentity>): AccountIdentity {
  return {
    email: null,
    displayName: null,
    organizationUuid: null,
    organizationName: null,
    organizationType: null,
    subscriptionType: null,
    rateLimitTier: null,
    ...fields,
  }
}

describe('organizationLabel', () => {
  it('says "Persönlich" for Pro and Max plans, even without a name', () => {
    expect(organizationLabel(identity({ organizationType: 'claude_pro' }))).toBe('Persönlich')
    expect(organizationLabel(identity({ organizationType: 'claude_max', organizationName: 'Acme' }))).toBe('Persönlich')
  })

  it('shows the name of a team or enterprise, even if it looks personal', () => {
    expect(organizationLabel(identity({ organizationType: 'claude_team', organizationName: 'Acme' }))).toBe('Acme')
    expect(
      organizationLabel(identity({ organizationType: 'claude_enterprise', organizationName: "me@acme.com's Organization" })),
    ).toBe("me@acme.com's Organization")
  })

  it('guesses from the name when the type is unknown', () => {
    expect(organizationLabel(identity({ organizationName: "me@example.com's Organization" }))).toBe('Persönlich')
    expect(organizationLabel(identity({ organizationName: 'Acme' }))).toBe('Acme')
  })

  it('returns null without a name or a personal plan', () => {
    expect(organizationLabel(identity({}))).toBeNull()
    expect(organizationLabel(identity({ organizationType: 'claude_team' }))).toBeNull()
  })
})

describe('identityLabel', () => {
  it('joins email and organization', () => {
    expect(identityLabel(identity({ email: 'me@acme.com', organizationType: 'claude_max' }))).toBe('me@acme.com · Persönlich')
    expect(identityLabel(identity({ email: 'me@acme.com', organizationName: 'Acme' }))).toBe('me@acme.com · Acme')
  })

  it('shows what is known, or null', () => {
    expect(identityLabel(identity({ email: 'me@acme.com' }))).toBe('me@acme.com')
    expect(identityLabel(identity({ organizationName: 'Acme' }))).toBe('Acme')
    expect(identityLabel(identity({}))).toBeNull()
  })
})

describe('planLabel', () => {
  it('names the known plans, ignoring case', () => {
    expect(planLabel('pro')).toBe('Pro')
    expect(planLabel('MAX')).toBe('Max')
    expect(planLabel('team')).toBe('Team')
    expect(planLabel('Enterprise')).toBe('Enterprise')
    expect(planLabel('free')).toBe('Free')
  })

  it('passes unknown plans through and returns null for none', () => {
    expect(planLabel('ultra')).toBe('ultra')
    expect(planLabel(null)).toBeNull()
    expect(planLabel(undefined)).toBeNull()
    expect(planLabel('')).toBeNull()
  })
})
