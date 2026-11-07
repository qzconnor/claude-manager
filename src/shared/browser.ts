import type { BrowserEmulation, BrowserNetworkPreset, BrowserPermission, BrowserRoute } from './types'

/**
 * The browser tabs: web pages in a part of a tab, with a profile of their own (cookies, storage)
 * apart from the app and the user's browser.
 */
export const BROWSER_PARTITION = 'persist:browser'
export const BLANK_PAGE = 'about:blank'
export const DEFAULT_BROWSER_TITLE = 'Neuer Tab'
/** Longest address that is kept and restored. */
export const MAX_URL_LENGTH = 8192

const SEARCH_URL = 'https://www.google.com/search?q='
/** A host with an optional port and path: `example.com`, `localhost:5173/app`, `192.168.0.2:8080`, `[::1]:3000`. */
const HOST_RE = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}][\p{L}\p{N}-]*)(:\d{1,5})?([/?#].*)?$/iu
/** Hosts that hardly ever speak https: the address gets `http://`. */
const LOCAL_HOST_RE = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3})(:|\/|\?|#|$)/i

/** A page the browser may show: http(s) or the empty page. */
export function isBrowsableUrl(url: string): boolean {
  if (url === BLANK_PAGE) return true
  if (url.length > MAX_URL_LENGTH) return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * What the address bar makes of the input: an address as typed (`https://` added when the scheme is
 * missing, `http://` for local hosts), a web search for anything else.
 */
export function addressToUrl(input: string): string {
  const text = input.trim()
  if (!text) return BLANK_PAGE
  if (/^https?:\/\//i.test(text) || text.toLowerCase() === BLANK_PAGE) {
    return isBrowsableUrl(text) ? text : SEARCH_URL + encodeURIComponent(text)
  }
  if (!/\s/.test(text) && HOST_RE.test(text)) {
    const url = `${LOCAL_HOST_RE.test(text) ? 'http' : 'https'}://${text}`
    if (isBrowsableUrl(url)) return url
  }
  return SEARCH_URL + encodeURIComponent(text)
}

/** The address as the address bar shows it: nothing for the empty page. */
export function addressOf(url: string | null): string {
  return !url || url === BLANK_PAGE ? '' : url
}

/** A title for a page that has none (yet): its host, or the default for the empty page. */
export function fallbackTitle(url: string | null): string {
  if (!url || url === BLANK_PAGE) return DEFAULT_BROWSER_TITLE
  try {
    return new URL(url).host || DEFAULT_BROWSER_TITLE
  } catch {
    return DEFAULT_BROWSER_TITLE
  }
}

const NETWORK_LABELS: Record<BrowserNetworkPreset, string> = {
  offline: 'Offline',
  'slow-3g': 'Langsames 3G',
  'fast-3g': 'Schnelles 3G',
  'fast-4g': '4G',
}

/** A page that pretends nothing. */
export const NO_EMULATION: BrowserEmulation = {
  colorScheme: null,
  reducedMotion: false,
  network: null,
  cpuSlowdown: null,
  locale: null,
  timezone: null,
  geolocation: null,
  permissions: {},
}

const PERMISSION_LABELS: Record<BrowserPermission, string> = {
  geolocation: 'Standort',
  notifications: 'Benachrichtigungen',
  camera: 'Kamera',
  microphone: 'Mikrofon',
  'clipboard-read': 'Zwischenablage lesen',
}

/** What Claude has the page pretend, as short German labels for the log and the badge over the page. */
export function emulationLabels(emulation: BrowserEmulation): string[] {
  const labels: string[] = []
  if (emulation.colorScheme) labels.push(emulation.colorScheme === 'dark' ? 'Dunkel' : 'Hell')
  if (emulation.reducedMotion) labels.push('Weniger Bewegung')
  if (emulation.network) labels.push(NETWORK_LABELS[emulation.network])
  if (emulation.cpuSlowdown) labels.push(`CPU ${emulation.cpuSlowdown}× langsamer`)
  if (emulation.locale) labels.push(emulation.locale)
  if (emulation.timezone) labels.push(emulation.timezone)
  if (emulation.geolocation) labels.push(`Standort ${emulation.geolocation.latitude.toFixed(2)}, ${emulation.geolocation.longitude.toFixed(2)}`)
  for (const [name, setting] of Object.entries(emulation.permissions) as [BrowserPermission, string][]) {
    labels.push(`${PERMISSION_LABELS[name]} ${setting === 'granted' ? 'erlaubt' : 'verweigert'}`)
  }
  return labels
}

/** A route of Claude's as a short German label, e.g. "GET /api/users → 500". */
export function routeLabel(route: BrowserRoute): string {
  const target = `${route.method ? `${route.method} ` : ''}${route.pattern}`
  const delay = route.delayMs ? ` +${route.delayMs} ms` : ''
  if (route.action === 'fail') return `${target} blockiert${delay}`
  if (route.action === 'delay') return `${target}${delay}`
  return `${target} → ${route.status ?? 200}${delay}`
}
