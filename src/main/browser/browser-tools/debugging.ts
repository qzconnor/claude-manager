import { emulationLabels, NO_EMULATION } from '@shared/browser'
import type { BrowserEmulation } from '@shared/types'
import { MESSAGE_LIMIT, type NetworkEntry } from '../network-log'
import { effectivePermissions } from '../page-emulation'
import { formatConsoleEntry } from '../page-errors'
import { cut, optionalBoolean, optionalNumber, stringList, ToolError } from '../tool-args'
import { describeEmulation, mergePermissions, parseEmulation, PERMISSIONS } from './emulation-args'
import { formatBytes, headerLines, MAX_BODY_CHARS, requestBodyText, responseBody } from './network-format'
import { measurePerformance } from './performance'
import { str } from './test-code'
import { NAVIGATION_WAIT_MS, pageState, shortAddress, tool, type ToolDefinition } from './tool'

/** Tools for debugging: console, network, emulation, page size, performance, site data. */

/** The sizes Claude can give the page (CSS pixels per side). */
const MIN_VIEWPORT = 200
const MAX_VIEWPORT = 4000

const MAX_LIST_ENTRIES = 100
/** Messages of a WebSocket browser_network_request shows by default. */
const DEFAULT_MESSAGES = 30

/** What browser_clear_site_data clears. */
const SITE_DATA = ['cookies', 'storage', 'cache'] as const
type SiteData = (typeof SITE_DATA)[number]

export const debuggingTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_resize',
    title: 'Resize the page',
    description:
      'Gives the page a size of its own, to test layouts, e.g. 390×844 (phone, with mobile), 820×1180 (tablet, with mobile), 1440×900 (laptop) or 1920×1080 (desktop). Sizes larger than the window are shown scaled down to the user; the page has the real size. reset: back to the size of the window.',
    properties: {
      width: { type: 'number', description: `CSS pixels, ${MIN_VIEWPORT}–${MAX_VIEWPORT}.` },
      height: { type: 'number', description: `CSS pixels, ${MIN_VIEWPORT}–${MAX_VIEWPORT}.` },
      mobile: {
        type: 'boolean',
        description: "Phone mode: touch, a phone's user agent and the page's viewport meta tag. The page loads again when this changes.",
      },
      reset: { type: 'boolean', description: 'Back to the size of the window, out of phone mode.' },
    },
    kind: 'resize',
    parse: (args) => {
      if (optionalBoolean(args, 'reset')) return { size: null }
      const width = optionalNumber(args, 'width', MIN_VIEWPORT, MAX_VIEWPORT)
      const height = optionalNumber(args, 'height', MIN_VIEWPORT, MAX_VIEWPORT)
      if (width === undefined || height === undefined) throw new ToolError('Give width and height, or reset.')
      return { size: { width: Math.round(width), height: Math.round(height), mobile: optionalBoolean(args, 'mobile') ?? false } }
    },
    label: ({ size }) => (size ? `Stellt ${sizeLabel(size)} ein` : 'Stellt die Originalgröße wieder her'),
    run: async (ctx, { size }) => {
      ctx.highlight(size ? `Stellt ${sizeLabel(size)} ein` : 'Stellt die Originalgröße wieder her')
      const phoneChanged = await ctx.setViewport(size)
      if (phoneChanged) {
        // The user agent and the viewport meta tag count from the next load on.
        ctx.page.contents.reload()
        await ctx.page.settle(NAVIGATION_WAIT_MS)
      } else {
        await ctx.page.settle(1000)
      }
      const now = await ctx.page.viewportSize()
      ctx.note(`${now.width} × ${now.height}${size?.mobile ? ' · mobil' : ''}`)
      ctx.record(
        size
          ? [
              ...(size.mobile ? ['// Claude had the page as a phone here: use a mobile device in test.use() (e.g. devices[\'Pixel 7\']).'] : []),
              `await page.setViewportSize({ width: ${size.width}, height: ${size.height} })`,
            ]
          : ['// Claude gave the page the size of its window again here.'],
      )
      const what = size
        ? `The page is ${now.width}×${now.height} now${size.mobile ? ', as a mobile device' : ''}${phoneChanged ? ' (loaded again)' : ''}.`
        : `The page has the size of the window again: ${now.width}×${now.height}${phoneChanged ? ' (loaded again, no mobile device any more)' : ''}.`
      return { text: `${what}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_console_messages',
    title: 'Console messages',
    description:
      'The messages of the page in its console, newest last. Errors the page did not catch (exceptions, rejected promises) come with file, line and their chain of calls.',
    properties: { onlyErrors: { type: 'boolean', description: 'Only errors.' } },
    readOnly: true,
    kind: 'console',
    whileDialog: true,
    parse: (args) => ({ onlyErrors: optionalBoolean(args, 'onlyErrors') ?? false }),
    label: () => 'Liest die Konsole',
    run: async (ctx, { onlyErrors }) => {
      const entries = ctx.consoleEntries().filter((e) => !onlyErrors || e.level === 'error')
      ctx.note(`${entries.length} Meldungen`)
      if (entries.length === 0) return { text: onlyErrors ? 'No errors in the console.' : 'The console is empty.' }
      return { text: entries.slice(-MAX_LIST_ENTRIES).map(formatConsoleEntry).join('\n') }
    },
  }),
  tool({
    name: 'browser_network_requests',
    title: 'Network requests',
    description:
      'The requests of the page since the browser was first driven (#id, method, address, status, type, time), WebSockets and event streams with their number of messages. browser_network_request shows the headers and bodies of one, or the messages of a WebSocket.',
    properties: { onlyFailed: { type: 'boolean', description: 'Only failed requests and HTTP errors.' } },
    readOnly: true,
    kind: 'network',
    whileDialog: true,
    parse: (args) => ({ onlyFailed: optionalBoolean(args, 'onlyFailed') ?? false }),
    label: () => 'Liest die Netzwerkanfragen',
    run: async (ctx, { onlyFailed }) => {
      const entries = ctx.networkEntries().filter((e) => !onlyFailed || e.failure || (e.status ?? 0) >= 400)
      ctx.note(`${entries.length} Anfragen`)
      if (entries.length === 0) return { text: onlyFailed ? 'No failed requests.' : 'No requests yet.' }
      return { text: entries.slice(-MAX_LIST_ENTRIES).map(requestLine).join('\n') }
    },
  }),
  tool({
    name: 'browser_network_request',
    title: 'Network request details',
    description:
      'One request from browser_network_requests (by its #id): what the page sent (headers, body) and what came back (status, headers, body); for a WebSocket or event stream its messages. Cookies and authorization headers are left out.',
    properties: {
      id: { type: 'number', description: 'The #id from browser_network_requests.' },
      body: { type: 'boolean', description: `Include the response body (text, up to ${MAX_BODY_CHARS} characters). Default: true.` },
      messages: { type: 'number', description: `For a WebSocket or event stream: the last this many messages (default ${DEFAULT_MESSAGES}, up to ${MESSAGE_LIMIT}).` },
    },
    required: ['id'],
    readOnly: true,
    kind: 'network',
    whileDialog: true,
    parse: (args) => {
      const id = optionalNumber(args, 'id', 1, 1_000_000_000)
      if (id === undefined) throw new ToolError('id is required: the #id from browser_network_requests.')
      return {
        id: Math.floor(id),
        body: optionalBoolean(args, 'body') ?? true,
        messages: Math.floor(optionalNumber(args, 'messages', 1, MESSAGE_LIMIT) ?? DEFAULT_MESSAGES),
      }
    },
    label: ({ id }) => `Liest Anfrage #${id}`,
    run: async (ctx, p) => {
      const entry = ctx.networkEntries().find((e) => e.id === p.id)
      if (!entry) throw new ToolError(`There is no request #${p.id} (any more): the list keeps the last 300. List them with browser_network_requests.`)
      ctx.label(`Liest ${entry.method} ${shortAddress(entry.url)}`)
      const lines = [
        `#${entry.id} ${entry.method} ${entry.url}`,
        `Type: ${entry.type}${entry.session ? ' (in a frame of another site)' : ''}${entry.routed ? `; ${entry.routed} (browser_route)` : ''}`,
        `Started: ${new Date(entry.startedAt).toISOString()}${entry.durationMs !== null ? `, took ${entry.durationMs} ms` : ''}`,
        entry.failure
          ? `Failed: ${entry.failure}`
          : entry.status === null
            ? 'Status: pending'
            : `Status: ${entry.status}${entry.statusText ? ` ${entry.statusText}` : ''}${entry.mimeType ? `, ${entry.mimeType}` : ''}${entry.encodedBytes !== null ? `, ${formatBytes(entry.encodedBytes)} over the network` : ''}${entry.fromCache ? ', from the cache' : ''}`,
        '',
        'Request headers:',
        ...headerLines(entry.requestHeaders),
      ]
      let sent = entry.postData
      if (sent === null && entry.hasPostData) {
        sent = await ctx.page
          .cdpIn<{ postData: string }>(entry.session, 'Network.getRequestPostData', { requestId: entry.requestId })
          .then((r) => r.postData)
          .catch(() => null)
      }
      if (sent !== null) lines.push('', 'Request body:', requestBodyText(sent, entry.requestHeaders['content-type'] ?? entry.requestHeaders['Content-Type'] ?? null))
      if (entry.responseHeaders) lines.push('', 'Response headers:', ...headerLines(entry.responseHeaders))
      if (entry.messages) {
        lines.push('', ...socketMessages(entry, p.messages))
      } else if (p.body && entry.status !== null && !entry.failure) {
        lines.push('', 'Response body:', await responseBody(ctx, entry))
      }
      ctx.note(entry.failure ?? String(entry.status ?? 'pending'))
      return { text: lines.join('\n') }
    },
  }),
  tool({
    name: 'browser_emulate',
    title: 'Emulate',
    description:
      'Has the page pretend another environment, to test how it behaves: dark or light mode, reduced motion, a slow or no network, a slow CPU, another language or time zone, another place (geolocation), permissions given or refused. Only what you give changes; it stays until reset or the session ends. Pages read the language and some media settings when they load: reload them afterwards (browser_history).',
    properties: {
      colorScheme: { type: 'string', enum: ['dark', 'light', 'system'], description: 'prefers-color-scheme; system: as the computer has it.' },
      reducedMotion: { type: 'boolean', description: 'prefers-reduced-motion: reduce.' },
      network: {
        type: 'string',
        enum: ['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online'],
        description: "Chrome's network presets; online: no limit.",
      },
      cpuSlowdown: { type: 'number', description: 'Run the page this many times slower, 1–20 (e.g. 4 for a mid-range phone); 1: full speed.' },
      locale: { type: 'string', description: 'Language and formats, e.g. "de-DE" or "en-US"; "" for the browser\'s own.' },
      timezone: { type: 'string', description: 'IANA time zone, e.g. "America/New_York" or "Asia/Tokyo"; "" for the computer\'s.' },
      geolocation: {
        type: 'string',
        description:
          'Where navigator.geolocation says the page is: "latitude,longitude" or "latitude,longitude,accuracy in meters", e.g. "48.8566,2.3522"; it grants the location permission. "" ends it.',
      },
      permissions: {
        type: 'object',
        properties: Object.fromEntries(PERMISSIONS.map((name) => [name, { type: 'string', enum: ['granted', 'denied', 'default'] }])),
        additionalProperties: false,
        description:
          "Permissions the page gets (granted) or is refused (denied); default: as the browser has it (it refuses them). camera and microphone are the computer's real devices; notifications show as real notifications.",
      },
      reset: { type: 'boolean', description: 'End all emulation.' },
    },
    kind: 'emulate',
    parse: (args) => parseEmulation(args),
    label: (p) => (p.reset ? 'Beendet die Emulation' : 'Emuliert eine andere Umgebung'),
    run: async (ctx, p) => {
      const before = ctx.emulation() ?? NO_EMULATION
      const next: BrowserEmulation = p.reset ? NO_EMULATION : { ...before, ...p.change, permissions: mergePermissions(before.permissions, p.permissions) }
      const labels = emulationLabels(next)
      ctx.highlight(labels.length ? `Emuliert ${labels.join(', ')}` : 'Beendet die Emulation')
      await ctx.setEmulation(next)
      ctx.label(labels.length ? `Emuliert ${labels.join(', ')}` : 'Beendet die Emulation')
      if (labels.length) ctx.note(labels.join(' · '))
      ctx.record(emulationCode(before, next))
      const now = describeEmulation(next)
      const reloadHint = p.change.locale !== undefined && p.change.locale !== before.locale ? ' Reload the page so it starts in the new language.' : ''
      return { text: now ? `The page now pretends: ${now}.${reloadHint}` : 'The page pretends nothing any more.' }
    },
  }),
  tool({
    name: 'browser_clear_site_data',
    title: 'Clear site data',
    description:
      "Clears what the browser keeps for the current site and loads the page again, so it starts as for a new visitor: its cookies (logs the browser out of it), its storage (local and session storage, IndexedDB, cache storage, service workers) and the HTTP cache. Other sites stay signed in. Ask the user first if they may be signed in there and need that login.",
    properties: {
      what: {
        type: 'array',
        items: { type: 'string', enum: ['cookies', 'storage', 'cache'] },
        description: 'Default: all three. cache is the HTTP cache of the whole browser.',
      },
      reload: { type: 'boolean', description: 'Load the page again afterwards (default true).' },
    },
    destructive: true,
    kind: 'clear',
    parse: (args) => {
      const what = args.what === undefined || args.what === null ? [...SITE_DATA] : stringList(args, 'what', 3)
      for (const item of what) if (!SITE_DATA.includes(item as SiteData)) throw new ToolError(`what takes ${SITE_DATA.join(', ')}.`)
      return { what: new Set(what as SiteData[]), reload: optionalBoolean(args, 'reload') ?? true }
    },
    label: () => 'Löscht die Daten der Seite',
    run: async (ctx, p) => {
      const url = ctx.page.contents.getURL()
      let origin: string
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('no web page')
        origin = parsed.origin
      } catch {
        throw new ToolError('The browser shows no web page; open the site first.')
      }
      ctx.highlight(`Löscht die Daten von ${shortAddress(origin)}`)
      ctx.label(`Löscht die Daten von ${shortAddress(origin)}`)
      const done: string[] = []
      if (p.what.has('cookies')) {
        const { cookies } = await ctx.page.cdp<{ cookies: { name: string; domain: string; path: string }[] }>('Network.getCookies', { urls: [url] })
        for (const cookie of cookies) await ctx.page.cdp('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path })
        done.push(cookies.length ? `${cookies.length} cookie(s) (${cut(cookies.map((c) => c.name).join(', '), 200)})` : 'no cookies (there were none)')
      }
      if (p.what.has('storage')) {
        await ctx.page.cdp('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb,websql,file_systems,service_workers,cache_storage' })
        await ctx.page.cdp('Runtime.evaluate', { expression: 'try { sessionStorage.clear() } catch {}' }).catch(() => undefined)
        done.push('local and session storage, IndexedDB, cache storage and service workers')
      }
      if (p.what.has('cache')) {
        await ctx.page.cdp('Network.clearBrowserCache')
        done.push('the HTTP cache')
      }
      ctx.note(done.length === 1 ? done[0] : `${done.length} Arten von Daten`)
      const head = `Cleared for ${origin}: ${done.join('; ')}.`
      if (!p.reload) return { text: `${head} The page still has what it loaded; reload it to start fresh.` }
      ctx.page.contents.reload()
      await ctx.page.settle(NAVIGATION_WAIT_MS)
      return { text: `${head} Loaded the page again.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_performance',
    title: 'Measure performance',
    description:
      'Measures how fast the page loads and runs: Core Web Vitals (LCP, CLS, INP once you interacted, TBT), time to first byte, requests by type with the slowest and largest, and the JS heap, DOM size and layout work. Loads the page again by default. To measure like a slow device, set browser_emulate (cpuSlowdown, network) first.',
    properties: {
      reload: { type: 'boolean', description: 'Load the page again and measure the load (default true); false: measure the page as it is now.' },
      coldCache: { type: 'boolean', description: 'With reload: without the browser cache, like a first visit.' },
    },
    kind: 'performance',
    parse: (args) => ({ reload: optionalBoolean(args, 'reload') ?? true, coldCache: optionalBoolean(args, 'coldCache') ?? false }),
    label: (p) => (p.reload ? 'Misst die Ladezeit' : 'Misst die Leistung'),
    run: async (ctx, p) => {
      ctx.highlight(p.reload ? 'Misst die Ladezeit' : 'Misst die Leistung')
      // The page's counters (layouts, scripts) count from here on: with a reload, the work of the load.
      await ctx.page.cdp('Performance.enable').catch(() => undefined)
      try {
        return await measurePerformance(ctx, p)
      } finally {
        await ctx.page.cdp('Performance.disable').catch(() => undefined)
      }
    },
  }),
]

/** What browser_emulate changed, as Playwright code where Playwright can do it while the test runs. */
export function emulationCode(before: BrowserEmulation, next: BrowserEmulation): string[] {
  const lines: string[] = []
  const media: string[] = []
  if (next.colorScheme !== before.colorScheme) media.push(`colorScheme: ${next.colorScheme ? str(next.colorScheme) : 'null'}`)
  if (next.reducedMotion !== before.reducedMotion) media.push(`reducedMotion: ${next.reducedMotion ? "'reduce'" : 'null'}`)
  if (media.length) lines.push(`await page.emulateMedia({ ${media.join(', ')} })`)
  if (next.geolocation && JSON.stringify(next.geolocation) !== JSON.stringify(before.geolocation)) {
    const { latitude, longitude, accuracy } = next.geolocation
    lines.push(`await page.context().setGeolocation({ latitude: ${latitude}, longitude: ${longitude}, accuracy: ${accuracy} })`)
  }
  const granted = Object.entries(effectivePermissions(next))
    .filter(([, setting]) => setting === 'granted')
    .map(([name]) => name)
  const grantedBefore = Object.entries(effectivePermissions(before))
    .filter(([, setting]) => setting === 'granted')
    .map(([name]) => name)
  if (granted.join() !== grantedBefore.join()) {
    lines.push(granted.length ? `await page.context().grantPermissions([${granted.map(str).join(', ')}])` : 'await page.context().clearPermissions()')
  }
  const fixed: string[] = []
  if (next.locale !== before.locale && next.locale) fixed.push(`locale: ${str(next.locale)}`)
  if (next.timezone !== before.timezone && next.timezone) fixed.push(`timezoneId: ${str(next.timezone)}`)
  if (fixed.length) lines.push(`// Claude switched the page to ${fixed.join(', ')} here: set it in test.use({ ${fixed.join(', ')} }).`)
  if (next.network !== before.network || next.cpuSlowdown !== before.cpuSlowdown) {
    lines.push('// Claude throttled the network or the CPU here; Playwright does that through a CDP session (Network.emulateNetworkConditions, Emulation.setCPUThrottlingRate).')
  }
  return lines
}

/** A request in the list of browser_network_requests. */
export function requestLine(e: NetworkEntry): string {
  const outcome = e.failure ?? e.status ?? 'pending'
  const time = e.durationMs !== null ? ` ${e.durationMs} ms` : ''
  const socket = e.messages ? ` ${e.messageCount} message(s)${e.type === 'WebSocket' ? (e.closed ? ', closed' : ', open') : ''}` : ''
  const marks = [e.fromCache && 'cache', e.session && 'frame', e.routed].filter(Boolean)
  return `#${e.id} ${e.method} ${e.url} → ${outcome} [${e.type}]${socket}${time}${marks.length ? ` (${marks.join(', ')})` : ''}`
}

/** The last messages of a WebSocket or event stream: → sent, ← received, ✕ error, with the time since it opened. */
export function socketMessages(entry: NetworkEntry, count: number): string[] {
  const messages = entry.messages ?? []
  if (messages.length === 0) return ['Messages: none yet.']
  const shown = messages.slice(-count)
  const skipped = entry.messageCount - shown.length
  const arrow = { sent: '→', received: '←', error: '✕' } as const
  const lines = shown.map((m) => {
    const at = `+${((m.at - entry.startedAt) / 1000).toFixed(3)} s`
    const data = m.binary ? `(binary, ${m.data})` : cut(m.data, 1000)
    return `${arrow[m.direction]} ${at} ${data}`
  })
  return [`Messages (${entry.messageCount}${skipped > 0 ? `, the last ${shown.length}` : ''}; → sent, ← received):`, ...lines]
}

function sizeLabel(size: { width: number; height: number; mobile: boolean }): string {
  return `${size.width} × ${size.height}${size.mobile ? ' (mobil)' : ''}`
}
