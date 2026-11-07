import { randomUUID } from 'node:crypto'
import { nativeImage, type NativeImage, type WebContents } from 'electron'
import { FRAME_MARK_RE, frameError, indentLines, MAX_FRAME_DEPTH, parseRef, prefixRefs, type FrameRecord, type PageFrames } from './frames'
import { keyEvents } from './keys'
import { FRAME_MARK, MAX_SNAPSHOT_CHARS, pageCall, SCRIPT_WORLD } from './page-scripts'

/** Pages Claude moves the mouse in right now, by how many of its mouse events are under way. */
const claudesMice = new WeakMap<WebContents, number>()

/** Whether a mouse event in the page is Claude's (its DevTools input is under way), not the user's. */
export function isClaudesMouse(contents: WebContents): boolean {
  return (claudesMice.get(contents) ?? 0) > 0
}

/** Where an element is in the viewport of the page (CSS pixels), from `locate`. */
export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
  role: string
  name: string
  /** Another element lies over its middle, e.g. a cookie banner. */
  covered: string | null
  /** A password field: what Claude types into it stays out of the log. */
  secret: boolean
}

export type MouseButton = 'left' | 'right' | 'middle'

const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 }

/** Screenshots wider than this are scaled down: Claude sees no more, and they cost fewer tokens. */
const MAX_SHOT_WIDTH = 1280
/** A full-page screenshot ends here (CSS pixels); larger pictures Claude doesn't take. */
const MAX_FULL_PAGE_HEIGHT = 8000
/** Until the page has drawn itself after scrolling. */
const REPAINT_MS = 120
const SCRIPT_TIMEOUT_MS = 15_000
/** The script world of the page driver in frames of other sites (see frames.ts). */
const FRAME_WORLD = 'claude-manager'
/** A frame's snapshot gets no more than this, so one frame can't fill the whole snapshot. */
const MAX_FRAME_SNAPSHOT_CHARS = 20_000
/** Less room than this left in the snapshot: the frame is only named. */
const MIN_FRAME_SNAPSHOT_CHARS = 400

/** A snapshot and the document it was taken of. */
export interface Snapshot {
  doc: string
  text: string
}

/** What browser_find found: lines like the snapshot's, where they are; and how many there were in all. */
export interface FindResult {
  items: { line: string; region: string; place: string; context: string }[]
  total: number
  /** Matches that are hidden (not counted in items). */
  hidden: number
}

export interface AuditIssue {
  rule: string
  severity: 'error' | 'warning'
  /** The element, as a snapshot line with ref; null: the page as a whole. */
  line: string | null
  detail: string
}

/** What the accessibility check found; `counts` by rule, also beyond the issues listed. */
export interface AuditResult {
  issues: AuditIssue[]
  counts: Record<string, number>
  checked: number
  /** Frames of other sites the page has (checked when the last snapshot found them). */
  foreign: number
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One page Claude drives: input through the DevTools protocol, reading through the scripts. */
export class PageDriver {
  /**
   * `focusView`: asks the window to give the page its keyboard (see `takeKeyboard`). `frames`: the
   * page's frames of other sites, kept by the browser across actions; without it they aren't read.
   */
  constructor(
    readonly contents: WebContents,
    private readonly focusView?: () => void,
    private readonly frames?: PageFrames,
  ) {}

  cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.contents.debugger.sendCommand(method, params) as Promise<T>
  }

  /** A command for one DevTools session: a frame in a process of its own; undefined: the page. */
  cdpIn<T = Record<string, unknown>>(session: string | undefined, method: string, params?: Record<string, unknown>): Promise<T> {
    if (session === undefined) return this.cdp<T>(method, params)
    return this.contents.debugger.sendCommand(method, params, session) as Promise<T>
  }

  /** Calls a helper of page-scripts.ts in the page. */
  async call<T>(name: string, ...args: unknown[]): Promise<T> {
    const run = this.contents.executeJavaScriptInIsolatedWorld(SCRIPT_WORLD, [{ code: pageCall(name, ...args) }])
    const result = (await withTimeout(run, SCRIPT_TIMEOUT_MS, 'The page did not answer in time (is it busy or showing a dialog?).')) as {
      ok?: T
      error?: string
    } | null
    if (!result) throw new Error('The page did not answer.')
    if (result.error !== undefined) throw new Error(result.error)
    return result.ok as T
  }

  /** Calls a helper for the element `ref` (its first argument), in the page or in the frame the ref is from. */
  callAt<T>(ref: string, name: string, ...args: unknown[]): Promise<T> {
    const { frame, local } = parseRef(ref)
    if (frame === null) return this.call<T>(name, ref, ...args)
    return this.inFrame<T>(this.frameRecord(frame, ref), name, local, ...args)
  }

  /** The outline of the page with refs, frames of other sites included. */
  async snapshot(): Promise<Snapshot> {
    const shot = await this.call<Snapshot>('snapshot', MAX_SNAPSHOT_CHARS, false)
    if (this.frames) this.frames.setDocument(shot.doc)
    if (!shot.text.includes(FRAME_MARK)) return shot
    const text = await this.fillFrames(shot.text, null, MAX_SNAPSHOT_CHARS - shot.text.length, 0)
    return { doc: shot.doc, text }
  }

  async locate(ref: string): Promise<ElementBox> {
    const { frame, local } = parseRef(ref)
    if (frame === null) return this.call<ElementBox>('locate', ref)
    const record = this.frameRecord(frame, ref)
    const box = await this.inFrame<ElementBox>(record, 'locate', local)
    const offset = await this.frameOffset(record, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    return { ...box, x: box.x + offset.x, y: box.y + offset.y }
  }

  /** Two elements for a drag, both in view if they fit (see the script's locatePair); in one frame. */
  async locatePair(fromRef: string, toRef: string): Promise<{ from: ElementBox; to: ElementBox; together: boolean }> {
    const from = parseRef(fromRef)
    const to = parseRef(toRef)
    if (from.frame !== to.frame) throw new Error('The element and the target are in different frames; dragging from one frame into another is not possible.')
    if (from.frame === null) return this.call('locatePair', fromRef, toRef)
    const record = this.frameRecord(from.frame, fromRef)
    const pair = await this.inFrame<{ from: ElementBox; to: ElementBox; together: boolean }>(record, 'locatePair', from.local, to.local)
    const offset = await this.frameOffset(record, { x: pair.from.x + pair.from.width / 2, y: pair.from.y + pair.from.height / 2 })
    const shift = (box: ElementBox) => ({ ...box, x: box.x + offset.x, y: box.y + offset.y })
    return { ...pair, from: shift(pair.from), to: shift(pair.to) }
  }

  /**
   * Elements by text or role (browser_find), in the page and in the frames of other sites the last
   * snapshot found; their refs work like the snapshot's.
   */
  async find(text: string, role: string, exact: boolean, limit: number): Promise<FindResult> {
    const result = await this.call<FindResult>('find', text, role, exact, limit)
    for (const record of this.frames?.all() ?? []) {
      const inner = await this.inFrame<FindResult>(record, 'find', text, role, exact, Math.max(0, limit - result.items.length)).catch(() => null)
      if (!inner) continue
      result.items.push(...inner.items.map((item) => ({ ...item, line: prefixRefs(item.line, record.num), region: `frame f${record.num}${item.region ? `, ${item.region}` : ''}` })))
      result.total += inner.total
      result.hidden += inner.hidden
    }
    return result
  }

  /** The accessibility check (browser_check_accessibility) of the page and of the frames of other sites the last snapshot found. */
  async audit(perRule: number): Promise<AuditResult> {
    const result = await this.call<AuditResult>('audit', perRule)
    let foreign = result.foreign
    for (const record of this.frames?.all() ?? []) {
      const inner = await this.inFrame<AuditResult>(record, 'audit', perRule).catch(() => null)
      if (!inner) continue
      foreign--
      result.checked += inner.checked
      for (const issue of inner.issues) {
        // A frame's own page rules (its lang, title, zoom) are its business, not the page's.
        if (!issue.line) continue
        if ((result.counts[issue.rule] ?? 0) < perRule) result.issues.push({ ...issue, line: prefixRefs(issue.line, record.num) })
        result.counts[issue.rule] = (result.counts[issue.rule] ?? 0) + 1
      }
    }
    return { ...result, foreign: Math.max(0, foreign) }
  }

  /** Whether the text is on the page or in one of the frames of other sites the last snapshot found. */
  async hasText(text: string): Promise<boolean> {
    if (await this.call<boolean>('hasText', text)) return true
    for (const record of this.frames?.all() ?? []) {
      if (await this.inFrame<boolean>(record, 'hasText', text).catch(() => false)) return true
    }
    return false
  }

  private frameRecord(frame: number, ref: string): FrameRecord {
    const record = this.frames?.get(frame)
    if (!record) throw new Error(`The frame of ${ref} is gone. Take a new browser_snapshot: refs change with the page.`)
    return record
  }

  /** Calls a helper of page-scripts.ts in a frame of another site, in the page driver's world there. */
  private async inFrame<T>(record: FrameRecord, name: string, ...args: unknown[]): Promise<T> {
    type Evaluation = { result: { value?: { ok?: T; error?: string } | null }; exceptionDetails?: { text: string } }
    const evaluate = async (): Promise<Evaluation> => {
      const contextId = await this.frameContext(record)
      return this.cdpIn<Evaluation>(record.session, 'Runtime.evaluate', { expression: pageCall(name, ...args), contextId, returnByValue: true })
    }
    let evaluation: Evaluation
    try {
      evaluation = await withTimeout(evaluate(), SCRIPT_TIMEOUT_MS, 'The frame did not answer in time.')
    } catch (error) {
      // Its document changed (and took the world with it), or it runs in another process now.
      record.contextId = null
      const message = error instanceof Error ? error.message : String(error)
      if (!/context|session|target/i.test(message)) throw error
      evaluation = await withTimeout(evaluate(), SCRIPT_TIMEOUT_MS, 'The frame did not answer in time.').catch(() => {
        throw new Error(`The frame f${record.num} is gone. Take a new browser_snapshot.`)
      })
    }
    if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.text)
    const result = evaluation.result.value
    if (!result) throw new Error('The frame did not answer.')
    if (result.error !== undefined) throw new Error(frameError(result.error, record.num))
    return result.ok as T
  }

  private async frameContext(record: FrameRecord): Promise<number> {
    if (record.contextId !== null) return record.contextId
    const { executionContextId } = await this.cdpIn<{ executionContextId: number }>(record.session, 'Page.createIsolatedWorld', {
      frameId: record.frameId,
      worldName: FRAME_WORLD,
      grantUniveralAccess: false,
    })
    record.contextId = executionContextId
    return executionContextId
  }

  /**
   * Puts the snapshots of frames of other sites in the place of their marks in `text` (a snapshot of
   * the page, or of the frame `scope`), each with no more than `room` characters in all.
   */
  private async fillFrames(text: string, scope: FrameRecord | null, room: number, depth: number): Promise<string> {
    const marks = [...text.matchAll(FRAME_MARK_RE)]
    if (marks.length === 0) return text
    const frameIds = this.frames && depth < MAX_FRAME_DEPTH ? await this.findFrames(scope, marks.map((m) => m[2])).catch(() => new Map<string, string>()) : new Map<string, string>()
    const parts = new Map<string, string>()
    let left = room
    for (const [, indent, ref] of marks) {
      const frameId = frameIds.get(ref)
      if (!frameId || !this.frames) {
        parts.set(ref, `${indent}- (content of another site, not readable)`)
        continue
      }
      if (left < MIN_FRAME_SNAPSHOT_CHARS) {
        parts.set(ref, `${indent}- (content left out: the snapshot is full)`)
        continue
      }
      try {
        const record = this.frames.record(frameId, scope, ref)
        const shot = await this.inFrame<Snapshot>(record, 'snapshot', Math.min(left, MAX_FRAME_SNAPSHOT_CHARS), true)
        const inner = prefixRefs(await this.fillFrames(shot.text, record, left - shot.text.length, depth + 1), record.num)
        const part = indentLines(inner, indent)
        left -= part.length
        parts.set(ref, part)
      } catch (error) {
        parts.set(ref, `${indent}- (content of another site, could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`)
      }
    }
    return text.replace(FRAME_MARK_RE, (line, _indent, ref: string) => parts.get(ref) ?? line)
  }

  /**
   * The frame ids of iframes (by their refs in the page or in the frame `scope`): the script marks
   * them, the DevTools protocol finds the marks and tells which frame each element holds.
   */
  private async findFrames(scope: FrameRecord | null, refs: string[]): Promise<Map<string, string>> {
    const token = randomUUID().replace(/-/g, '')
    const prefix = `cm-frame-${token}-`
    const inScope = <T>(name: string, ...args: unknown[]) => (scope ? this.inFrame<T>(scope, name, ...args) : this.call<T>(name, ...args))
    const session = scope?.session
    const found = new Map<string, string>()
    await inScope('markFrames', token, refs)
    try {
      await this.cdpIn(session, 'DOM.getDocument', { depth: 0 })
      const { searchId, resultCount } = await this.cdpIn<{ searchId: string; resultCount: number }>(session, 'DOM.performSearch', {
        query: prefix,
        includeUserAgentShadowDOM: false,
      })
      try {
        if (resultCount > 0) {
          const { nodeIds } = await this.cdpIn<{ nodeIds: number[] }>(session, 'DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount })
          for (const nodeId of nodeIds) {
            const { node } = await this.cdpIn<{ node: { attributes?: string[]; frameId?: string } }>(session, 'DOM.describeNode', { nodeId })
            const attributes = node.attributes ?? []
            const value = attributes[attributes.indexOf('data-claude-manager-frame') + 1] ?? ''
            if (node.frameId && value.startsWith(prefix)) found.set(value.slice(prefix.length), node.frameId)
          }
        }
      } finally {
        await this.cdpIn(session, 'DOM.discardSearchResults', { searchId }).catch(() => undefined)
      }
    } finally {
      await inScope('unmarkFrames').catch(() => undefined)
    }
    return found
  }

  /**
   * Where the document of a frame starts in the page's viewport (CSS pixels), with `point` (in the
   * frame's own pixels) scrolled into view in every frame around it.
   */
  private async frameOffset(record: FrameRecord, point: { x: number; y: number }): Promise<{ x: number; y: number }> {
    let x = 0
    let y = 0
    let current = record
    let spot = point
    for (let depth = 0; depth <= MAX_FRAME_DEPTH; depth++) {
      const parent = current.parent === null ? null : this.frames?.get(current.parent)
      if (current.parent !== null && !parent) break
      const box = await (parent
        ? this.inFrame<{ x: number; y: number }>(parent, 'locateFrame', current.ownerRef, spot)
        : this.call<{ x: number; y: number }>('locateFrame', current.ownerRef, spot)
      ).catch((error: Error) => {
        throw new Error(`The frame f${record.num} is gone (${error.message.split('\n')[0]}). Take a new browser_snapshot.`)
      })
      x += box.x
      y += box.y
      if (!parent) return { x, y }
      spot = { x: spot.x + box.x, y: spot.y + box.y }
      current = parent
    }
    throw new Error(`The frame f${record.num} is gone. Take a new browser_snapshot.`)
  }

  zoom(): number {
    return this.contents.getZoomFactor()
  }

  /**
   * The size the page has in the window (CSS pixels). In phone mode a page without a viewport meta
   * tag lays out wider and is shown zoomed out: then the visual viewport tells.
   */
  async viewportSize(): Promise<{ width: number; height: number }> {
    const { result } = await this.cdp<{ result: { value?: [number, number] } }>('Runtime.evaluate', {
      expression:
        '(() => { const v = visualViewport; return v && v.scale < 0.99 ? [Math.round(v.width * v.scale), Math.round(v.height * v.scale)] : [innerWidth, innerHeight] })()',
      returnByValue: true,
    })
    const [width, height] = result.value ?? [0, 0]
    return { width, height }
  }

  async click(x: number, y: number, options: { button?: MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<void> {
    const { button = 'left', clickCount = 1, modifiers = 0 } = options
    await this.mouse({ type: 'mouseMoved', x, y, modifiers })
    for (let count = 1; count <= clickCount; count++) {
      await this.mouse({ type: 'mousePressed', x, y, button, buttons: BUTTON_BITS[button], clickCount: count, modifiers })
      await this.mouse({ type: 'mouseReleased', x, y, button, buttons: 0, clickCount: count, modifiers })
    }
  }

  /**
   * Drags from one spot to another in `durationMs`, with the left button held. A drag of the page
   * (HTML drag and drop) is caught before it becomes one of the system, which would hold the app
   * until the real mouse lets go, and dropped through the DevTools protocol; others (sliders,
   * sortable lists that follow the pointer) just get the moves and the release. Returns which it was.
   */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<'drop' | 'pointer'> {
    // Filled by the protocol's message once the page started a drag of its own.
    const caught: { data: Record<string, unknown> | null } = { data: null }
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Input.dragIntercepted') caught.data = params.data as Record<string, unknown>
    }
    this.contents.debugger.on('message', onMessage)
    let entered = false
    const dragEvent = async (type: 'dragEnter' | 'dragOver' | 'drop', x: number, y: number) => {
      await this.cdp('Input.dispatchDragEvent', { type, x, y, data: caught.data })
      entered = true
    }
    try {
      await this.cdp('Input.setInterceptDrags', { enabled: true })
      await this.mouse({ type: 'mouseMoved', x: from.x, y: from.y })
      await this.mouse({ type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
      const steps = Math.max(6, Math.min(40, Math.round(durationMs / 16)))
      for (let step = 1; step <= steps; step++) {
        const x = from.x + ((to.x - from.x) * step) / steps
        const y = from.y + ((to.y - from.y) * step) / steps
        if (caught.data) await dragEvent(entered ? 'dragOver' : 'dragEnter', x, y)
        else {
          await this.mouse({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
          // The page starts its drag with one of the first moves; the protocol reports it a moment later.
          if (step <= 3) await delay(40)
          if (caught.data) await dragEvent('dragEnter', x, y)
        }
        await delay(Math.max(0, durationMs / steps - 8))
      }
      if (caught.data) {
        await dragEvent('dragOver', to.x, to.y)
        await dragEvent('drop', to.x, to.y)
        return 'drop'
      }
      await this.mouse({ type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
      return 'pointer'
    } finally {
      this.contents.debugger.removeListener('message', onMessage)
      if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) {
        await this.cdp('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
      }
    }
  }

  async hover(x: number, y: number): Promise<void> {
    await this.mouse({ type: 'mouseMoved', x, y })
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.mouse({ type: 'mouseWheel', x, y, deltaX, deltaY })
  }

  /** One of Claude's mouse events; the page passes it on (`before-mouse-event`) before it answers. */
  private async mouse(event: Record<string, unknown>): Promise<void> {
    const { contents } = this
    claudesMice.set(contents, (claudesMice.get(contents) ?? 0) + 1)
    try {
      await this.cdp('Input.dispatchMouseEvent', event)
    } finally {
      const left = (claudesMice.get(contents) ?? 1) - 1
      if (left > 0) claudesMice.set(contents, left)
      else claudesMice.delete(contents)
    }
  }

  async insertText(text: string): Promise<void> {
    await this.takeKeyboard()
    await this.cdp('Input.insertText', { text })
  }

  async press(combo: string): Promise<void> {
    const events = keyEvents(combo)
    await this.takeKeyboard()
    for (const event of events) await this.cdp('Input.dispatchKeyEvent', { ...event })
  }

  /**
   * Keys only reach the page while its view has the window's keyboard (the page's own idea of focus,
   * `isFocused`, says nothing about that); the window gives it back after the action.
   */
  private async takeKeyboard(): Promise<void> {
    if (!this.focusView) return
    this.focusView()
    await delay(50)
  }

  /** Waits until a navigation the last action started has loaded (at most `maxMs`). */
  async settle(maxMs: number): Promise<void> {
    await delay(150)
    if (this.contents.isDestroyed() || !this.contents.isLoading()) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        if (!this.contents.isDestroyed()) this.contents.removeListener('did-stop-loading', done)
        resolve()
      }
      const timer = setTimeout(done, maxMs)
      this.contents.once('did-stop-loading', done)
    })
    await delay(100)
  }

  /** The visible part of the page, or of one element (`rect` in CSS pixels of the viewport). */
  async capture(rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImage> {
    const zoom = this.zoom()
    const area = rect && {
      x: Math.max(0, Math.round(rect.x * zoom)),
      y: Math.max(0, Math.round(rect.y * zoom)),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    }
    await this.wakeUp()
    const image = await withTimeout(area ? this.contents.capturePage(area) : this.contents.capturePage(), 10_000, 'The page could not be captured.')
    if (image.isEmpty()) throw new Error('The page could not be captured (it has no size right now).')
    return scaleDown(image)
  }

  /**
   * The whole page from top to bottom (up to MAX_FULL_PAGE_HEIGHT), put together from one picture per
   * window height: a view in the window draws only what it shows, also for the DevTools protocol.
   * Bars fixed to the window appear once per picture.
   */
  async captureFullPage(): Promise<{ image: NativeImage; cut: boolean }> {
    const metrics = await this.cdp<{
      cssContentSize: { height: number }
      cssLayoutViewport: { clientWidth: number; clientHeight: number }
    }>('Page.getLayoutMetrics')
    const viewport = metrics.cssLayoutViewport.clientHeight
    const viewportWidth = metrics.cssLayoutViewport.clientWidth
    const full = Math.ceil(metrics.cssContentSize.height)
    const height = Math.min(full, MAX_FULL_PAGE_HEIGHT)
    // Pixels of the result per CSS pixel: no more than the page's own, no wider than MAX_SHOT_WIDTH.
    const scale = Math.min(1, MAX_SHOT_WIDTH / viewportWidth)
    const rows = Math.max(1, Math.round(height * scale))
    const start = await this.scrollTo(null)
    await this.wakeUp()
    let out: Buffer | null = null
    let width = 0
    let filled = 0
    try {
      let previous = -1
      for (let top = 0; filled < rows; top += viewport) {
        const at = await this.scrollTo(top)
        if (at === previous) break
        previous = at
        await delay(REPAINT_MS)
        const shot = await withTimeout(this.contents.capturePage(), 10_000, 'The page could not be captured.')
        if (shot.isEmpty()) throw new Error('The page could not be captured (it has no size right now).')
        const size = shot.getSize()
        const perCss = size.height / viewport
        // Without the scroll bar, which would show once per picture.
        const page = shot.crop({ x: 0, y: 0, width: Math.min(size.width, Math.round(viewportWidth * perCss)), height: size.height })
        const segment = page.resize({
          width: Math.max(1, Math.round(viewportWidth * scale)),
          height: Math.max(1, Math.round(viewport * scale)),
          quality: 'good',
        })
        const bitmap = segment.toBitmap()
        const { width: segmentWidth, height: segmentHeight } = segment.getSize()
        if (!out) {
          width = segmentWidth
          out = Buffer.alloc(width * rows * 4)
        }
        const offset = Math.round(at * scale)
        const stride = Math.min(width, segmentWidth) * 4
        for (let row = Math.max(0, filled - offset); row < segmentHeight && offset + row < rows; row++) {
          bitmap.copy(out, (offset + row) * width * 4, row * segmentWidth * 4, row * segmentWidth * 4 + stride)
        }
        filled = Math.min(rows, offset + segmentHeight)
      }
    } finally {
      await this.scrollTo(start).catch(() => undefined)
    }
    if (!out) throw new Error('The page could not be captured.')
    const image = nativeImage.createFromBitmap(out, { width, height: filled })
    return { image, cut: full > height }
  }

  /**
   * A page that doesn't draw right now (hidden tab, covered window) gives its last picture to the
   * first capture, which makes it draw again: the next one is current.
   */
  private async wakeUp(): Promise<void> {
    await withTimeout(this.contents.capturePage({ x: 0, y: 0, width: 1, height: 1 }), 5000, 'The page could not be captured.')
    await delay(100)
  }

  /** Scrolls the page to `top` (CSS pixels; null: stays) and returns where it is. */
  private async scrollTo(top: number | null): Promise<number> {
    const expression =
      top === null ? 'scrollY' : `(window.scrollTo({ top: ${Math.round(top)}, left: scrollX, behavior: 'instant' }), scrollY)`
    const { result } = await this.cdp<{ result: { value?: number } }>('Runtime.evaluate', { expression, returnByValue: true })
    return Math.round(result.value ?? 0)
  }
}

function scaleDown(image: NativeImage): NativeImage {
  const { width } = image.getSize()
  return width > MAX_SHOT_WIDTH ? image.resize({ width: MAX_SHOT_WIDTH, quality: 'good' }) : image
}
