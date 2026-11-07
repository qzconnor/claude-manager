import type { BrowserEmulation } from '@shared/types'
import { type Args, oneOf, optionalBoolean, optionalNumber, optionalString, ToolError } from '../tool-args'

/** The arguments of browser_emulate and how its state reads for Claude. */

const NETWORK_CHOICES = ['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online'] as const
/** A BCP 47 language tag as browsers take it: `de`, `de-DE`, `zh-Hant-TW`. */
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/

/** The changes browser_emulate asks for; fields left out stay as they are. */
export function parseEmulation(args: Args): { reset: boolean; change: Partial<BrowserEmulation> } {
  if (optionalBoolean(args, 'reset')) return { reset: true, change: {} }
  const change: Partial<BrowserEmulation> = {}
  if (args.colorScheme !== undefined && args.colorScheme !== null) {
    const scheme = oneOf(args, 'colorScheme', ['dark', 'light', 'system'] as const)
    change.colorScheme = scheme === 'system' ? null : scheme
  }
  const reduced = optionalBoolean(args, 'reducedMotion')
  if (reduced !== undefined) change.reducedMotion = reduced
  if (args.network !== undefined && args.network !== null) {
    const network = oneOf(args, 'network', NETWORK_CHOICES)
    change.network = network === 'online' ? null : network
  }
  const slowdown = optionalNumber(args, 'cpuSlowdown', 1, 20)
  if (slowdown !== undefined) change.cpuSlowdown = slowdown <= 1 ? null : Math.round(slowdown * 10) / 10
  const locale = optionalString(args, 'locale', 40)
  if (locale !== undefined) {
    const tag = locale.trim().replace(/_/g, '-')
    if (tag && !LOCALE_RE.test(tag)) throw new ToolError(`locale must be a language tag like "de-DE" or "en-US", not ${JSON.stringify(locale)}.`)
    change.locale = tag || null
  }
  const timezone = optionalString(args, 'timezone', 64)
  if (timezone !== undefined) {
    const zone = timezone.trim()
    if (zone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone })
      } catch {
        throw new ToolError(`timezone must be an IANA time zone like "Europe/Berlin" or "America/New_York", not ${JSON.stringify(timezone)}.`)
      }
    }
    change.timezone = zone || null
  }
  if (Object.keys(change).length === 0) throw new ToolError('Give at least one of colorScheme, reducedMotion, network, cpuSlowdown, locale, timezone, or reset.')
  return { reset: false, change }
}

/** An emulation for Claude, e.g. "dark color scheme, slow 3G network"; empty when nothing is emulated. */
export function describeEmulation(emulation: BrowserEmulation): string {
  const parts: string[] = []
  if (emulation.colorScheme) parts.push(`${emulation.colorScheme} color scheme`)
  if (emulation.reducedMotion) parts.push('reduced motion')
  if (emulation.network) parts.push(emulation.network === 'offline' ? 'no network (offline)' : `${emulation.network} network`)
  if (emulation.cpuSlowdown) parts.push(`CPU ${emulation.cpuSlowdown}× slower`)
  if (emulation.locale) parts.push(`locale ${emulation.locale}`)
  if (emulation.timezone) parts.push(`time zone ${emulation.timezone}`)
  return parts.join(', ')
}
