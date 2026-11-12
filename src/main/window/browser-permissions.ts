import type { WebContents } from 'electron'
import type { BrowserPermission } from '@shared/types'

/**
 * Permissions Claude gives a page of the browser or refuses it for a while (browser_emulate), over
 * what the browser profile allows (browser-policy.ts). Electron asks the profile's handlers, which
 * ask here first (browser-guests.ts). Like Chrome's grants they belong to a site: what Claude grants
 * holds for the site that was open then, not for the next one the tab goes to or a frame of another
 * site in it; what it refuses holds for all.
 */

export type PermissionOverrides = Partial<Record<BrowserPermission, 'granted' | 'denied'>>

interface PageOverrides {
  permissions: PermissionOverrides
  /** The site the grants are for; null: none (a page without one, such as about:blank). */
  origin: string | null
}

const overrides = new Map<number, PageOverrides>()

/** The origin of a URL or origin; null for one without (about:blank, data:, a broken one). */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** Electron's names of permissions (and kinds of media) for Claude's. */
const ELECTRON_NAMES: Record<string, BrowserPermission> = {
  geolocation: 'geolocation',
  notifications: 'notifications',
  'clipboard-read': 'clipboard-read',
  video: 'camera',
  audio: 'microphone',
}

/**
 * Claude's answer for a request or check of a permission: true or false, or null when Claude says
 * nothing about it. `mediaTypes`: what a request for `media` wants (video, audio); all of it must
 * be granted. `ownSite`: the request comes from the site Claude granted for; from another one a
 * grant says nothing (the profile refuses), a refusal still holds.
 */
export function permissionDecision(
  granted: PermissionOverrides | undefined,
  permission: string,
  mediaTypes: string[] = [],
  ownSite = true,
): boolean | null {
  if (!granted) return null
  let answer: boolean | null
  if (permission === 'media') {
    const settings = mediaTypes.map((type) => (ELECTRON_NAMES[type] ? granted[ELECTRON_NAMES[type]] : undefined))
    if (settings.length === 0 || settings.every((setting) => setting === undefined)) return null
    answer = settings.every((setting) => setting === 'granted')
  } else {
    const name = ELECTRON_NAMES[permission]
    const setting = name ? granted[name] : undefined
    answer = setting === undefined ? null : setting === 'granted'
  }
  return answer === true && !ownSite ? null : answer
}

export const browserPermissions = {
  /** What the page in `contents` gets from now on, granted for the site `origin`; empty: as the profile allows. */
  set(contents: WebContents, permissions: PermissionOverrides, origin: string | null): void {
    if (Object.keys(permissions).length === 0) {
      overrides.delete(contents.id)
      return
    }
    if (!overrides.has(contents.id)) {
      const id = contents.id
      contents.once('destroyed', () => overrides.delete(id))
    }
    overrides.set(contents.id, { permissions: { ...permissions }, origin })
  },
  /**
   * For the profile's handlers: Claude's answer, or null for the profile's own. `requesting`: the URL
   * or origin of the frame that asks.
   */
  decide(contents: WebContents | null, permission: string, mediaTypes: string[], requesting: string | undefined): boolean | null {
    if (!contents || contents.isDestroyed()) return null
    const page = overrides.get(contents.id)
    if (!page) return null
    const ownSite = page.origin !== null && originOf(requesting) === page.origin
    return permissionDecision(page.permissions, permission, mediaTypes, ownSite)
  },
}
