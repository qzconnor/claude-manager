import type { Input, WebPreferences } from 'electron'
import { BROWSER_PARTITION, isBrowsableUrl } from '@shared/browser'
import type { ShortcutKey } from '@shared/shortcuts'

/**
 * What a page in the app's browser may do. Kept apart from Electron's objects, so it can be tested.
 */

/** Permissions a page gets; it is refused everything else (camera, location, notifications, files …). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/**
 * Like Chrome, a page that shows one dialog (alert, confirm, prompt) after another gets a box on the
 * next one to stop them: otherwise a loop of them keeps the app from being used.
 */
export const SAFE_DIALOGS = { safeDialogs: true, safeDialogsMessage: 'Keine weiteren Dialoge dieser Seite zeigen' } as const

/**
 * Tabs and popups a page may open in `OPEN_BURST_MS`: links opened by hand or by Claude stay well
 * below it, a page that opens them in a loop doesn't.
 */
export const MAX_OPENS = 8
export const OPEN_BURST_MS = 10_000
/** Popup windows a page may have open at once. */
export const MAX_POPUPS = 4

/** Counts what a page opens: true while it may open another, false once it opened too many at once. */
export function openGate(now: () => number = Date.now): () => boolean {
  let opens: number[] = []
  return () => {
    const at = now()
    opens = opens.filter((before) => at - before < OPEN_BURST_MS)
    if (opens.length >= MAX_OPENS) return false
    opens.push(at)
    return true
  }
}

/**
 * The settings of every `<webview>` before it starts: no Node.js, not the app's preload, the browser's
 * own profile. False when its first address is none the browser may show (the view is then refused).
 */
export function hardenWebview(webPreferences: WebPreferences, params: Record<string, string>): boolean {
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.experimentalFeatures = false
  Object.assign(webPreferences, SAFE_DIALOGS)
  // A page without a background of its own is white (or dark with color-scheme: dark) as in
  // Chrome, on screen and in screenshots; a guest is transparent by default.
  webPreferences.transparent = false
  webPreferences.partition = BROWSER_PARTITION
  params.partition = BROWSER_PARTITION
  return !params.src || isBrowsableUrl(params.src)
}

/**
 * The user agent of a plain Chrome: sites like Google turn away browsers that name the app or
 * Electron in it. Unchanged when it doesn't look like Chromium's.
 */
export function browserUserAgent(agent: string): string {
  const platform = /\(([^)]+)\)/.exec(agent)?.[1]
  const chrome = /\bChrome\/(\S+)/.exec(agent)?.[1]
  const webkit = /\bAppleWebKit\/(\S+)/.exec(agent)?.[1]
  if (!platform || !chrome || !webkit) return agent
  return `Mozilla/5.0 (${platform}) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${chrome} Safari/${webkit}`
}

/**
 * The browser's user agent as a phone's (Chrome on Android, in Chrome's reduced form), for the
 * DevTools protocol's `Emulation.setUserAgentOverride`; the client hints say "mobile" as well.
 */
export function mobileUserAgent(agent: string): { userAgent: string; userAgentMetadata: Record<string, unknown> } {
  const chrome = /\bChrome\/(\S+)/.exec(agent)?.[1] ?? '140.0.0.0'
  const webkit = /\bAppleWebKit\/(\S+)/.exec(agent)?.[1] ?? '537.36'
  return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/${webkit}`,
    userAgentMetadata: { platform: 'Android', platformVersion: '10.0.0', architecture: '', model: 'K', mobile: true },
  }
}

/** A key of a page as the shortcut matchers read it. */
export function toShortcutKey(input: Pick<Input, 'type' | 'key' | 'code' | 'control' | 'alt' | 'shift' | 'meta'>): ShortcutKey {
  const type = input.type === 'keyDown' || input.type === 'rawKeyDown' ? 'keydown' : input.type === 'keyUp' ? 'keyup' : input.type
  return {
    type,
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
    metaKey: input.meta,
  }
}

/** The largest favicon a tab shows; a bigger file is no icon. */
export const MAX_FAVICON_BYTES = 256 * 1024

/**
 * The image type of a favicon by its first bytes, since servers often send `.ico` files under some
 * other type. Null for anything a tab shouldn't show as an image.
 */
export function faviconType(bytes: Uint8Array): string | null {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte)
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (startsWith(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon'
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  // An SVG can't run scripts or load anything as an image.
  const head = new TextDecoder().decode(bytes.subarray(0, 1024))
  if (/<svg[\s>]/i.test(head) && !/<html[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

/**
 * A name for a download that no file in the folder has yet (`taken`), like Chrome gives it:
 * `report.pdf`, then `report (1).pdf`, `report (2).pdf` … Names that are no file name become `download`.
 */
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
  // Only the last part of a path (`/` or `\`), without characters Windows doesn't allow in names.
  const cleaned =
    name
      .split(/[\\/]/)
      .pop()!
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .replace(/^[\s.]+|[\s.]+$/g, '') || 'download'
  // Names of devices (`CON`, `NUL.txt`, `COM1` …) don't name a file on Windows.
  const base = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned
  if (!taken(base)) return base
  const extension = /(\.tar)?\.[^.\s]{1,10}$/i.exec(base)?.[0] ?? ''
  const stem = base.slice(0, base.length - extension.length) || 'download'
  for (let n = 1; n < 10_000; n++) {
    const candidate = `${stem} (${n})${extension}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${extension}`
}

/**
 * The title of a page's popup window (a login of another site, for example): it has no address bar,
 * so the host the page comes from stands next to its title.
 */
export function popupTitle(title: string, url: string): string {
  let host = ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') host = parsed.host
  } catch {
    // no address yet
  }
  const text = title.replace(/\s+/g, ' ').trim()
  if (!host) return text || 'Claude Manager'
  return text && text !== host && text !== url ? `${text} – ${host}` : host
}

/** The host that asks for a login, with its port when it isn't the scheme's own. */
export function loginHost(info: { host: string; port: number; scheme?: string }, url: string): string {
  let defaultPort = 443
  try {
    defaultPort = new URL(url).protocol === 'http:' ? 80 : 443
  } catch {
    // keep https
  }
  return info.port && info.port !== defaultPort ? `${info.host}:${info.port}` : info.host
}
