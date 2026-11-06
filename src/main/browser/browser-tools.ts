import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { NativeImage } from 'electron'
import { addressToUrl, BLANK_PAGE, isBrowsableUrl } from '@shared/browser'
import { describeDialog, ToolError, type ActionContext, type ActionStep, type BrowserControl } from './browser-control'
import { keyEvents } from './keys'
import type { McpContent, McpTool, McpToolResult } from './mcp-protocol'
import { delay, withTimeout, type ElementBox, type MouseButton } from './page-driver'

/**
 * The tools of the browser's MCP server, in the manner of Playwright's MCP server: Claude reads the
 * page as an outline with refs (`browser_snapshot`) and acts on elements by their ref. Every action is
 * shown in the page and logged (BrowserControl); the labels of the log are German like the app.
 */

type Args = Record<string, unknown>

interface Reply {
  text: string
  image?: NativeImage
}

interface ToolDefinition<P> {
  name: string
  title: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
  readOnly?: boolean
  kind: string
  whileDialog?: boolean
  parse(args: Args): P
  /** The log line before the action knows its target. */
  label(params: P): string
  run(ctx: ActionContext, params: P): Promise<Reply>
}

/** The sizes Claude can give the page (CSS pixels per side). */
const MIN_VIEWPORT = 200
const MAX_VIEWPORT = 4000

/** How long Claude's target is shown before it acts on it, at least. */
const SHOW_MS = 250
/** The click follows the pointer's arrival by this much, so the user sees it land first. */
const CLICK_AFTER_MOVE_MS = 60
const NAVIGATION_WAIT_MS = 30_000
const ACTION_SETTLE_MS = 5000
const MAX_WAIT_SECONDS = 30
const MAX_EVALUATE_CHARS = 20_000
const MAX_LIST_ENTRIES = 100
const MAX_UPLOAD_FILES = 20

export const BROWSER_INSTRUCTIONS = `Claude Manager shows a browser next to this session; these tools drive it while the user watches: every action is highlighted on the page and logged next to it. Use it to open and test web apps (e.g. a dev server on localhost), to read pages and to fill in forms.
- Start with browser_navigate or browser_snapshot. Actions answer with a snapshot of the page: an outline in which elements you can act on carry a ref like [ref=e12]. Pass the ref (and a short description as element) to act on it. Refs change with the page: use those of the latest snapshot.
- Prefer snapshots for reading; take a screenshot when the look matters.
- Dialogs the page opens while you act (alert, confirm, prompt) are answered at once: with OK, and a prompt with its default. The result of the action tells you about them. To answer the next one differently, call browser_handle_dialog before the action that opens it.
- browser_resize gives the page another size, to test layouts (phone, tablet, large screens); it stays until you reset it or the session ends.
- The user can take the browser over at any time. Your call then waits until they hand it back and tells you that the page may have changed.
- The browser has its own profile (cookies, logins) apart from the user's other browsers. Don't enter passwords or payment details unless the user asked you to.`

const ref = { type: 'string', description: 'The ref of the element from the latest snapshot, e.g. "e12".' }
const element = { type: 'string', description: 'A short description of the element, for the user watching (e.g. "Save button").' }

const TOOLS: ToolDefinition<never>[] = [
  tool({
    name: 'browser_navigate',
    title: 'Open a page',
    description: 'Opens an address in the browser (http or https; "localhost:5173" works too).',
    properties: { url: { type: 'string', description: 'The address to open.' } },
    required: ['url'],
    kind: 'navigate',
    parse: (args) => {
      const url = addressToUrl(requiredString(args, 'url', 8192))
      if (url === BLANK_PAGE || !isBrowsableUrl(url)) throw new ToolError('The browser opens http and https addresses only.')
      return { url }
    },
    label: ({ url }) => `Öffnet ${shortAddress(url)}`,
    run: async (ctx, { url }) => {
      ctx.highlight(`Öffnet ${shortAddress(url)}`)
      const failure = await loadPage(ctx, () => ctx.page.contents.loadURL(url))
      return { text: `${failure ?? `Opened ${url}.`}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_history',
    title: 'Back, forward or reload',
    description: 'Goes back or forward in the history of the browser, or reloads the page.',
    properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } },
    required: ['action'],
    kind: 'navigate',
    parse: (args) => ({ action: oneOf(args, 'action', ['back', 'forward', 'reload'] as const) }),
    label: ({ action }) => ({ back: 'Geht zurück', forward: 'Geht vor', reload: 'Lädt die Seite neu' })[action],
    run: async (ctx, { action }) => {
      const history = ctx.page.contents.navigationHistory
      if (action === 'back' && !history.canGoBack()) throw new ToolError('There is no page to go back to.')
      if (action === 'forward' && !history.canGoForward()) throw new ToolError('There is no page to go forward to.')
      ctx.highlight(({ back: 'Geht zurück', forward: 'Geht vor', reload: 'Lädt neu' } as const)[action])
      if (action === 'back') history.goBack()
      else if (action === 'forward') history.goForward()
      else ctx.page.contents.reload()
      await ctx.page.settle(NAVIGATION_WAIT_MS)
      return { text: await pageState(ctx) }
    },
  }),
  tool({
    name: 'browser_snapshot',
    title: 'Read the page',
    description: 'An outline of the page with refs for the elements you can act on. Better than a screenshot for reading and acting.',
    properties: {},
    readOnly: true,
    kind: 'snapshot',
    parse: () => ({}),
    label: () => 'Liest die Seite',
    run: async (ctx) => ({ text: await pageState(ctx) }),
  }),
  tool({
    name: 'browser_click',
    title: 'Click',
    description: 'Clicks an element of the page with the mouse.',
    properties: {
      ref,
      element,
      doubleClick: { type: 'boolean', description: 'Double-click instead.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default: left.' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] }, description: 'Keys held while clicking.' },
    },
    required: ['ref'],
    kind: 'click',
    parse: (args) => ({
      ref: refOf(args),
      element: optionalString(args, 'element', 200),
      doubleClick: optionalBoolean(args, 'doubleClick') ?? false,
      button: oneOf(args, 'button', ['left', 'right', 'middle'] as const, 'left') as MouseButton,
      modifiers: modifierBits(args),
    }),
    label: (p) => `${p.doubleClick ? 'Doppelklickt' : 'Klickt'} auf ${p.element ? quote(p.element) : p.ref}`,
    run: async (ctx, p) => {
      const verb = p.doubleClick ? 'Doppelklickt' : p.button === 'right' ? 'Rechtsklickt' : 'Klickt'
      const box = await target(ctx, p.ref, p.element, (name) => `${verb} auf ${name}`, 'click')
      const { x, y } = center(box)
      await ctx.interceptFileChooser(() =>
        untilDialog(ctx, async () => {
          await ctx.page.click(x, y, { button: p.button, clickCount: p.doubleClick ? 2 : 1, modifiers: p.modifiers })
          await ctx.page.settle(ACTION_SETTLE_MS)
        }),
      )
      const notes = [`Clicked ${describe(box, p.element)}.`]
      if (box.covered) notes.push(`Note: ${box.covered} lay over the element, the click may have hit it instead.`)
      if (ctx.fileChooser()) notes.push('A file chooser opened: pick files with browser_file_upload (without ref).')
      return { text: `${notes.join('\n')}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_type',
    title: 'Type text',
    description: 'Types text into a text field or editor, replacing what is in it (unless append).',
    properties: {
      ref,
      element,
      text: { type: 'string', description: 'The text to type.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      append: { type: 'boolean', description: 'Add to the existing text instead of replacing it.' },
    },
    required: ['ref', 'text'],
    kind: 'type',
    parse: (args) => ({
      ref: refOf(args),
      element: optionalString(args, 'element', 200),
      text: requiredString(args, 'text', 100_000, true),
      submit: optionalBoolean(args, 'submit') ?? false,
      append: optionalBoolean(args, 'append') ?? false,
    }),
    label: (p) => `Tippt in ${p.element ? quote(p.element) : p.ref}`,
    run: async (ctx, p) => {
      const box = await target(ctx, p.ref, p.element, (name) => `Tippt in ${name}`, 'click')
      // What goes into a password field stays out of the log.
      ctx.label(`Tippt ${box.secret ? '••••' : quote(cut(p.text, 60))} in ${targetName(box, p.element)}`)
      const { x, y } = center(box)
      const notes: string[] = []
      await untilDialog(ctx, async () => {
        await ctx.page.click(x, y)
        const kind = await ctx.page.call<string>('prepareTyping', p.ref, !p.append)
        if (kind === 'other') notes.push(`${describe(box, p.element)} is no text field; the text went to what has the focus after clicking it.`)
        if (p.text) await ctx.page.insertText(p.text)
        else if (!p.append) await ctx.page.press('Delete')
        if (p.submit) await ctx.page.press('Enter')
        await ctx.page.settle(p.submit ? ACTION_SETTLE_MS : 300)
      })
      ctx.note(box.secret ? 'Passwort eingegeben' : `${p.text.length} Zeichen`)
      return { text: `Typed into ${describe(box, p.element)}${p.submit ? ' and pressed Enter' : ''}.${notes.length ? `\n${notes.join('\n')}` : ''}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_press_key',
    title: 'Press a key',
    description: 'Presses a key or a combination where the focus is, e.g. "Enter", "Escape", "ArrowDown", "Control+A", "Shift+Tab".',
    properties: { key: { type: 'string', description: 'The key, with modifiers joined by "+".' } },
    required: ['key'],
    kind: 'key',
    parse: (args) => {
      const key = requiredString(args, 'key', 60)
      try {
        keyEvents(key)
      } catch (error) {
        throw new ToolError((error as Error).message)
      }
      return { key }
    },
    label: ({ key }) => `Drückt ${key}`,
    run: async (ctx, { key }) => {
      ctx.highlight(`Drückt ${key}`)
      await untilDialog(ctx, async () => {
        await ctx.page.press(key)
        await ctx.page.settle(ACTION_SETTLE_MS)
      })
      return { text: `Pressed ${key}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_hover',
    title: 'Hover',
    description: 'Moves the mouse over an element, e.g. to open a menu or a tooltip.',
    properties: { ref, element },
    required: ['ref'],
    kind: 'hover',
    parse: (args) => ({ ref: refOf(args), element: optionalString(args, 'element', 200) }),
    label: (p) => `Zeigt auf ${p.element ? quote(p.element) : p.ref}`,
    run: async (ctx, p) => {
      const box = await target(ctx, p.ref, p.element, (name) => `Zeigt auf ${name}`, 'move')
      const { x, y } = center(box)
      await ctx.page.hover(x, y)
      await delay(300)
      return { text: `Hovering over ${describe(box, p.element)}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_select_option',
    title: 'Select an option',
    description: 'Selects one or more options of a <select> by their value or text.',
    properties: { ref, element, values: { type: 'array', items: { type: 'string' }, description: 'Values or texts of the options.' } },
    required: ['ref', 'values'],
    kind: 'select',
    parse: (args) => ({ ref: refOf(args), element: optionalString(args, 'element', 200), values: stringList(args, 'values', 50) }),
    label: (p) => `Wählt ${p.values.map(quote).join(', ')}`,
    run: async (ctx, p) => {
      const box = await target(ctx, p.ref, p.element, (name) => `Wählt ${p.values.map((v) => quote(cut(v, 40))).join(', ')} in ${name}`, 'move')
      const chosen = await ctx.page.call<string[]>('selectOptions', p.ref, p.values)
      await ctx.page.settle(ACTION_SETTLE_MS)
      return { text: `Selected ${chosen.map((c) => JSON.stringify(c)).join(', ')} in ${describe(box, p.element)}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_scroll',
    title: 'Scroll',
    description: 'Scrolls the page, or scrolls an element into view (ref).',
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Default: down.' },
      pixels: { type: 'number', description: 'How far; default: most of the window.' },
      ref: { ...ref, description: 'Scroll this element into view instead.' },
    },
    kind: 'scroll',
    parse: (args) => ({
      direction: oneOf(args, 'direction', ['up', 'down', 'left', 'right'] as const, 'down'),
      pixels: optionalNumber(args, 'pixels', 1, 100_000),
      ref: args.ref === undefined ? undefined : refOf(args),
    }),
    label: (p) => (p.ref ? `Scrollt zu ${p.ref}` : scrollLabel(p.direction)),
    run: async (ctx, p) => {
      if (p.ref) {
        const box = await target(ctx, p.ref, undefined, (name) => `Scrollt zu ${name}`, null)
        return { text: `Scrolled ${describe(box)} into view.\n\n${await pageState(ctx)}` }
      }
      const metrics = await ctx.page.cdp<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics')
      const { clientWidth: width, clientHeight: height } = metrics.cssLayoutViewport
      const vertical = p.direction === 'up' || p.direction === 'down'
      const distance = p.pixels ?? Math.round((vertical ? height : width) * 0.8)
      const sign = p.direction === 'up' || p.direction === 'left' ? -1 : 1
      await delay(ctx.highlight(scrollLabel(p.direction), null, { x: width / 2, y: height / 2 }))
      await ctx.page.wheel(width / 2, height / 2, vertical ? 0 : sign * distance, vertical ? sign * distance : 0)
      await delay(400)
      const at = await ctx.page.call<{ x: number; y: number; height: number; viewport: number }>('scrollInfo')
      return { text: `Scrolled ${p.direction}; now ${at.y} of ${Math.max(0, at.height - at.viewport)} px down.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_wait_for',
    title: 'Wait',
    description: `Waits until a text appears or disappears on the page, or for a number of seconds (at most ${MAX_WAIT_SECONDS}).`,
    properties: {
      text: { type: 'string', description: 'Wait until this text is on the page.' },
      textGone: { type: 'string', description: 'Wait until this text is gone.' },
      seconds: { type: 'number', description: 'How long to wait, or the most to wait for the text (default 10).' },
    },
    readOnly: true,
    kind: 'wait',
    parse: (args) => {
      const p = {
        text: optionalString(args, 'text', 500),
        textGone: optionalString(args, 'textGone', 500),
        seconds: optionalNumber(args, 'seconds', 0, MAX_WAIT_SECONDS),
      }
      if (!p.text && !p.textGone && p.seconds === undefined) throw new ToolError('Give text, textGone or seconds.')
      return p
    },
    label: (p) => (p.text ? `Wartet auf ${quote(cut(p.text, 60))}` : p.textGone ? `Wartet, bis ${quote(cut(p.textGone, 60))} weg ist` : `Wartet ${p.seconds} s`),
    run: async (ctx, p) => {
      if (!p.text && !p.textGone) {
        await delay((p.seconds ?? 0) * 1000)
        return { text: `Waited ${p.seconds} s.\n\n${await pageState(ctx)}` }
      }
      const until = Date.now() + (p.seconds ?? 10) * 1000
      for (;;) {
        const shown = p.text ? await ctx.page.call<boolean>('hasText', p.text) : true
        const gone = p.textGone ? !(await ctx.page.call<boolean>('hasText', p.textGone)) : true
        if (shown && gone) break
        if (Date.now() > until) {
          throw new ToolError(`Timed out: ${p.text && !shown ? `"${p.text}" did not appear` : `"${p.textGone}" did not go away`}.`)
        }
        await delay(250)
      }
      return { text: `${p.text ? `"${p.text}" is on the page` : `"${p.textGone}" is gone`}.\n\n${await pageState(ctx)}` }
    },
  }),
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
      const what = size
        ? `The page is ${now.width}×${now.height} now${size.mobile ? ', as a mobile device' : ''}${phoneChanged ? ' (loaded again)' : ''}.`
        : `The page has the size of the window again: ${now.width}×${now.height}${phoneChanged ? ' (loaded again, no mobile device any more)' : ''}.`
      return { text: `${what}\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_take_screenshot',
    title: 'Take a screenshot',
    description: 'A picture of the visible part of the page, of the whole page (fullPage), or of one element (ref).',
    properties: {
      fullPage: { type: 'boolean', description: 'The whole page instead of the visible part.' },
      ref: { ...ref, description: 'Only this element.' },
      element,
    },
    readOnly: true,
    kind: 'screenshot',
    whileDialog: true,
    parse: (args) => ({
      fullPage: optionalBoolean(args, 'fullPage') ?? false,
      ref: args.ref === undefined ? undefined : refOf(args),
      element: optionalString(args, 'element', 200),
    }),
    label: (p) => (p.ref ? `Fotografiert ${p.element ? quote(p.element) : p.ref}` : p.fullPage ? 'Fotografiert die ganze Seite' : 'Macht einen Screenshot'),
    run: async (ctx, p) => {
      let image: NativeImage
      let note = ''
      if (p.ref) {
        const box = await ctx.page.locate(p.ref)
        ctx.label(`Fotografiert ${quote(p.element || box.name || box.role)}`)
        image = await ctx.page.capture(box)
      } else if (p.fullPage) {
        const shot = await ctx.page.captureFullPage()
        image = shot.image
        if (shot.cut) note = ' The page is longer: the picture ends after 8000 px.'
      } else {
        image = await ctx.page.capture()
      }
      ctx.image(image)
      const { width, height } = image.getSize()
      return { text: `Screenshot (${width}×${height}).${note}`, image }
    },
  }),
  tool({
    name: 'browser_console_messages',
    title: 'Console messages',
    description: 'The messages of the page in its console, newest last.',
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
      const lines = entries.slice(-MAX_LIST_ENTRIES).map((e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source})` : ''}`)
      return { text: lines.join('\n') }
    },
  }),
  tool({
    name: 'browser_network_requests',
    title: 'Network requests',
    description: 'The requests of the page since the browser was last driven (method, address, status).',
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
      const lines = entries
        .slice(-MAX_LIST_ENTRIES)
        .map((e) => `${e.method} ${e.url} → ${e.failure ?? e.status ?? 'pending'} [${e.type}]`)
      return { text: lines.join('\n') }
    },
  }),
  tool({
    name: 'browser_evaluate',
    title: 'Run JavaScript',
    description: 'Runs JavaScript in the page and returns the result as JSON: a function like "() => document.title" or an expression. Promises are awaited.',
    properties: { function: { type: 'string', description: 'The function or expression.' } },
    required: ['function'],
    kind: 'evaluate',
    parse: (args) => ({ code: requiredString(args, 'function', 100_000) }),
    label: () => 'Führt ein Skript aus',
    run: async (ctx, { code }) => {
      ctx.highlight('Führt ein Skript aus')
      const expression = `(async () => { const __value = (${code}\n); return typeof __value === 'function' ? await __value() : await __value })()`
      type Evaluation = {
        result: { type: string; value?: unknown; description?: string; unserializableValue?: string }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }
      let evaluation: Evaluation | undefined
      await untilDialog(ctx, async () => {
        evaluation = await withTimeout(
          ctx.page.cdp<Evaluation>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
          30_000,
          'The script did not finish within 30 s.',
        )
      })
      if (!evaluation) return { text: `The script opened a dialog.\n\n${await pageState(ctx)}` }
      if (evaluation.exceptionDetails) {
        throw new ToolError(`The script failed: ${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`)
      }
      const { result } = evaluation
      const value =
        result.type === 'undefined'
          ? 'undefined'
          : result.unserializableValue ?? (result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.description ?? String(result.value))
      return { text: cut(value, MAX_EVALUATE_CHARS) }
    },
  }),
  tool({
    name: 'browser_file_upload',
    title: 'Upload files',
    description: 'Puts local files into a file input (ref), or into the file chooser a click has just opened (no ref).',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files.' },
      ref: { ...ref, description: 'The file input; leave out after a click opened a file chooser.' },
      element,
    },
    required: ['paths'],
    kind: 'upload',
    parse: (args) => {
      const paths = stringList(args, 'paths', MAX_UPLOAD_FILES)
      for (const path of paths) {
        if (!isAbsolute(path)) throw new ToolError(`Not an absolute path: ${path}`)
        let file = false
        try {
          file = statSync(path).isFile()
        } catch {
          // checked below
        }
        if (!file) throw new ToolError(`No such file: ${path}`)
      }
      return { paths, ref: args.ref === undefined ? undefined : refOf(args), element: optionalString(args, 'element', 200) }
    },
    label: (p) => `Lädt ${p.paths.length === 1 ? '1 Datei' : `${p.paths.length} Dateien`} hoch`,
    run: async (ctx, p) => {
      const names = p.paths.map((path) => path.split(/[\\/]/).pop()).join(', ')
      if (p.ref) {
        const box = await target(ctx, p.ref, p.element, () => `Lädt ${cut(names, 80)} hoch`, 'move')
        const mark = randomUUID()
        const topDocument = await ctx.page.call<boolean>('markFileInput', p.ref, mark)
        try {
          if (!topDocument) throw new ToolError('This file input is inside a frame; click it and use browser_file_upload without ref.')
          const { root } = await ctx.page.cdp<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
          const { nodeId } = await ctx.page.cdp<{ nodeId: number }>('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: `[data-claude-manager-upload="${mark}"]`,
          })
          if (!nodeId) throw new ToolError('The file input is gone. Take a new snapshot.')
          await ctx.page.cdp('DOM.setFileInputFiles', { files: p.paths, nodeId })
        } finally {
          await ctx.page.call('unmarkFileInput', mark).catch(() => undefined)
        }
        await ctx.page.settle(ACTION_SETTLE_MS)
        return { text: `Put ${names} into ${describe(box, p.element)}.\n\n${await pageState(ctx)}` }
      }
      const chooser = ctx.fileChooser()
      if (!chooser) throw new ToolError('No file chooser is open. Click the upload button first, or give the ref of the file input.')
      if (!chooser.multiple && p.paths.length > 1) throw new ToolError('This file chooser takes one file only.')
      ctx.highlight(`Lädt ${cut(names, 80)} hoch`)
      await ctx.page.cdp('DOM.setFileInputFiles', { files: p.paths, backendNodeId: chooser.backendNodeId })
      ctx.clearFileChooser()
      await ctx.page.settle(ACTION_SETTLE_MS)
      return { text: `Picked ${names}.\n\n${await pageState(ctx)}` }
    },
  }),
  tool({
    name: 'browser_handle_dialog',
    title: 'Answer a dialog',
    description:
      'Decides how the next dialog of the page (confirm, prompt) is answered, before the action that opens it; or answers a dialog that blocks the page now.',
    properties: {
      accept: { type: 'boolean', description: 'OK (true) or Cancel (false).' },
      promptText: { type: 'string', description: 'The answer to a prompt.' },
    },
    required: ['accept'],
    kind: 'dialog',
    whileDialog: true,
    parse: (args) => {
      const accept = optionalBoolean(args, 'accept')
      if (accept === undefined) throw new ToolError('accept is required.')
      return { accept, promptText: optionalString(args, 'promptText', 10_000) }
    },
    label: ({ accept }) => (accept ? 'Bestätigt den Dialog' : 'Bricht den Dialog ab'),
    run: async (ctx, p) => {
      const dialog = ctx.dialog()
      if (!dialog) {
        ctx.setDialogAnswer({ accept: p.accept, promptText: p.promptText ?? null })
        ctx.label(p.accept ? 'Bestätigt den nächsten Dialog' : 'Bricht den nächsten Dialog ab')
        const answer = p.accept ? (p.promptText !== undefined ? `OK with ${JSON.stringify(p.promptText)}` : 'OK') : 'Cancel'
        return { text: `The next dialog the page opens will be answered with ${answer}.` }
      }
      ctx.note(cut(dialog.message, 120))
      await ctx.page.cdp('Page.handleJavaScriptDialog', { accept: p.accept, ...(p.promptText !== undefined ? { promptText: p.promptText } : {}) })
      await ctx.page.settle(ACTION_SETTLE_MS)
      return { text: `${p.accept ? 'Accepted' : 'Dismissed'} the ${dialog.type} dialog.\n\n${await pageState(ctx)}` }
    },
  }),
]

/** The tools for the MCP server, and their calls for one session. */
export class BrowserTools {
  constructor(private readonly control: BrowserControl) {}

  list(): McpTool[] {
    return TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
      annotations: { title: t.title, readOnlyHint: t.readOnly === true, destructiveHint: false, openWorldHint: true },
    }))
  }

  async call(sessionId: string, name: string, args: Args): Promise<McpToolResult> {
    const definition = TOOLS.find((t) => t.name === name) as ToolDefinition<unknown> | undefined
    if (!definition) throw new ToolError(`Unknown tool: ${name}`)
    const params = definition.parse(args)
    const step: ActionStep = { kind: definition.kind, label: definition.label(params), whileDialog: definition.whileDialog }
    const reply = await this.control.perform(sessionId, step, async (ctx) => {
      const since = new Date().toISOString()
      const reply = await definition.run(ctx, params)
      const dialogs = ctx.caughtDialogs(since)
      if (dialogs.length > 0) {
        const lines = dialogs.map((d) => `- ${d.type} ${JSON.stringify(cut(d.message, 300))}, answered: ${d.answer}`)
        reply.text = `The page opened dialogs, answered at once:\n${lines.join('\n')}\n\n${reply.text}`
      }
      // Errors of the page during the action belong to its result.
      const errors = ctx.consoleEntries().filter((e) => e.level === 'error' && e.at >= since)
      if (errors.length > 0 && definition.kind !== 'console') {
        const lines = errors.slice(-5).map((e) => `- ${cut(e.text.split('\n')[0], 300)}`)
        reply.text = `New console errors:\n${lines.join('\n')}\n\n${reply.text}`
      }
      return reply
    })
    const content: McpContent[] = [{ type: 'text', text: reply.text }]
    if (reply.image) content.push({ type: 'image', data: reply.image.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' })
    return { content }
  }
}

function tool<P>(definition: ToolDefinition<P>): ToolDefinition<never> {
  return definition as unknown as ToolDefinition<never>
}

function sizeLabel(size: { width: number; height: number; mobile: boolean }): string {
  return `${size.width} × ${size.height}${size.mobile ? ' (mobil)' : ''}`
}

/** The page as Claude reads it, or the dialog that blocks it. */
async function pageState(ctx: ActionContext): Promise<string> {
  const dialog = ctx.dialog()
  if (dialog) return `${describeDialog(dialog)} Answer it with browser_handle_dialog.`
  return ctx.page.snapshot()
}

/** Waits for `work`, or until the page opens a dialog, which would hold the input back until it is answered. */
async function untilDialog(ctx: ActionContext, work: () => Promise<void>): Promise<void> {
  await Promise.race([work(), ctx.untilDialog()])
}

/** Loads a page; a failure is returned for the result, unless a newer navigation took over. */
async function loadPage(ctx: ActionContext, load: () => Promise<void>): Promise<string | null> {
  try {
    await untilDialog(ctx, () => withTimeout(load(), NAVIGATION_WAIT_MS, 'timeout'))
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'timeout') return `The page is still loading after ${NAVIGATION_WAIT_MS / 1000} s.`
    // ERR_ABORTED: a redirect of the page or another navigation took over.
    if (message.includes('ERR_ABORTED') || message.includes('(-3)')) return null
    throw new ToolError(`The page could not be opened: ${message}`)
  }
}

/**
 * Finds the element, names the action after it and shows it to the user for a moment. Claude's
 * pointer goes to its middle (`pointer`: and clicks there, as the action does), null: it stays.
 */
async function target(
  ctx: ActionContext,
  ref: string,
  element: string | undefined,
  label: (name: string) => string,
  pointer: 'click' | 'move' | null,
): Promise<ElementBox> {
  const box = await ctx.page.locate(ref)
  const text = label(targetName(box, element))
  ctx.label(text)
  const moveMs = ctx.highlight(text, box, pointer ? { ...center(box), click: pointer === 'click' } : null)
  await delay(Math.max(SHOW_MS, moveMs + CLICK_AFTER_MOVE_MS))
  return box
}

/** The element as the log names it. */
function targetName(box: ElementBox, element?: string): string {
  return quote(cut(element?.trim() || box.name || box.role, 60))
}

function center(box: ElementBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function describe(box: ElementBox, element?: string): string {
  const name = element?.trim() || box.name
  return name ? `${box.role} "${name}"` : box.role
}

function scrollLabel(direction: 'up' | 'down' | 'left' | 'right'): string {
  return `Scrollt nach ${({ up: 'oben', down: 'unten', left: 'links', right: 'rechts' } as const)[direction]}`
}

function shortAddress(url: string): string {
  try {
    const { host, pathname, search } = new URL(url)
    return cut(host + (pathname === '/' ? '' : pathname) + search, 80)
  } catch {
    return cut(url, 80)
  }
}

function quote(text: string): string {
  return `„${text}“`
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// --- arguments ---------------------------------------------------------------

function requiredString(args: Args, key: string, max: number, allowEmpty = false): string {
  const value = args[key]
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new ToolError(`${key} must be a non-empty string.`)
  if (value.length > max) throw new ToolError(`${key} is too long.`)
  return value
}

function optionalString(args: Args, key: string, max: number): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ToolError(`${key} must be a string.`)
  if (value.length > max) throw new ToolError(`${key} is too long.`)
  return value
}

function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ToolError(`${key} must be true or false.`)
  return value
}

function optionalNumber(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ToolError(`${key} must be a number from ${min} to ${max}.`)
  }
  return value
}

function oneOf<T extends string>(args: Args, key: string, values: readonly T[], fallback?: T): T {
  const value = args[key]
  if ((value === undefined || value === null) && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ToolError(`${key} must be one of ${values.join(', ')}.`)
  return value as T
}

function stringList(args: Args, key: string, maxItems: number): string[] {
  const value = args[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new ToolError(`${key} must be a non-empty list of strings.`)
  }
  if (value.length > maxItems) throw new ToolError(`${key} takes at most ${maxItems} entries.`)
  return value as string[]
}

function refOf(args: Args): string {
  const value = args.ref
  if (typeof value !== 'string' || !/^e\d{1,9}$/.test(value.trim())) {
    throw new ToolError('ref must be a ref from the latest browser_snapshot, like "e12".')
  }
  return value.trim()
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

function modifierBits(args: Args): number {
  const value = args.modifiers
  if (value === undefined || value === null) return 0
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !(item in MODIFIER_BITS))) {
    throw new ToolError('modifiers must be a list of Alt, Control, Meta and Shift.')
  }
  return (value as string[]).reduce((bits, name) => bits | MODIFIER_BITS[name], 0)
}
