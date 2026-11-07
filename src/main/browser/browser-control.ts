import { webContents, type NativeImage, type WebContents } from 'electron'
import { BLANK_PAGE } from '@shared/browser'
import { hasPane, paneIds } from '@shared/panes'
import type {
  BrowserActivity,
  BrowserControlState,
  BrowserDownload,
  BrowserEmulation,
  BrowserHighlight,
  BrowserLoginRequest,
  BrowserNetworkPreset,
  BrowserViewport,
} from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'
import { browserDownloads } from '../window/browser-downloads'
import { browserLogins } from '../window/browser-logins'
import { mobileUserAgent } from '../window/browser-policy'
import type { TerminalService } from '../services/terminal-service'
import { PageFrames } from './frames'
import { delay, isClaudesMouse, PageDriver, withTimeout } from './page-driver'
import { pointerMoveMs, type PointerSpot } from './pointer'
import { snapshotChanges } from './snapshot-diff'

/** Claude's last action keeps the page drawn this long, also while its tab is hidden. */
const ACTIVE_MS = 60_000
/** How long Claude's next action waits for the user to hand a browser back. */
const TAKE_OVER_WAIT_MS = 10 * 60_000
/** How long a new browser may take until its page is there. */
const ATTACH_WAIT_MS = 20_000
const LOG_LIMIT = 300
const CONSOLE_LIMIT = 300
const NETWORK_LIMIT = 300
const PAGE_EVENT_LIMIT = 50

export interface ConsoleEntry {
  at: string
  level: string
  text: string
  source: string
}

export interface NetworkEntry {
  /** Its number for Claude (browser_network_request). */
  id: number
  /** The DevTools protocol's id, and the session of its frame (undefined: the page's), for its body. */
  requestId: string
  session: string | undefined
  method: string
  url: string
  type: string
  status: number | null
  statusText: string
  failure: string | null
  mimeType: string | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string> | null
  /** The body the page sent; null with `hasPostData`: too large for the event, ask the protocol. */
  postData: string | null
  hasPostData: boolean
  /** When it started (ms since the epoch) and how long it took until its end. */
  startedAt: number
  durationMs: number | null
  /** Bytes that came over the network (compressed). */
  encodedBytes: number | null
  fromCache: boolean
  /** Monotonic protocol time (s) of its start, for its duration. */
  timestamp: number
}

export interface PageDialog {
  type: string
  message: string
  defaultPrompt: string
}

/** A dialog the page opened while Claude acted, answered right away (see `dialogShim`). */
export interface CaughtDialog extends PageDialog {
  at: string
  /** How it was answered: OK, Cancel or the text given to a prompt. */
  answer: string
}

/** How Claude wants the next dialog answered (browser_handle_dialog before the action). */
export interface DialogAnswer {
  accept: boolean
  promptText: string | null
}

export interface FileChooser {
  backendNodeId: number
  multiple: boolean
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Something the page did by itself that Claude should hear of: a popup window, a download. */
export interface PageEvent {
  at: string
  text: string
}

/** A browser tab as browser_tabs lists it. */
export interface BrowserTab {
  index: number
  id: string
  title: string
  url: string
  /** The session's actions go to it. */
  current: boolean
  /** The session opened it (it may close it). */
  openedBySession: boolean
  /** Another Claude session drives it right now. */
  otherSession: string | null
}

/** A tool's error for Claude: it ends up in the result, not as a failure of the protocol. */
export class ToolError extends Error {}

/** What a tool can do while its action runs (see `BrowserControl.perform`). */
export interface ActionContext {
  readonly browserId: string
  readonly page: PageDriver
  /** The log line's text, once the target is known (e.g. the name of the clicked button). */
  label(text: string): void
  /** What came out, for the log line. */
  note(text: string): void
  /** A small picture of the page for the log line. */
  image(image: NativeImage): void
  /**
   * Shows the user where Claude acts: the element and the spot Claude's mouse pointer goes to (and
   * clicks, with `pointer.click`), in CSS pixels of the page's viewport. Returns how long the
   * pointer takes to get there (ms): the action should wait for it.
   */
  highlight(label: string, box?: Box | null, pointer?: { x: number; y: number; click?: boolean } | null): number
  /**
   * The page as Claude reads it. `changes`: only what changed since the session's last snapshot of
   * this document (see snapshot-diff.ts), when that is shorter; otherwise the whole outline.
   */
  snapshot(changes: boolean): Promise<string>
  consoleEntries(): ConsoleEntry[]
  networkEntries(): NetworkEntry[]
  /** What the page pretends right now (browser_emulate). */
  emulation(): BrowserEmulation | null
  /** Has the page pretend this from now on (null: nothing); it stays until the session ends or the user resets it. */
  setEmulation(emulation: BrowserEmulation | null): Promise<void>
  /** A dialog that blocks the page until it is answered (one the page opened while Claude didn't act). */
  dialog(): PageDialog | null
  /** Resolves when the page opens such a dialog. */
  untilDialog(): Promise<PageDialog>
  /** The dialogs answered right away since then (ISO time). */
  caughtDialogs(since: string): CaughtDialog[]
  /** Popups and downloads of the page that no result named yet (also those of a moment after an action). */
  pageEvents(): PageEvent[]
  /** The page waits for a user name and password, which the user enters in its pane. */
  login(): BrowserLoginRequest | null
  /** Resolves when the page asks for a login. */
  untilLogin(): Promise<BrowserLoginRequest>
  /** How the next dialog is answered; null: OK, and a prompt's default. */
  setDialogAnswer(answer: DialogAnswer | null): void
  fileChooser(): FileChooser | null
  clearFileChooser(): void
  /** The page's file chooser comes to Claude instead of the user while `work` runs. */
  interceptFileChooser<T>(work: () => Promise<T>): Promise<T>
  /**
   * Gives the page a size of its own (CSS pixels; null: its part of the tab again), as a phone with
   * `mobile`. Resolves once the page has it; true when phone mode changed (the page should load again).
   */
  setViewport(size: ViewportSize | null): Promise<boolean>
}

export interface ViewportSize {
  width: number
  height: number
  mobile: boolean
}

interface Control {
  sessionId: string
  busy: boolean
  takenOver: boolean
  lastActionAt: number
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
  /** The page's frames of other sites and their DevTools sessions. */
  frames: PageFrames
  /** The last snapshot Claude got of the page, to send only what changed after the next action. */
  lastSnapshot: { sessionId: string; doc: string; text: string } | null
  /** What the page pretends for Claude; it ends with the session. */
  emulation: BrowserEmulation | null
  dialog: PageDialog | null
  dialogSignal: { promise: Promise<PageDialog>; resolve: (dialog: PageDialog) => void }
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

function signal(): Browser['dialogSignal'] {
  let resolve!: (dialog: PageDialog) => void
  const promise = new Promise<PageDialog>((r) => (resolve = r))
  return { promise, resolve }
}

/** The page calls it with the dialogs it caught. */
const DIALOG_BINDING = '__claudeManagerDialog'
/** How long after an action its dialogs are still caught (a page may open one a moment later). */
const DIALOG_GRACE_MS = 1500

/**
 * Catches the page's dialogs while Claude acts and answers them at once, in the page's own world.
 * Electron shows a dialog of a page as a message box of its own, which stays open when the
 * DevTools protocol answers the dialog: so the page never gets to open one while Claude acts.
 */
function dialogShim(answer: DialogAnswer | null): string {
  return `(() => {
  const answer = ${JSON.stringify(answer)}
  const own = window.__claudeManagerDialogs
  if (own) {
    own.on = true
    own.answer = answer
    return
  }
  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
  const state = { on: true, answer }
  Object.defineProperty(window, '__claudeManagerDialogs', { value: state, configurable: true })
  const text = (value) => (value === undefined || value === null ? '' : String(value))
  const report = (type, message, defaultPrompt, result) => {
    try {
      window.${DIALOG_BINDING}(JSON.stringify({ type, message: text(message), defaultPrompt: text(defaultPrompt), answer: result }))
    } catch {}
  }
  const take = () => {
    const next = state.answer || { accept: true, promptText: null }
    state.answer = null
    return next
  }
  window.alert = function (message) {
    if (!state.on) return native.alert.apply(this, arguments)
    report('alert', message, null, 'OK')
  }
  window.confirm = function (message) {
    if (!state.on) return native.confirm.apply(this, arguments)
    const next = take()
    report('confirm', message, null, next.accept ? 'OK' : 'Cancel')
    return next.accept
  }
  window.prompt = function (message, defaultPrompt) {
    if (!state.on) return native.prompt.apply(this, arguments)
    const next = take()
    const value = next.accept ? (next.promptText ?? text(defaultPrompt)) : null
    report('prompt', message, defaultPrompt, value === null ? 'Cancel' : JSON.stringify(value))
    return value
  }
})()`
}

const DIALOG_SHIM_OFF = 'window.__claudeManagerDialogs && (window.__claudeManagerDialogs.on = false)'

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

/** One of Claude's actions, as `perform` runs it. */
export interface ActionStep {
  kind: string
  /** The log line, until the action names its target. */
  label: string
  /** The action also works while the page shows a dialog (which blocks the page's scripts). */
  whileDialog?: boolean
}

export class BrowserControl extends TypedEmitter<Events> {
  private readonly browsers = new Map<string, Browser>()
  /** The browser each session used last, by the session's terminal. */
  private readonly sessionBrowsers = new Map<string, string>()
  /** The session that opened a browser (it may close it again), by the browser. */
  private readonly openedBy = new Map<string, string>()
  private readonly listening = new WeakSet<WebContents>()

  constructor(private readonly terminals: TerminalService) {
    super()
    browserDownloads.on('started', (download) => this.onDownload(download))
    browserDownloads.on('finished', (download) => this.onDownload(download))
    terminals.on('changed', (list) => {
      const open = new Set(list.map((t) => t.id))
      for (const id of [...this.browsers.keys()]) if (!open.has(id)) this.forget(id)
      for (const [browser, session] of [...this.openedBy]) if (!open.has(browser) || !open.has(session)) this.openedBy.delete(browser)
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
    if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return
    await applyEmulation(new PageDriver(contents), null, browser.viewport?.mobile ?? false, browser.frames.frameSessions()).catch(() => undefined)
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
      const ctx = this.context(browser, page, activity, cleanups, {
        note: (text) => (detail = text),
        image: (data) => (image = data),
      })
      const result = await work(ctx)
      this.updateActivity(browser, activity, { status: 'done', detail, image, durationMs: Date.now() - started })
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
   * The browser of a session: the one it used last, else one in its tab, else a new one next to it.
   * Synchronous, so two calls of a session at once don't open two browsers.
   */
  private browserFor(sessionId: string): string {
    const list = this.terminals.list()
    const isBrowser = (id: string) => list.find((t) => t.id === id)?.mode === 'browser'
    const known = this.sessionBrowsers.get(sessionId)
    if (known && isBrowser(known)) return known
    if (!list.some((t) => t.id === sessionId)) throw new ToolError('This session is no longer open in Claude Manager.')
    const split = this.terminals.layouts().find((s) => hasPane(s, sessionId))
    const beside = split ? paneIds(split).find(isBrowser) : undefined
    const id = beside ?? this.terminals.openBrowser({ split: { terminalId: sessionId, direction: 'row' } }).id
    if (!beside) this.openedBy.set(id, sessionId)
    this.sessionBrowsers.set(sessionId, id)
    return id
  }

  /** The browser tabs of the app in their order, as browser_tabs shows them to a session. */
  tabs(sessionId: string): BrowserTab[] {
    const list = this.terminals.list()
    const current = this.sessionBrowsers.get(sessionId)
    return list
      .filter((t) => t.mode === 'browser')
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
   * browser, or next to the session when it has none yet.
   */
  openTab(sessionId: string): BrowserTab {
    const list = this.terminals.list()
    if (!list.some((t) => t.id === sessionId)) throw new ToolError('This session is no longer open in Claude Manager.')
    const current = this.sessionBrowsers.get(sessionId)
    const split =
      current && list.some((t) => t.id === current)
        ? { terminalId: current, direction: 'column' as const }
        : { terminalId: sessionId, direction: 'row' as const }
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

  /** Closes a tab the session opened; the user's own tabs stay. */
  closeTab(sessionId: string, index: number): BrowserTab {
    const tab = this.tabAt(sessionId, index)
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
    browser.dialogScript = null
    browser.protocol = true
  }

  /** A frame in a process of its own got its session: requests, frames in it and Claude's emulation; then it may run. */
  private async setUpFrame(browser: Browser, contents: WebContents, session: string): Promise<void> {
    const page = new PageDriver(contents)
    try {
      await page.cdpIn(session, 'Network.enable').catch(() => undefined)
      await autoAttachFrames(page, session)
      if (browser.emulation) await applyFrameEmulation(page, session, browser.emulation, browser.viewport?.mobile ?? false)
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
    if (browser.contents !== contents) return
    switch (method) {
      case 'Target.detachedFromTarget':
        browser.frames.detached(params.sessionId as string)
        return
      case 'Network.requestWillBeSent': {
        const request = params.request as { method: string; url: string; headers?: Record<string, string>; postData?: string; hasPostData?: boolean }
        if (request.url.startsWith('data:')) return
        const key = requestKey(session, params.requestId as string)
        const redirect = params.redirectResponse as { status: number; statusText?: string; headers?: Record<string, string> } | undefined
        const earlier = browser.network.get(key)
        if (redirect && earlier) {
          // The same request goes on at another address: the earlier one ends with the redirect.
          earlier.status = redirect.status
          earlier.statusText = redirect.statusText ?? ''
          earlier.responseHeaders = redirect.headers ?? null
          earlier.durationMs = Math.round((Number(params.timestamp) - earlier.timestamp) * 1000)
          browser.network.delete(key)
          browser.network.set(`${key}#${earlier.id}`, earlier)
        }
        browser.network.set(key, {
          id: browser.nextRequest++,
          requestId: params.requestId as string,
          session,
          method: request.method,
          url: request.url,
          type: String(params.type ?? 'Other'),
          status: null,
          statusText: '',
          failure: null,
          mimeType: null,
          requestHeaders: request.headers ?? {},
          responseHeaders: null,
          postData: request.postData ?? null,
          hasPostData: request.hasPostData === true,
          startedAt: typeof params.wallTime === 'number' ? Math.round(params.wallTime * 1000) : Date.now(),
          durationMs: null,
          encodedBytes: null,
          fromCache: false,
          timestamp: Number(params.timestamp) || 0,
        })
        while (browser.network.size > NETWORK_LIMIT) browser.network.delete(browser.network.keys().next().value!)
        return
      }
      case 'Network.requestServedFromCache': {
        const entry = findRequest(browser.network, session, params.requestId as string)
        if (entry) entry.fromCache = true
        return
      }
      case 'Network.responseReceived': {
        const entry = findRequest(browser.network, session, params.requestId as string)
        if (!entry) return
        const response = params.response as {
          status: number
          statusText?: string
          mimeType?: string
          headers?: Record<string, string>
          fromDiskCache?: boolean
          fromServiceWorker?: boolean
        }
        entry.status = response.status
        entry.statusText = response.statusText ?? ''
        entry.mimeType = response.mimeType ?? null
        entry.responseHeaders = response.headers ?? null
        if (response.fromDiskCache) entry.fromCache = true
        if (response.status >= 400 && worthLogging(entry)) {
          this.pageWarning(browser, 'network', `HTTP ${response.status}: ${entry.method} ${shortUrl(entry.url)}`)
        }
        return
      }
      case 'Network.loadingFinished': {
        const entry = findRequest(browser.network, session, params.requestId as string)
        if (!entry) return
        entry.encodedBytes = typeof params.encodedDataLength === 'number' ? params.encodedDataLength : null
        entry.durationMs = Math.max(0, Math.round((Number(params.timestamp) - entry.timestamp) * 1000))
        return
      }
      case 'Network.loadingFailed': {
        const entry = findRequest(browser.network, session, params.requestId as string)
        if (!entry || params.canceled) return
        entry.failure = String(params.errorText ?? 'failed')
        entry.durationMs = Math.max(0, Math.round((Number(params.timestamp) - entry.timestamp) * 1000))
        if (worthLogging(entry)) this.pageWarning(browser, 'network', `${entry.failure}: ${entry.method} ${shortUrl(entry.url)}`)
        return
      }
      case 'Runtime.bindingCalled': {
        if (params.name !== DIALOG_BINDING || session !== undefined) return
        let caught: CaughtDialog
        try {
          const raw = JSON.parse(String(params.payload)) as Record<string, unknown>
          caught = {
            at: new Date().toISOString(),
            type: String(raw.type),
            message: String(raw.message ?? '').slice(0, 2000),
            defaultPrompt: String(raw.defaultPrompt ?? '').slice(0, 2000),
            answer: String(raw.answer ?? '').slice(0, 2000),
          }
        } catch {
          return
        }
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
        browser.dialogSignal = signal()
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
    }
  }

  private onConsole(browser: Browser, contents: WebContents, event: { level?: string; message?: string; sourceId?: string; lineNumber?: number }): void {
    if (browser.contents !== contents) return
    const entry: ConsoleEntry = {
      at: new Date().toISOString(),
      level: String(event.level ?? 'info'),
      text: String(event.message ?? '').slice(0, 2000),
      source: event.sourceId ? `${event.sourceId}:${event.lineNumber ?? 0}` : '',
    }
    browser.consoleEntries.push(entry)
    if (browser.consoleEntries.length > CONSOLE_LIMIT) browser.consoleEntries.shift()
    if (entry.level === 'error') this.pageWarning(browser, 'console', `Konsole: ${entry.text.split('\n')[0].slice(0, 200)}`)
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
    if (!browser.control) return
    if (browser.log.slice(-20).some((a) => a.kind === kind && a.label === label)) return
    this.addActivity(browser, { kind, label, status: 'warning' })
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
        frames: new PageFrames(),
        lastSnapshot: null,
        emulation: null,
        dialog: null,
        dialogSignal: signal(),
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
      emulation: browser.emulation ? { ...browser.emulation } : null,
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

/** A dialog that blocks the page, for Claude. */
export function describeDialog(dialog: PageDialog): string {
  const prompt = dialog.type === 'prompt' ? ` (default answer ${JSON.stringify(dialog.defaultPrompt)})` : ''
  const article = /^[aeiou]/i.test(dialog.type) ? 'an' : 'a'
  return `The page shows ${article} ${dialog.type} dialog: ${JSON.stringify(dialog.message)}${prompt}. It blocks the page until it is answered.`
}

/** Only failures of pages and of the requests scripts make are worth a line; not every missing image. */
function worthLogging(entry: NetworkEntry): boolean {
  return entry.type === 'Document' || entry.type === 'XHR' || entry.type === 'Fetch'
}

function shortUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 119)}…` : url
}

/** How long the window may take to give the page the size Claude chose. */
const VIEWPORT_WAIT_MS = 3000

/**
 * A phone to the page (touch, a phone's user agent, the viewport meta tag), or the browser again.
 * `locale`: the language Claude chose (browser_emulate), which goes with the user agent.
 */
async function setPhoneMode(page: PageDriver, on: boolean, locale: string | null): Promise<void> {
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

/** The session's key of a request: request ids are only unique within one DevTools session. */
function requestKey(session: string | undefined, requestId: string): string {
  return `${session ?? ''}|${requestId}`
}

/**
 * The entry of a request an event of `session` is about. The document of a frame in a process of
 * its own starts in the session around the frame and is loaded in the frame's own (its id is unique):
 * then its entry follows it there, where its body is.
 */
export function findRequest(network: Map<string, NetworkEntry>, session: string | undefined, requestId: string): NetworkEntry | undefined {
  const entry = network.get(requestKey(session, requestId))
  if (entry || session === undefined) return entry
  for (const other of network.values()) {
    if (other.requestId !== requestId || other.type !== 'Document') continue
    other.session = session
    return other
  }
  return undefined
}

/**
 * Chromium attaches a session to every frame in a process of its own, below the page or a frame
 * (`session`). The frame waits until setUpFrame let it run: its scripts start with the emulation.
 */
async function autoAttachFrames(page: PageDriver, session: string | undefined): Promise<void> {
  const params = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
  try {
    await page.cdpIn(session, 'Target.setAutoAttach', { ...params, filter: [{ type: 'iframe' }] })
  } catch {
    // An older protocol without filters: then everything it would attach, the handler only takes frames.
    await page.cdpIn(session, 'Target.setAutoAttach', params).catch(() => undefined)
  }
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
async function applyEmulation(page: PageDriver, emulation: BrowserEmulation | null, mobile: boolean, frameSessions: string[]): Promise<void> {
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
async function applyFrameEmulation(page: PageDriver, session: string, emulation: BrowserEmulation | null, mobile: boolean): Promise<void> {
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
async function untilViewport(page: PageDriver, wanted: ViewportSize | null, before: BrowserViewport | null): Promise<void> {
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
