import type { Input, WebPreferences } from 'electron'
import { BROWSER_PARTITION, isBrowsableUrl } from '@shared/browser'
import type { ShortcutKey } from '@shared/shortcuts'

/**
 * What a page in the app's browser may do. Kept apart from Electron's objects, so it can be tested.
 */

/** Permissions a page gets; it is refused everything else (camera, location, notifications, files …). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

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
