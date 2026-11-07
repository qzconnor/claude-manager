import type { BrowserEmulation, BrowserPermission } from '@shared/types'
import { type Args, oneOf, optionalBoolean, optionalNumber, optionalString, ToolError } from '../tool-args'

/** The arguments of browser_emulate and how its state reads for Claude. */

const NETWORK_CHOICES = ['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online'] as const
/** A BCP 47 language tag as browsers take it: `de`, `de-DE`, `zh-Hant-TW`. */
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/

export const PERMISSIONS: readonly BrowserPermission[] = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read']
const PERMISSION_SETTINGS = ['granted', 'denied', 'default'] as const
type PermissionSetting = (typeof PERMISSION_SETTINGS)[number]
/** How accurate a place of Claude's is when it doesn't say (meters). */
const DEFAULT_ACCURACY = 50

/**
 * The changes browser_emulate asks for; fields left out stay as they are. `permissions`: changes of
 * single permissions (default: back to the browser's own), see `mergePermissions`.
 */
export function parseEmulation(args: Args): {
  reset: boolean
  change: Partial<BrowserEmulation>
  permissions: Partial<Record<BrowserPermission, PermissionSetting>>
} {
  if (optionalBoolean(args, 'reset')) return { reset: true, change: {}, permissions: {} }
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
  const place = optionalString(args, 'geolocation', 100)
  if (place !== undefined) change.geolocation = parseGeolocation(place)
  const permissions = parsePermissions(args)
  if (Object.keys(change).length === 0 && Object.keys(permissions).length === 0) {
    throw new ToolError('Give at least one of colorScheme, reducedMotion, network, cpuSlowdown, locale, timezone, geolocation, permissions, or reset.')
  }
  return { reset: false, change, permissions }
}

/** "52.52,13.405" or "52.52, 13.405, 100" (latitude, longitude, accuracy in meters); "" for none. */
export function parseGeolocation(value: string): BrowserEmulation['geolocation'] {
  if (!value.trim()) return null
  const parts = value.split(',').map((part) => Number(part.trim()))
  const [latitude, longitude, accuracy = DEFAULT_ACCURACY] = parts
  const valid =
    (parts.length === 2 || parts.length === 3) &&
    parts.every((n) => Number.isFinite(n)) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    accuracy > 0 &&
    accuracy <= 100_000
  if (!valid) throw new ToolError(`geolocation must be "latitude,longitude" or "latitude,longitude,accuracy", e.g. "52.52,13.405"; not ${JSON.stringify(value)}.`)
  return { latitude, longitude, accuracy }
}

function parsePermissions(args: Args): Partial<Record<BrowserPermission, PermissionSetting>> {
  const value = args.permissions
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ToolError('permissions must be an object like {"notifications": "granted"}.')
  const out: Partial<Record<BrowserPermission, PermissionSetting>> = {}
  for (const [name, setting] of Object.entries(value)) {
    if (!PERMISSIONS.includes(name as BrowserPermission)) throw new ToolError(`permissions takes ${PERMISSIONS.join(', ')}; not ${JSON.stringify(name)}.`)
    if (!PERMISSION_SETTINGS.includes(setting as PermissionSetting)) {
      throw new ToolError(`permissions.${name} must be one of ${PERMISSION_SETTINGS.join(', ')}.`)
    }
    out[name as BrowserPermission] = setting as PermissionSetting
  }
  return out
}

/** The permissions after browser_emulate's changes: default takes one back to the browser's own. */
export function mergePermissions(
  before: BrowserEmulation['permissions'],
  changes: Partial<Record<BrowserPermission, PermissionSetting>>,
): BrowserEmulation['permissions'] {
  const out = { ...before }
  for (const [name, setting] of Object.entries(changes) as [BrowserPermission, PermissionSetting][]) {
    if (setting === 'default') delete out[name]
    else out[name] = setting
  }
  return out
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
  if (emulation.geolocation) {
    const { latitude, longitude, accuracy } = emulation.geolocation
    parts.push(`location ${latitude},${longitude} (±${accuracy} m, permission granted)`)
  }
  for (const [name, setting] of Object.entries(emulation.permissions)) parts.push(`${name} permission ${setting}`)
  return parts.join(', ')
}
