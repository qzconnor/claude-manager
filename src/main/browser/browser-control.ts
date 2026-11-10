import { webContents, type WebContents } from 'electron'
import { BLANK_PAGE } from '@shared/browser'
import type { BrowserActivity, BrowserControlState, BrowserDownload, BrowserEmulation, BrowserHighlight, BrowserLoginRequest, BrowserViewport } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'
import { browserDownloads } from '../window/browser-downloads'
import { browserLogins } from '../window/browser-logins'
import { browserPermissions } from '../window/browser-permissions'
import type { TerminalService } from '../services/terminal-service'
import type { ActionContext, ActionStep, BrowserTab, ConsoleEntry, FileChooser, PageEvent, RecordedStep } from './action-context'
import { autoAttachFrames, PageFrames } from './frames'
import { endSockets, markRouted, networkEvent, type NetworkEntry, shortUrl } from './network-log'
import { exceptionEntry, mergeError } from './page-errors'
import { answerRequest, enableRoutes, findRoute, MAX_ROUTES, type PausedRequest, preflightMethod, type Route, routedText, routeState } from './page-routes'
import { delay, isClaudesMouse, PageDriver, withTimeout } from './page-driver'
import {
  caughtDialog,
  type CaughtDialog,
  describeDialog,
  DIALOG_BINDING,
  DIALOG_GRACE_MS,
  DIALOG_SHIM_OFF,
  type DialogAnswer,
  dialogShim,
  dialogSignal,
  type DialogSignal,
  type PageDialog,
} from './page-dialogs'
import { applyEmulation, applyFrameEmulation, isEmulating, setPhoneMode, untilViewport } from './page-emulation'
import { pointerMoveMs, type PointerSpot } from './pointer'
import { snapshotChanges } from './snapshot-diff'
import { ToolError } from './tool-args'

/** Claude's last action keeps the page drawn this long, also while its tab is hidden. */
const ACTIVE_MS = 60_000
/** How long Claude's next action waits for the user to hand a browser back. */
const TAKE_OVER_WAIT_MS = 10 * 60_000
/** How long a new browser may take until its page is there. */
const ATTACH_WAIT_MS = 20_000
const LOG_LIMIT = 300
const CONSOLE_LIMIT = 300

const PAGE_EVENT_LIMIT = 50
/** Steps of a session's recording (browser_generate_test); older ones go. */
const RECORDING_LIMIT = 500

interface Control {
  sessionId: string
  busy: boolean
  takenOver: boolean
  lastActionAt: number
}

/** The lines of a Playwright test one action recorded (see `ActionContext.record`). */
interface Recorded {
  before: string[]
  code: string[]
  beforeLast: string[]
}

interface Browser {
  id: string
  contents: WebContents | null
  waiters: Set<(contents: WebContents) => void>
  log: BrowserActivity[]
  nextActivity: number
  control: Control | null
  /** Claude's actions, one after another. */
  queue: Promise<unknown>
  consoleEntries: ConsoleEntry[]
  /** By session and request id of the protocol. */
  network: Map<string, NetworkEntry>
  nextRequest: number
  /** What Claude's routes did with requests the network log doesn't know yet. */
  routed: Map<string, string>
  /** Claude's routes for the page's requests (browser_route), oldest first; they end with the session. */
  routes: Route[]
  nextRoute: number
  /** The page's frames of other sites and their DevTools sessions. */
  frames: PageFrames
  /** The last snapshot Claude got of the page, to send only what changed after the next action. */
  lastSnapshot: { sessionId: string; doc: string; text: string } | null
  /** What the page pretends for Claude; it ends with the session. */
  emulation: BrowserEmulation | null
  dialog: PageDialog | null
  dialogSignal: DialogSignal
  caught: CaughtDialog[]
  dialogAnswer: DialogAnswer | null
  /** The script that catches dialogs in new documents while Claude acts. */
  dialogScript: string | null
  disarmTimer: NodeJS.Timeout | null
  chooser: FileChooser | null
  /** The DevTools protocol is attached and its domains are on. */
  protocol: boolean
  idleTimer: NodeJS.Timeout | null
  releaseWaiters: Set<() => void>
  /** Where Claude's pointer was last (window pixels of the page), for its next move. */
  pointer: PointerSpot | null
  /** The size Claude gave the page; it ends with the session. */
  viewport: BrowserViewport | null
  /** Popups and downloads, for the result of the action that caused them. */
  events: PageEvent[]
  /** The log line of each running download of the page. */
  downloads: Map<string, BrowserActivity>
}

const TAKEN_OVER =
  'The user is using the browser themselves right now (they took it over in Claude Manager) and has not handed it back. Ask them to hand it back with "Zurückgeben", or wait.'
const HANDED_BACK =
  'The user had taken the browser over and has now handed it back. Your action was NOT performed, the page may have changed. Current page:\n'

/**
 * The browser tabs Claude drives through the app's MCP server: which browser belongs to which
 * session, one action after another, what the page reports (console, network, dialogs) and the log
 * the window shows next to the page.
 */
type Events = {
  /** A new or changed line of a browser's log. */
  activity: [browserId: string, activity: BrowserActivity]
  /** Who drives a browser now; null when no session does. */
  control: [browserId: string, control: BrowserControlState | null]
  /** Where Claude acts in the page right now. */
  highlight: [browserId: string, highlight: BrowserHighlight]
  /** The page needs the window's keyboard, for Claude's keys. */
  focus: [browserId: string]
  /** The user pressed the mouse in the page (not Claude): its part of the tab becomes the active one. */
  userClick: [browserId: string]
}

export class BrowserControl extends TypedEmitter<Events> {
  private readonly browsers = new Map<string, Browser>()
  /** The browser each session used last, by the session's terminal. */
  private readonly sessionBrowsers = new Map<string, string>()
  /** The session that opened a browser (it may close it again), by the browser. */
  private readonly openedBy = new Map<string, string>()
  private readonly listening = new WeakSet<WebContents>()
  /** What each session did in its browsers, as steps of a Playwright test (browser_generate_test). */
  private readonly recordings = new Map<string, RecordedStep[]>()

  constructor(private readonly terminals: TerminalService) {
    super()
    browserDownloads.on('started', (download) => this.onDownload(download))
    browserDownloads.on('finished', (download) => this.onDownload(download))
    terminals.on('changed', (list) => {
      const open = new Set(list.map((t) => t.id))
      for (const id of [...this.browsers.keys()]) if (!open.has(id)) this.forget(id)
      for (const [browser, session] of [...this.openedBy]) if (!open.has(browser) || !open.has(session)) this.openedBy.delete(browser)
      for (const session of [...this.recordings.keys()]) if (!open.has(session)) this.recordings.delete(session)
      for (const [session, browser] of [...this.sessionBrowsers]) {
        if (!open.has(session)) this.sessionBrowsers.delete(session)
        else if (!open.has(browser)) {
          // Another tab the session opened takes over, else the next action opens one.
          const next = [...this.openedBy].find(([id, by]) => by === session && open.has(id))?.[0]
          if (next) this.sessionBrowsers.set(session, next)
          else this.sessionBrowsers.delete(session)
        }
      }
      // The session that drove a browser is closed: the browser is the user's again, in its own size.
      for (const browser of this.browsers.values()) {
        if (browser.control && !open.has(browser.control.sessionId)) {
          browser.control = null
          browser.lastSnapshot = null
          void this.dropViewport(browser)
          void this.dropEmulation(browser)
          void this.dropRoutes(browser)
          this.emitControl(browser)
        }
      }
    })
  }

  /** The window's `<webview>` of a browser tab is ready (its id comes from the window). */
  attach(browserId: string, contentsId: number, host: WebContents): void {
    if (this.terminals.list().find((t) => t.id === browserId)?.mode !== 'browser') return
    const contents = webContents.fromId(contentsId)
    if (!contents || contents.getType() !== 'webview' || contents.hostWebContents !== host) return
    const browser = this.state(browserId)
    if (browser.contents === contents) return
    browser.contents = contents
    browser.protocol = false
    browser.dialog = null
    browser.chooser = null
    browser.frames = new PageFrames()
    browser.lastSnapshot = null
    contents.on('console-message', (event) => this.onConsole(browser, contents, event))
    // The window sees no clicks in the page, and the page's focus is no help: it may have it already.
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown' && !isClaudesMouse(contents)) this.emit('userClick', browser.id)
    })
    // A popup (e.g. a login of another site) opens as a window of its own, which Claude can't drive.
    contents.on('did-create-window', (_window, details) => {
      if (browser.contents !== contents) return
      this.pageEvent(
        browser,
        `The page opened a popup window: ${details.url}. It is a separate window that you cannot see or drive; the user can complete it there (e.g. a login). Then continue in this tab.`,
      )
      if (browser.control) this.addActivity(browser, { kind: 'popup', label: `Fenster geöffnet: ${shortUrl(details.url)}`, status: 'done' })
    })
    contents.once('destroyed', () => {
      if (browser.contents === contents) {
        browser.contents = null
        browser.protocol = false
      }
    })
    for (const resolve of browser.waiters) resolve(contents)
    browser.waiters.clear()
  }

  log(browserId: string): BrowserActivity[] {
    return [...(this.browsers.get(browserId)?.log ?? [])]
  }

  clearLog(browserId: string): void {
    const browser = this.browsers.get(browserId)
    if (browser) browser.log = []
  }

  controls(): Record<string, BrowserControlState> {
    const result: Record<string, BrowserControlState> = {}
    for (const browser of this.browsers.values()) {
      const state = this.controlState(browser)
      if (state) result[browser.id] = state
    }
    return result
  }

  /** The user takes a browser over from Claude, or hands it back. */
  takeOver(browserId: string, takenOver: boolean): void {
    const browser = this.browsers.get(browserId)
    if (!browser?.control || browser.control.takenOver === takenOver) return
    browser.control.takenOver = takenOver
    this.addActivity(browser, {
      kind: 'control',
      label: takenOver ? 'Du hast den Browser übernommen' : 'Du hast den Browser an Claude zurückgegeben',
      status: 'done',
    })
    if (!takenOver) {
      for (const resolve of browser.releaseWaiters) resolve()
      browser.releaseWaiters.clear()
    }
    this.emitControl(browser)
  }

  /** The user's way back from the size Claude gave the page. */
  async resetViewport(browserId: string): Promise<void> {
    const browser = this.browsers.get(browserId)
    if (!browser?.viewport) return
    await this.dropViewport(browser)
    this.addActivity(browser, { kind: 'control', label: 'Du hast die Originalgröße wiederhergestellt', status: 'done' })
    this.emitControl(browser)
  }

  /** The page fills its part of the tab again, and is no phone any more. */
  private async dropViewport(browser: Browser): Promise<void> {
    const mobile = browser.viewport?.mobile ?? false
    browser.viewport = null
    const contents = browser.contents
    if (!mobile || !contents || contents.isDestroyed() || !contents.debugger.isAttached()) return
    await setPhoneMode(new PageDriver(contents), false, browser.emulation?.locale ?? null).catch(() => undefined)
  }

  /** The user's way back from what Claude has the page pretend. */
  async resetEmulation(browserId: string): Promise<void> {
    const browser = this.browsers.get(browserId)
    if (!browser?.emulation) return
    await this.dropEmulation(browser)
    this.addActivity(browser, { kind: 'control', label: 'Du hast die Emulation beendet', status: 'done' })
    this.emitControl(browser)
  }

  /** The page is itself again: no dark mode, slow network or other place of Claude's. */
  private async dropEmulation(browser: Browser): Promise<void> {
    if (!browser.emulation) return
    browser.emulation = null
    const contents = browser.contents
    if (!contents || contents.isDestroyed()) return
    browserPermissions.set(contents, {})
    if (!contents.debugger.isAttached()) return
    await applyEmulation(new PageDriver(contents), null, browser.viewport?.mobile ?? false, browser.frames.frameSessions()).catch(() => undefined)
  }

  /** The user's way back from Claude's routes for the page's requests. */
  async resetRoutes(browserId: string): Promise<void> {
    const browser = this.browsers.get(browserId)
    if (!browser?.routes.length) return
    await this.dropRoutes(browser)
    this.addActivity(browser, { kind: 'control', label: 'Du hast die Routen beendet', status: 'done' })
    this.emitControl(browser)
  }

  /** The page's requests go to the network again, all of them. */
  private async dropRoutes(browser: Browser): Promise<void> {
    if (browser.routes.length === 0) return
    browser.routes = []
    await this.applyRoutes(browser)
  }

  /** Has the protocol hold the requests of the browser's routes, in the page and its frames in processes of their own. */
  private async applyRoutes(browser: Browser): Promise<void> {
    const contents = browser.contents
    if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return
    const page = new PageDriver(contents)
    await enableRoutes(page, undefined, browser.routes)
    for (const session of browser.frames.frameSessions()) await enableRoutes(page, session, browser.routes).catch(() => undefined)
  }

  /** What a session did in its browsers so far, as steps of a Playwright test. */
  recording(sessionId: string): RecordedStep[] {
    return (this.recordings.get(sessionId) ?? []).map((step) => ({ ...step, code: [...step.code] }))
  }

  clearRecording(sessionId: string): void {
    this.recordings.delete(sessionId)
  }

  /**
   * Runs one action of a session in its browser: opens the browser next to the session when it has
   * none, waits while the user has taken it over, logs the action and shows it as busy.
   */
  async perform<T>(sessionId: string, step: ActionStep, work: (ctx: ActionContext) => Promise<T>): Promise<T> {
    const browser = this.state(this.browserFor(sessionId))
    const run = browser.queue.then(() => this.run(browser, sessionId, step, work))
    browser.queue = run.catch(() => undefined)
    return run
  }

  private async run<T>(browser: Browser, sessionId: string, step: ActionStep, work: (ctx: ActionContext) => Promise<T>): Promise<T> {
    if (browser.control?.takenOver) {
      const back = await this.waitForRelease(browser)
      if (!back) throw new ToolError(TAKEN_OVER)
      const contents = await this.contentsOf(browser)
      browser.lastSnapshot = null
      const snapshot = await new PageDriver(contents, undefined, browser.frames)
        .snapshot()
        .then((shot) => shot.text)
        .catch(() => '')
      throw new ToolError(HANDED_BACK + snapshot)
    }
    const wasActive = this.isActive(browser)
    browser.control = { sessionId, busy: true, takenOver: false, lastActionAt: Date.now() }
    this.emitControl(browser)
    const activity = this.addActivity(browser, { kind: step.kind, label: step.label, status: 'running' })
    const started = Date.now()
    let detail: string | null = null
    let image: string | null = null
    /** What the action waits on besides its work; it ends with it. */
    const cleanups: Array<() => void> = []
    /** The lines of a Playwright test the action recorded; they count once it is done. */
    const recorded: Recorded = { before: [], code: [], beforeLast: [] }
    try {
      const contents = await this.contentsOf(browser)
      // A page that was hidden gets its size from the window first.
      if (!wasActive) await delay(300)
      const page = new PageDriver(contents, () => this.emit('focus', browser.id), browser.frames)
      await this.ensureProtocol(browser, contents, page)
      if (browser.dialog && !step.whileDialog) {
        throw new ToolError(`${describeDialog(browser.dialog)} Answer it with browser_handle_dialog first.`)
      }
      if (!browser.dialog) await this.catchDialogs(browser, page)
      const startUrl = contents.getURL()
      const ctx = this.context(browser, page, activity, cleanups, recorded, {
        note: (text) => (detail = text),
        image: (data) => (image = data),
      })
      const result = await work(ctx)
      this.updateActivity(browser, activity, { status: 'done', detail, image, durationMs: Date.now() - started })
      this.commitRecording(sessionId, browser.id, startUrl, recorded)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateActivity(browser, activity, { status: 'error', detail: message.split('\n')[0], durationMs: Date.now() - started })
      throw error
    } finally {
      for (const cleanup of cleanups) cleanup()
      if (browser.control) {
        browser.control.busy = false
        browser.control.lastActionAt = Date.now()
      }
      this.emitControl(browser)
      this.scheduleIdle(browser)
      this.releaseDialogs(browser)
    }
  }

  /** Adds what an action recorded to its session's recording. */
  private commitRecording(sessionId: string, browserId: string, url: string, recorded: Recorded): void {
    const steps = this.recordings.get(sessionId) ?? []
    const last = steps.at(-1)
    if (recorded.beforeLast.length && last) last.code.unshift(...recorded.beforeLast)
    else recorded.before.unshift(...recorded.beforeLast)
    const code = [...recorded.before, ...recorded.code]
    if (code.length) steps.push({ browserId, url, code })
    if (steps.length > RECORDING_LIMIT) steps.splice(0, steps.length - RECORDING_LIMIT)
    if (steps.length) this.recordings.set(sessionId, steps)
  }

  /** The page answers its dialogs itself from now on, until `releaseDialogs`. */
  private async catchDialogs(browser: Browser, page: PageDriver): Promise<void> {
    if (browser.disarmTimer) clearTimeout(browser.disarmTimer)
    browser.disarmTimer = null
    const source = dialogShim(browser.dialogAnswer)
    try {
      if (browser.dialogScript) await page.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: browser.dialogScript })
      browser.dialogScript = null
      const { identifier } = await page.cdp<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source })
      browser.dialogScript = identifier
      await withTimeout(page.cdp('Runtime.evaluate', { expression: source }), 2000, 'busy')
    } catch {
      // A page that is busy gets it with its next document; a dialog then comes the usual way.
    }
  }

  private releaseDialogs(browser: Browser): void {
    if (browser.disarmTimer) clearTimeout(browser.disarmTimer)
    browser.disarmTimer = setTimeout(() => {
      browser.disarmTimer = null
      const contents = browser.contents
      if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return
      const page = new PageDriver(contents)
      const script = browser.dialogScript
      browser.dialogScript = null
      if (script) void page.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: script }).catch(() => undefined)
      void withTimeout(page.cdp('Runtime.evaluate', { expression: DIALOG_SHIM_OFF }), 2000, 'busy').catch(() => undefined)
    }, DIALOG_GRACE_MS)
  }

  private context(
    browser: Browser,
    page: PageDriver,
    activity: BrowserActivity,
    cleanups: Array<() => void>,
    recorded: Recorded,
    sink: { note(text: string): void; image(data: string): void },
  ): ActionContext {
    return {
      browserId: browser.id,
      page,
      label: (text) => this.updateActivity(browser, activity, { label: text }),
      note: (text) => sink.note(text),
      image: (image) => sink.image(`data:image/jpeg;base64,${image.resize({ width: 360 }).toJPEG(70).toString('base64')}`),
      highlight: (label, box, pointer) => {
        const zoom = page.zoom()
        const point = pointer ? { x: pointer.x * zoom, y: pointer.y * zoom } : null
        const moveMs = point ? pointerMoveMs(browser.pointer, point) : 0
        if (point) browser.pointer = point
        const highlight: BrowserHighlight = {
          label,
          rect: box ? { x: box.x * zoom, y: box.y * zoom, width: box.width * zoom, height: box.height * zoom } : null,
          point,
          click: pointer?.click === true,
          moveMs,
        }
        this.emit('highlight', browser.id, highlight)
        return moveMs
      },
      snapshot: async (changes) => {
        const shot = await page.snapshot()
        const sessionId = browser.control?.sessionId ?? ''
        const last = browser.lastSnapshot
        browser.lastSnapshot = { sessionId, doc: shot.doc, text: shot.text }
        if (!changes || !last || last.sessionId !== sessionId || last.doc !== shot.doc) return shot.text
        return snapshotChanges(last.text, shot.text) ?? shot.text
      },
      consoleEntries: () => [...browser.consoleEntries],
      networkEntries: () => [...browser.network.values()].sort((a, b) => a.id - b.id),
      emulation: () => (browser.emulation ? { ...browser.emulation } : null),
      setEmulation: async (emulation) => {
        browser.emulation = emulation && isEmulating(emulation) ? { ...emulation } : null
        await applyEmulation(page, browser.emulation, browser.viewport?.mobile ?? false, browser.frames.frameSessions())
        this.emitControl(browser)
      },
      routes: () => browser.routes.map(routeState),
      addRoute: async (spec) => {
        if (browser.routes.length >= MAX_ROUTES) throw new ToolError(`There are ${MAX_ROUTES} routes already; remove some first.`)
        const route: Route = { ...spec, id: browser.nextRoute++, hits: 0 }
        browser.routes.push(route)
        await this.applyRoutes(browser)
        this.emitControl(browser)
        return routeState(route)
      },
      removeRoutes: async (ids) => {
        const before = browser.routes.length
        browser.routes = ids === null ? [] : browser.routes.filter((route) => !ids.includes(route.id))
        const removed = before - browser.routes.length
        if (removed) {
          await this.applyRoutes(browser)
          this.emitControl(browser)
        }
        return removed
      },
      viewport: () => (browser.viewport ? { width: browser.viewport.width, height: browser.viewport.height, mobile: browser.viewport.mobile } : null),
      record: (lines, where = 'step') => {
        const list = where === 'before' ? recorded.before : where === 'beforeLast' ? recorded.beforeLast : recorded.code
        list.push(...lines)
      },
      dialog: () => browser.dialog,
      untilDialog: () => browser.dialogSignal.promise,
      caughtDialogs: (since) => browser.caught.filter((d) => d.at >= since),
      pageEvents: () => browser.events.splice(0),
      login: () => browserLogins.pendingFor(page.contents),
      untilLogin: () =>
        new Promise<BrowserLoginRequest>((resolve) => {
          const off = browserLogins.on('request', (request) => {
            if (page.contents.isDestroyed() || request.contentsId !== page.contents.id) return
            off()
            resolve(request)
          })
          cleanups.push(off)
        }),
      setDialogAnswer: (answer) => (browser.dialogAnswer = answer),
      setViewport: async (size) => {
        const before = browser.viewport
        const phoneChanged = (size?.mobile ?? false) !== (before?.mobile ?? false)
        browser.viewport = size ? { ...size, zoom: page.zoom() } : null
        if (phoneChanged) await setPhoneMode(page, size?.mobile ?? false, browser.emulation?.locale ?? null)
        this.emitControl(browser)
        await untilViewport(page, size, before)
        return phoneChanged
      },
      fileChooser: () => browser.chooser,
      clearFileChooser: () => (browser.chooser = null),
      interceptFileChooser: async (work) => {
        await page.cdp('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined)
        try {
          return await work()
        } finally {
          // A chooser the page opens a moment later still comes to Claude.
          setTimeout(() => void page.cdp('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined), 1500)
        }
      },
    }
  }

  /**
   * The browser of a session: the one it used last, else one that belongs to it (opened beside it,
   * also by the user), else a new one next to it. Synchronous, so two calls of a session at once don't
   * open two browsers.
   */
  private browserFor(sessionId: string): string {
    const list = this.terminals.list()
    const current = this.currentOf(sessionId, list)
    if (current) {
      this.sessionBrowsers.set(sessionId, current)
      return current
    }
    if (!list.some((t) => t.id === sessionId)) throw new ToolError('This session is no longer open in Claude Manager.')
    const { id } = this.terminals.openBrowser({ split: { terminalId: sessionId, direction: 'row' } })
    this.openedBy.set(id, sessionId)
    this.sessionBrowsers.set(sessionId, id)
    return id
  }

  /** The browser the session's next action goes to, if it has one: the one it used last, else its first own. */
  private currentOf(sessionId: string, list = this.terminals.list()): string | null {
    const known = this.sessionBrowsers.get(sessionId)
    if (known && this.isTabOf(sessionId, known, list)) return known
    return this.terminals.browsersOf(sessionId)[0] ?? null
  }

  /** A browser the session may use: one of its own, or one of the user's that belongs to no session. */
  private isTabOf(sessionId: string, browserId: string, list = this.terminals.list()): boolean {
    if (list.find((t) => t.id === browserId)?.mode !== 'browser') return false
    const owner = this.terminals.browserOwner(browserId)
    return owner === null || owner === sessionId
  }

  /**
   * The browser tabs a session sees in browser_tabs, in the app's order: its own and the user's that
   * belong to no session. The pages of other sessions are theirs; they don't show up.
   */
  tabs(sessionId: string): BrowserTab[] {
    const list = this.terminals.list()
    const current = this.currentOf(sessionId, list)
    return list
      .filter((t) => this.isTabOf(sessionId, t.id, list))
      .map((t, index) => {
        const control = this.browsers.get(t.id)?.control
        const other = control && control.sessionId !== sessionId && this.isActive(this.browsers.get(t.id)!) ? control.sessionId : null
        return {
          index,
          id: t.id,
          title: t.title,
          url: t.url ?? BLANK_PAGE,
          current: t.id === current,
          openedBySession: this.openedBy.get(t.id) === sessionId,
          otherSession: other ? (list.find((s) => s.id === other)?.title ?? 'Claude') : null,
        }
      })
  }

  /**
   * Opens another browser tab for the session and makes it the current one: below its current
   * browser (or its last one, while it uses one of the user's), or next to the session when it has
   * none yet. So the tab belongs to the session too.
   */
  openTab(sessionId: string): BrowserTab {
    const list = this.terminals.list()
    if (!list.some((t) => t.id === sessionId)) throw new ToolError('This session is no longer open in Claude Manager.')
    const current = this.sessionBrowsers.get(sessionId)
    const own = this.terminals.browsersOf(sessionId)
    const anchor = current && own.includes(current) ? current : own.at(-1)
    const split = anchor ? { terminalId: anchor, direction: 'column' as const } : { terminalId: sessionId, direction: 'row' as const }
    const { id } = this.terminals.openBrowser({ split })
    this.openedBy.set(id, sessionId)
    this.sessionBrowsers.set(sessionId, id)
    return this.tabs(sessionId).find((t) => t.id === id)!
  }

  /** The session's next actions go to this tab; not while another session drives it. */
  selectTab(sessionId: string, index: number): BrowserTab {
    const tab = this.tabAt(sessionId, index)
    if (tab.otherSession) throw new ToolError(`Another Claude session ("${tab.otherSession}") is using this tab right now. Pick another one or open a new one.`)
    this.sessionBrowsers.set(sessionId, tab.id)
    return { ...tab, current: true }
  }

  /** Closes a tab the session opened, without index its current one; the user's own tabs stay. */
  closeTab(sessionId: string, index?: number): BrowserTab {
    const tab = index === undefined ? this.tabs(sessionId).find((t) => t.current) : this.tabAt(sessionId, index)
    if (!tab) throw new ToolError('You have no current browser tab. List them with browser_tabs and close one by its index.')
    if (!tab.openedBySession) throw new ToolError('This tab was not opened by you. Ask the user to close it if it should go.')
    this.terminals.close(tab.id)
    return tab
  }

  private tabAt(sessionId: string, index: number): BrowserTab {
    const tabs = this.tabs(sessionId)
    const tab = tabs[index]
    if (!tab) throw new ToolError(tabs.length ? `There is no tab ${index}; the tabs are 0 to ${tabs.length - 1}. List them with browser_tabs.` : 'There are no browser tabs.')
    return tab
  }

  private async contentsOf(browser: Browser): Promise<WebContents> {
    if (browser.contents && !browser.contents.isDestroyed()) return browser.contents
    let waiter!: (contents: WebContents) => void
    const attached = new Promise<WebContents>((resolve) => (waiter = resolve))
    browser.waiters.add(waiter)
    try {
      return await withTimeout(attached, ATTACH_WAIT_MS, 'The browser did not start. Is the Claude Manager window open?')
    } finally {
      browser.waiters.delete(waiter)
    }
  }

  private async ensureProtocol(browser: Browser, contents: WebContents, page: PageDriver): Promise<void> {
    if (browser.protocol && contents.debugger.isAttached()) return
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    if (!this.listening.has(contents)) {
      this.listening.add(contents)
      contents.debugger.on('message', (_event, method, params, sessionId) =>
        this.onProtocol(browser, contents, method, params, typeof sessionId === 'string' && sessionId ? sessionId : undefined),
      )
      contents.debugger.on('detach', () => {
        if (browser.contents === contents) browser.protocol = false
      })
    }
    await page.cdp('Page.enable')
    await page.cdp('Network.enable')
    await page.cdp('Runtime.enable')
    await page.cdp('Runtime.addBinding', { name: DIALOG_BINDING })
    // The page acts as if it had the keyboard: the window gives it back to the user (BrowserPane).
    await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
    // Frames of other sites in processes of their own get sessions of their own (see frames.ts).
    await autoAttachFrames(page, undefined)
    // A new connection starts without the phone mode and the emulation Claude chose.
    if (browser.viewport?.mobile) await setPhoneMode(page, true, browser.emulation?.locale ?? null).catch(() => undefined)
    if (browser.emulation) await applyEmulation(page, browser.emulation, browser.viewport?.mobile ?? false, []).catch(() => undefined)
    if (browser.routes.length) await enableRoutes(page, undefined, browser.routes).catch(() => undefined)
    browser.dialogScript = null
    browser.protocol = true
  }

  /**
   * A frame in a process of its own got its session: requests, errors, frames in it, Claude's
   * emulation and routes; then it may run.
   */
  private async setUpFrame(browser: Browser, contents: WebContents, session: string): Promise<void> {
    const page = new PageDriver(contents)
    try {
      await page.cdpIn(session, 'Network.enable').catch(() => undefined)
      await page.cdpIn(session, 'Runtime.enable').catch(() => undefined)
      await autoAttachFrames(page, session)
      if (browser.emulation) await applyFrameEmulation(page, session, browser.emulation, browser.viewport?.mobile ?? false)
      if (browser.routes.length) await enableRoutes(page, session, browser.routes).catch(() => undefined)
    } finally {
      // It waits for this (autoAttachFrames), whatever went wrong.
      await page.cdpIn(session, 'Runtime.runIfWaitingForDebugger').catch(() => undefined)
    }
  }

  private onProtocol(browser: Browser, contents: WebContents, method: string, params: Record<string, unknown>, session: string | undefined): void {
    if (method === 'Target.attachedToTarget') {
      const target = params.targetInfo as { targetId: string; type: string }
      const child = params.sessionId as string
      if (browser.contents === contents && target.type === 'iframe') {
        browser.frames.attached(target.targetId, child)
        void this.setUpFrame(browser, contents, child)
      } else {
        // Not a frame Claude reads (or of a page the browser left): it must not wait for one.
        contents.debugger.sendCommand('Runtime.runIfWaitingForDebugger', undefined, child).catch(() => undefined)
      }
      return
    }
    // A held request must go on, also one of a page the browser left.
    if (method === 'Fetch.requestPaused') {
      void this.onPaused(browser, contents, params as unknown as PausedRequest & { networkId?: string }, session)
      return
    }
    if (browser.contents !== contents) return
    if (method.startsWith('Network.')) {
      const warning = networkEvent(browser, method, params, session)
      if (warning) this.pageWarning(browser, 'network', warning)
      return
    }
    switch (method) {
      case 'Target.detachedFromTarget':
        browser.frames.detached(params.sessionId as string)
        return
      case 'Runtime.exceptionThrown':
        this.addConsole(browser, exceptionEntry(params, session !== undefined))
        return
      case 'Runtime.bindingCalled': {
        if (params.name !== DIALOG_BINDING || session !== undefined) return
        const caught = caughtDialog(params.payload)
        if (!caught) return
        // Claude's answer was for this one.
        if (caught.type !== 'alert') browser.dialogAnswer = null
        browser.caught.push(caught)
        if (browser.caught.length > 20) browser.caught.shift()
        const message = caught.message.split('\n')[0].slice(0, 160)
        this.addActivity(browser, { kind: 'page-dialog', label: `Dialog „${message}“ → ${caught.answer}`, status: 'done' })
        return
      }
      case 'Page.javascriptDialogOpening': {
        if (session !== undefined) return
        const dialog = { type: String(params.type), message: String(params.message ?? ''), defaultPrompt: String(params.defaultPrompt ?? '') }
        browser.dialog = dialog
        browser.dialogSignal.resolve(dialog)
        browser.dialogSignal = dialogSignal()
        this.pageWarning(browser, 'page-dialog', `Dialog: ${dialog.message.slice(0, 200)}`)
        return
      }
      case 'Page.javascriptDialogClosed':
        if (session === undefined) browser.dialog = null
        return
      case 'Page.fileChooserOpened':
        if (session !== undefined) return
        browser.chooser = { backendNodeId: Number(params.backendNodeId), multiple: params.mode === 'selectMultiple' }
        return
      case 'Page.frameNavigated':
        // A new document in the tab: the WebSockets of the one before went with it, without an event.
        if (session === undefined && !(params.frame as { parentId?: string } | undefined)?.parentId) endSockets(browser)
        return
    }
  }

  private onConsole(browser: Browser, contents: WebContents, event: { level?: string; message?: string; sourceId?: string; lineNumber?: number }): void {
    if (browser.contents !== contents) return
    this.addConsole(browser, {
      at: new Date().toISOString(),
      level: String(event.level ?? 'info'),
      text: String(event.message ?? '').slice(0, 2000),
      source: event.sourceId ? `${event.sourceId}:${event.lineNumber ?? 0}` : '',
      stack: null,
    })
  }

  /** A message of the console or an error the page didn't catch; both report such an error, it is one entry. */
  private addConsole(browser: Browser, entry: ConsoleEntry): void {
    if (!mergeError(browser.consoleEntries, entry)) return
    if (browser.consoleEntries.length > CONSOLE_LIMIT) browser.consoleEntries.shift()
    if (entry.level === 'error') this.pageWarning(browser, 'console', `Konsole: ${entry.text.split('\n')[0].slice(0, 200)}`)
  }

  /** A request the protocol holds for Claude's routes: answered by the newest route that takes it, else let go. */
  private async onPaused(browser: Browser, contents: WebContents, paused: PausedRequest & { networkId?: string }, session: string | undefined): Promise<void> {
    const page = new PageDriver(contents)
    const preflight = preflightMethod(paused.request)
    const route = browser.contents === contents ? (findRoute(browser.routes, paused.request.url, paused.request.method, preflight) ?? null) : null
    if (route && !preflight) {
      route.hits++
      if (route.timesLeft !== null && --route.timesLeft <= 0) {
        browser.routes = browser.routes.filter((r) => r !== route)
        void this.applyRoutes(browser).catch(() => undefined)
      }
      markRouted(browser, session, paused.networkId ?? paused.requestId, routedText(route))
      this.pageNote(browser, 'route', `Route ${route.id}: ${paused.request.method} ${shortUrl(paused.request.url)}`, 'done')
      this.emitControl(browser)
    }
    await answerRequest(page, session, paused, route)
  }

  /** A download of a browser's page started or ended: in its log while Claude drives it, and for Claude. */
  private onDownload(download: BrowserDownload): void {
    const browser = [...this.browsers.values()].find((b) => b.contents && !b.contents.isDestroyed() && b.contents.id === download.contentsId)
    if (!browser) return
    const running = browser.downloads.get(download.id)
    if (download.state === 'progressing') {
      this.pageEvent(browser, `A download started: "${download.filename}", saved to ${download.path}.`)
      if (browser.control) {
        browser.downloads.set(download.id, this.addActivity(browser, { kind: 'download', label: `Lädt ${download.filename} herunter`, status: 'running' }))
      }
      return
    }
    browser.downloads.delete(download.id)
    const done = download.state === 'completed'
    const outcome = done ? `finished (${download.totalBytes} bytes)` : download.state === 'cancelled' ? 'was cancelled' : 'failed'
    this.pageEvent(browser, `The download "${download.filename}" ${outcome}${done ? `: ${download.path}` : ''}.`)
    if (running) {
      this.updateActivity(browser, running, {
        status: done ? 'done' : 'error',
        detail: done ? download.path : download.state === 'cancelled' ? 'Abgebrochen' : 'Fehlgeschlagen',
      })
    }
  }

  /** Only while a session drives the page: what the user does by themselves is no news for Claude. */
  private pageEvent(browser: Browser, text: string): void {
    if (!browser.control) return
    browser.events.push({ at: new Date().toISOString(), text })
    if (browser.events.length > PAGE_EVENT_LIMIT) browser.events.shift()
  }

  /** An error the page reported by itself, in the log while Claude drives it; repeats are left out. */
  private pageWarning(browser: Browser, kind: string, label: string): void {
    this.pageNote(browser, kind, label, 'warning')
  }

  /** Something the page did by itself, in the log while Claude drives it; repeats are left out. */
  private pageNote(browser: Browser, kind: string, label: string, status: 'warning' | 'done'): void {
    if (!browser.control) return
    if (browser.log.slice(-20).some((a) => a.kind === kind && a.label === label)) return
    this.addActivity(browser, { kind, label, status })
  }

  private waitForRelease(browser: Browser): Promise<boolean> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        browser.releaseWaiters.delete(done)
        resolve(true)
      }
      const timer = setTimeout(() => {
        browser.releaseWaiters.delete(done)
        resolve(false)
      }, TAKE_OVER_WAIT_MS)
      browser.releaseWaiters.add(done)
    })
  }

  private state(id: string): Browser {
    let browser = this.browsers.get(id)
    if (!browser) {
      browser = {
        id,
        contents: null,
        waiters: new Set(),
        log: [],
        nextActivity: 1,
        control: null,
        queue: Promise.resolve(),
        consoleEntries: [],
        network: new Map(),
        nextRequest: 1,
        routed: new Map(),
        routes: [],
        nextRoute: 1,
        frames: new PageFrames(),
        lastSnapshot: null,
        emulation: null,
        dialog: null,
        dialogSignal: dialogSignal(),
        caught: [],
        dialogAnswer: null,
        dialogScript: null,
        disarmTimer: null,
        chooser: null,
        protocol: false,
        idleTimer: null,
        releaseWaiters: new Set(),
        pointer: null,
        viewport: null,
        events: [],
        downloads: new Map(),
      }
      this.browsers.set(id, browser)
    }
    return browser
  }

  private forget(id: string): void {
    const browser = this.browsers.get(id)
    if (!browser) return
    if (browser.idleTimer) clearTimeout(browser.idleTimer)
    if (browser.disarmTimer) clearTimeout(browser.disarmTimer)
    for (const resolve of browser.releaseWaiters) resolve()
    if (browser.contents && !browser.contents.isDestroyed() && browser.contents.debugger.isAttached()) {
      try {
        browser.contents.debugger.detach()
      } catch {
        // already gone
      }
    }
    this.browsers.delete(id)
  }

  private isActive(browser: Browser): boolean {
    const control = browser.control
    return !!control && (control.busy || Date.now() - control.lastActionAt < ACTIVE_MS)
  }

  private controlState(browser: Browser): BrowserControlState | null {
    const control = browser.control
    if (!control) return null
    const session = this.terminals.list().find((t) => t.id === control.sessionId)
    return {
      sessionId: control.sessionId,
      sessionTitle: session?.title ?? 'Claude',
      busy: control.busy,
      active: this.isActive(browser),
      takenOver: control.takenOver,
      viewport: browser.viewport ? { ...browser.viewport } : null,
      emulation: browser.emulation ? { ...browser.emulation, permissions: { ...browser.emulation.permissions } } : null,
      routes: browser.routes.map(routeState),
    }
  }

  private emitControl(browser: Browser): void {
    this.emit('control', browser.id, this.controlState(browser))
  }

  /** Tells the window when the page may go back to sleep in its hidden tab. */
  private scheduleIdle(browser: Browser): void {
    if (browser.idleTimer) clearTimeout(browser.idleTimer)
    browser.idleTimer = setTimeout(() => {
      browser.idleTimer = null
      this.emitControl(browser)
    }, ACTIVE_MS + 100)
  }

  private addActivity(browser: Browser, entry: Pick<BrowserActivity, 'kind' | 'label' | 'status'>): BrowserActivity {
    const activity: BrowserActivity = {
      id: browser.nextActivity++,
      at: new Date().toISOString(),
      detail: null,
      durationMs: null,
      image: null,
      ...entry,
    }
    browser.log.push(activity)
    if (browser.log.length > LOG_LIMIT) browser.log.splice(0, browser.log.length - LOG_LIMIT)
    this.emit('activity', browser.id, { ...activity })
    return activity
  }

  private updateActivity(browser: Browser, activity: BrowserActivity, change: Partial<BrowserActivity>): void {
    Object.assign(activity, change)
    this.emit('activity', browser.id, { ...activity })
  }
}
