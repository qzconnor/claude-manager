import { nativeImage, type NativeImage, type WebContents } from 'electron'
import { keyEvents } from './keys'
import { MAX_SNAPSHOT_CHARS, pageCall, SCRIPT_WORLD } from './page-scripts'

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

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One page Claude drives: input through the DevTools protocol, reading through the scripts. */
export class PageDriver {
  /** `focusView`: asks the window to give the page its keyboard (see `takeKeyboard`). */
  constructor(
    readonly contents: WebContents,
    private readonly focusView?: () => void,
  ) {}

  cdp<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.contents.debugger.sendCommand(method, params) as Promise<T>
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

  snapshot(): Promise<string> {
    return this.call<string>('snapshot', MAX_SNAPSHOT_CHARS)
  }

  locate(ref: string): Promise<ElementBox> {
    return this.call<ElementBox>('locate', ref)
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
