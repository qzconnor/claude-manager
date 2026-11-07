import type { BrowserEmulation, BrowserNetworkPreset, BrowserViewport } from '@shared/types'
import { mobileUserAgent } from '../window/browser-policy'
import { delay, type PageDriver } from './page-driver'
import type { ViewportSize } from './action-context'
import { ToolError } from './tool-args'

/** What Claude has the page pretend: a phone, another size, dark mode, a slow network or CPU, a language or time zone. */

/** How long the window may take to give the page the size Claude chose. */
const VIEWPORT_WAIT_MS = 3000

/**
 * A phone to the page (touch, a phone's user agent, the viewport meta tag), or the browser again.
 * `locale`: the language Claude chose (browser_emulate), which goes with the user agent.
 */
export async function setPhoneMode(page: PageDriver, on: boolean, locale: string | null): Promise<void> {
  if (on) {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 0, mobile: true })
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  } else {
    await page.cdp('Emulation.clearDeviceMetricsOverride')
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false })
  }
  await setUserAgent(page, on, locale)
}

/**
 * The user agent (a phone's or the browser's own) and the language the page is asked for, in the
 * page or in a frame in a process of its own (`session`).
 */
async function setUserAgent(page: PageDriver, mobile: boolean, locale: string | null, session?: string): Promise<void> {
  const language = locale ? { acceptLanguage: locale } : {}
  if (mobile) await page.cdpIn(session, 'Emulation.setUserAgentOverride', { ...mobileUserAgent(page.contents.getUserAgent()), ...language })
  else if (locale) await page.cdpIn(session, 'Emulation.setUserAgentOverride', { userAgent: page.contents.getUserAgent(), ...language })
  // An empty agent ends the override.
  else await page.cdpIn(session, 'Emulation.setUserAgentOverride', { userAgent: '' })
}

/** Chrome's network presets for DevTools (bytes per second, latency in ms). */
const NETWORK_PRESETS: Record<BrowserNetworkPreset, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  offline: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  'fast-3g': { offline: false, latency: 562.5, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  'fast-4g': { offline: false, latency: 165, downloadThroughput: 1_012_500, uploadThroughput: 168_750 },
}
const NO_NETWORK_LIMIT = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }

/** Whether an emulation has the page pretend anything at all. */
export function isEmulating(emulation: BrowserEmulation): boolean {
  return (
    emulation.colorScheme !== null ||
    emulation.reducedMotion ||
    emulation.network !== null ||
    emulation.cpuSlowdown !== null ||
    emulation.locale !== null ||
    emulation.timezone !== null
  )
}

/**
 * What the page pretends (null: nothing), in the page and in its frames in processes of their own
 * (`frameSessions`), which feel the network and the CPU apart from the page.
 */
export async function applyEmulation(page: PageDriver, emulation: BrowserEmulation | null, mobile: boolean, frameSessions: string[]): Promise<void> {
  await page.cdp('Emulation.setEmulatedMedia', { features: mediaFeatures(emulation) })
  await page.cdp('Emulation.setTimezoneOverride', { timezoneId: emulation?.timezone ?? '' }).catch((error: Error) => {
    if (emulation?.timezone) throw new ToolError(`The time zone ${JSON.stringify(emulation.timezone)} is unknown: ${error.message}`)
  })
  // Another language replaces the last one only after it is gone.
  await page.cdp('Emulation.setLocaleOverride', { locale: '' }).catch(() => undefined)
  if (emulation?.locale) {
    await page.cdp('Emulation.setLocaleOverride', { locale: emulation.locale }).catch((error: Error) => {
      throw new ToolError(`The locale ${JSON.stringify(emulation.locale)} is unknown: ${error.message}`)
    })
  }
  await setUserAgent(page, mobile, emulation?.locale ?? null)
  await page.cdp('Network.emulateNetworkConditions', emulation?.network ? NETWORK_PRESETS[emulation.network] : NO_NETWORK_LIMIT)
  await page.cdp('Emulation.setCPUThrottlingRate', { rate: emulation?.cpuSlowdown ?? 1 })
  for (const session of frameSessions) await applyFrameEmulation(page, session, emulation, mobile)
}

/**
 * The emulation in a frame in a process of its own: the process has its own media, clock, language
 * and network. Each part on its own: a process has one time zone and language, which a frame in
 * the page's process (or another frame of its site) may have set already.
 */
export async function applyFrameEmulation(page: PageDriver, session: string, emulation: BrowserEmulation | null, mobile: boolean): Promise<void> {
  const send = (method: string, params: Record<string, unknown>) => page.cdpIn(session, method, params).catch(() => undefined)
  await send('Emulation.setEmulatedMedia', { features: mediaFeatures(emulation) })
  await send('Emulation.setTimezoneOverride', { timezoneId: emulation?.timezone ?? '' })
  await send('Emulation.setLocaleOverride', { locale: '' })
  if (emulation?.locale) await send('Emulation.setLocaleOverride', { locale: emulation.locale })
  await setUserAgent(page, mobile, emulation?.locale ?? null, session).catch(() => undefined)
  await send('Network.emulateNetworkConditions', emulation?.network ? NETWORK_PRESETS[emulation.network] : NO_NETWORK_LIMIT)
  await send('Emulation.setCPUThrottlingRate', { rate: emulation?.cpuSlowdown ?? 1 })
}

/** The media features of an emulation; empty values end an override. */
function mediaFeatures(emulation: BrowserEmulation | null): { name: string; value: string }[] {
  return [
    { name: 'prefers-color-scheme', value: emulation?.colorScheme ?? '' },
    { name: 'prefers-reduced-motion', value: emulation?.reducedMotion ? 'reduce' : '' },
  ]
}

/** Waits until the page has the size `wanted`; for null, until it lost the size it had (`before`). */
export async function untilViewport(page: PageDriver, wanted: ViewportSize | null, before: BrowserViewport | null): Promise<void> {
  const deadline = Date.now() + VIEWPORT_WAIT_MS
  const near = (a: number, b: number) => Math.abs(a - b) <= 1
  for (;;) {
    const size = await page.viewportSize()
    if (wanted ? near(size.width, wanted.width) && near(size.height, wanted.height) : !before || !near(size.width, before.width) || !near(size.height, before.height)) return
    if (Date.now() > deadline) {
      if (!wanted) return
      throw new ToolError(`The page did not get the size ${wanted.width}×${wanted.height} (it has ${size.width}×${size.height}). Is the Claude Manager window open?`)
    }
    await delay(50)
  }
}
