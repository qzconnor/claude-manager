import type { WebContents } from 'electron'
import type { BrowserPermission } from '@shared/types'

/**
 * Permissions Claude gives a page of the browser or refuses it for a while (browser_emulate), over
 * what the browser profile allows (browser-policy.ts). Electron asks the profile's handlers, which
 * ask here first (browser-guests.ts).
 */

export type PermissionOverrides = Partial<Record<BrowserPermission, 'granted' | 'denied'>>

const overrides = new Map<number, PermissionOverrides>()

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
 * be granted.
 */
export function permissionDecision(granted: PermissionOverrides | undefined, permission: string, mediaTypes: string[] = []): boolean | null {
  if (!granted) return null
  if (permission === 'media') {
    const settings = mediaTypes.map((type) => (ELECTRON_NAMES[type] ? granted[ELECTRON_NAMES[type]] : undefined))
    if (settings.length === 0 || settings.every((setting) => setting === undefined)) return null
    return settings.every((setting) => setting === 'granted')
  }
  const name = ELECTRON_NAMES[permission]
  const setting = name ? granted[name] : undefined
  return setting === undefined ? null : setting === 'granted'
}

export const browserPermissions = {
  /** What the page in `contents` gets from now on; empty: as the profile allows. */
  set(contents: WebContents, permissions: PermissionOverrides): void {
    if (Object.keys(permissions).length === 0) {
      overrides.delete(contents.id)
      return
    }
    if (!overrides.has(contents.id)) {
      const id = contents.id
      contents.once('destroyed', () => overrides.delete(id))
    }
    overrides.set(contents.id, { ...permissions })
  },
  /** For the profile's handlers: Claude's answer, or null for the profile's own. */
  decide(contents: WebContents | null, permission: string, mediaTypes?: string[]): boolean | null {
    if (!contents || contents.isDestroyed()) return null
    return permissionDecision(overrides.get(contents.id), permission, mediaTypes)
  },
}
