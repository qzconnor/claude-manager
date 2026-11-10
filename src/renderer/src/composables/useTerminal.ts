import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme, type ITerminalOptions } from '@xterm/xterm'
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { PastedImage, TerminalSettings } from '@shared/types'
import { drawBlockGlyphs } from '@/lib/block-glyphs'
import { drawLigatures, type Ligatures } from '@/lib/ligatures'
import { createBackgroundFilter, slotPalette, type SlotTints } from '@/lib/claude-backgrounds'
import { claudeInputAt } from '@/lib/claude-input'
import { answerColorQueries } from '@/lib/color-queries'
import { matchShortcut } from '@shared/shortcuts'
import { addedImageRef, countImageRefs, pastedImageLinks } from '@/lib/pasted-image-links'
import { terminalBus } from '@/lib/terminal-bus'
import { makeSlotsTranslucent, setSlotTints } from '@/lib/translucent-slots'
import { urlLinks } from '@/lib/url-links'
import { useAppStore } from '@/stores/app'
import { useFileTreeStore } from '@/stores/file-tree'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import type { TerminalPalette } from '@shared/themes/types'
import { buildFontStack, ensureFontLoaded, useTerminalAppearance } from './useTerminalAppearance'

export interface UseTerminalOptions {
  terminalId: string
  /** Runs Claude Code, which can take images from the clipboard. */
  claudeSession: boolean
  container: Ref<HTMLElement | null>
  /** The tab is visible — fit and focus when this turns true. */
  active: Ref<boolean>
}

/** The first Windows build whose ConPTY wraps lines like a terminal; xterm needs no workaround from it on. */
const MODERN_CONPTY_BUILD = 21376

/** A hidden terminal gives up its WebGL context after this long; it gets a new one when shown again (ms). */
const WEBGL_HIDDEN_MS = 30_000
/**
 * At most this many terminals hold a WebGL context. Chromium keeps about 16 per window and drops the
 * oldest beyond that, also one on screen; hidden terminals give theirs up first.
 */
const MAX_WEBGL_CONTEXTS = 8
/** After this many lost contexts (GPU resets) a terminal stays with the DOM renderer. */
const MAX_WEBGL_LOSSES = 3
/** The numbers of the pasted images are asked for again after this long: a prompt may have brought new ones (ms). */
const IMAGE_IDS_MS = 1000
/**
 * xterm drops the link under the mouse whenever its row is drawn anew (Claude Code redraws while it
 * works) and gives it back right after: the preview waits this long before it goes (ms).
 */
const PREVIEW_LEAVE_MS = 200
/** How long Claude Code may take to put a pasted image at the cursor as `[Image #N]` (ms). */
const PASTE_WAIT_MS = 5000
/** Rows above the screen where the `[Image #N]` of a pasted image is looked for: a long prompt reaches up there. */
const PASTE_ROWS_ABOVE = 20

/** A pasted image (`[Image #N]`) the mouse rests on, where the mouse is, and the image once it is loaded. */
export interface ImagePreview {
  id: number
  x: number
  y: number
  image: PastedImage | null
}

/** A pasted image opened in full size. */
export interface OpenedImage extends PastedImage {
  id: number
}

interface WebglHolder {
  shown: () => boolean
  release: () => void
}

/** The terminals with a WebGL context, the one shown last at the end. */
const webglHolders = new Map<symbol, WebglHolder>()

/** `key` holds a context (again) and was shown last; hidden terminals beyond the limit give theirs up, the longest unseen first. */
function holdWebgl(key: symbol, holder: WebglHolder): void {
  webglHolders.delete(key)
  webglHolders.set(key, holder)
  for (const [other, { shown, release }] of webglHolders) {
    if (webglHolders.size <= MAX_WEBGL_CONTEXTS) break
    if (other !== key && !shown()) release()
  }
}

/** xterm's WebGL renderer in a terminal; `dispose` takes it out again. */
export interface LoadedWebgl {
  addon: WebglAddon
  dispose(): void
}

/**
 * Loads xterm's WebGL renderer into `term`; throws without WebGL. Disposing the addon only takes the
 * canvas away and its context would count against Chromium's limit until garbage collected, so
 * `dispose` also loses the context right away.
 */
export function loadWebgl(term: Terminal): LoadedWebgl {
  const before = new Set(term.element?.querySelectorAll('canvas'))
  const addon = new WebglAddon()
  term.loadAddon(addon)
  makeSlotsTranslucent(addon)
  const canvas = [...(term.element?.querySelectorAll('canvas') ?? [])].find((c) => !before.has(c)) ?? null
  return {
    addon,
    dispose() {
      // The canvas has a WebGL 2 context already, so this asks for no new one.
      const gl = canvas?.getContext('webgl2')
      addon.dispose()
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

/** `tints` are the colors of the palette slots that Claude's backgrounds are exchanged for. */
export function toXtermTheme(p: TerminalPalette, tints: SlotTints): ITheme {
  return {
    ...p,
    // The container paints the background so the window material can shine through.
    background: '#00000000',
    extendedAnsi: slotPalette(tints, p.background),
    scrollbarSliderBackground: 'rgba(128, 128, 128, 0.25)',
    scrollbarSliderHoverBackground: 'rgba(128, 128, 128, 0.4)',
    scrollbarSliderActiveBackground: 'rgba(128, 128, 128, 0.55)',
  }
}

/** Also call `setSlotTints` with the same tints, so the see-through slots match the theme. */
export function terminalOptions(s: TerminalSettings, palette: TerminalPalette, tints: SlotTints): ITerminalOptions {
  return {
    fontFamily: buildFontStack(s.fontFamily),
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    fontWeight: s.fontWeight as ITerminalOptions['fontWeight'],
    fontWeightBold: s.fontWeightBold as ITerminalOptions['fontWeightBold'],
    cursorStyle: s.cursorStyle,
    cursorInactiveStyle: 'outline',
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    minimumContrastRatio: s.minimumContrastRatio,
    theme: toXtermTheme(palette, tints),
  }
}

interface RenderService {
  dimensions: { css: { cell: { width: number; height: number } } }
  clear(): void
}

/** xterm keeps the cell size private; the fit addon reads it the same way. */
export function renderService(term: Terminal): RenderService {
  return (term as unknown as { _core: { _renderService: RenderService } })._core._renderService
}

/**
 * Fits whole columns between the left and right padding. What is left over for a whole column
 * goes half to each side, so every change of either padding moves the text and equal paddings
 * look equal. `offset` is where the first column starts.
 */
export function placeColumns(width: number, cellWidth: number, left: number, right: number): { cols: number; offset: number } {
  const cols = Math.max(2, Math.floor((width - left - right) / cellWidth))
  const rest = Math.max(0, width - left - right - cols * cellWidth)
  // Whole device pixels, otherwise the text gets blurry. Rounded down, so the last column always fits.
  const ratio = window.devicePixelRatio || 1
  return { cols, offset: Math.floor((left + rest / 2) * ratio) / ratio }
}

/** Rows at the bottom of the screen below the cursor with neither text nor a background. */
function emptyRowsAtBottom(term: Terminal): number {
  const buffer = term.buffer.active
  const cell = buffer.getNullCell()
  let empty = 0
  for (let y = term.rows - 1; y > buffer.cursorY; y--) {
    const line = buffer.getLine(buffer.baseY + y)
    for (let x = 0; line && x < term.cols; x++) {
      line.getCell(x, cell)
      if ((cell.getChars() && cell.getChars() !== ' ') || !cell.isBgDefault() || cell.isInverse()) return empty
    }
    empty++
  }
  return empty
}

interface Linkifier {
  _activeLine: number
  _lastBufferCell: unknown
  _currentLink: unknown
}

/**
 * xterm caches the links of the row under the mouse and only looks again once the mouse moves to
 * another row, so a URL written into that row later (Claude's answer appearing under a resting
 * mouse) never gets its hover underline. Dropping the cache makes the next mouse move look again.
 * An underlined link is left alone; xterm refreshes it itself when its row changes.
 */
function forgetCachedLinks(term: Terminal): void {
  const linkifier = (term as unknown as { _core: { linkifier?: Linkifier } })._core.linkifier
  if (!linkifier || linkifier._currentLink) return
  linkifier._activeLine = -1
  linkifier._lastBufferCell = undefined
}

export function useTerminal(options: UseTerminalOptions) {
  const { terminalId, claudeSession, container, active } = options
  const settingsStore = useSettingsStore()
  const appStore = useAppStore()
  const terminalsStore = useTerminalsStore()
  const fileTree = useFileTreeStore()
  const { palette, dark, slotTints, backgrounds, logo } = useTerminalAppearance()
  /** All output passes through here on its way to xterm. */
  const filterOutput = createBackgroundFilter(
    () => backgrounds.value,
    () => logo.value,
  )

  const ready = ref(false)
  const hasSelection = ref(false)
  let term: Terminal | null = null
  let searchAddon: SearchAddon | null = null
  let webgl: LoadedWebgl | null = null
  const webglKey = Symbol(terminalId)
  /** On screen (not in a hidden tab, group or page). */
  let shown = false
  let hiddenTimer = 0
  let webglLosses = 0
  let resizeObserver: ResizeObserver | null = null
  let visibilityObserver: IntersectionObserver | null = null
  let fitFrame = 0
  /** Height of the container at the last fit, so writes don't have to measure the layout. */
  let viewHeight = 0
  /** Current downward shift of the rows (see `align`). */
  let shiftY = 0
  let disposed = false
  let ligatures: Ligatures | null = null
  const cleanups: (() => void)[] = []

  const imagePreview = ref<ImagePreview | null>(null)
  const openedImage = ref<OpenedImage | null>(null)
  /** The numbers of the pasted images, as last asked for; `known` once they came. */
  let imageIds: { at: number; ids: Promise<ReadonlySet<number>>; known: ReadonlySet<number> | null } | null = null
  /** Counts hovers: an image that loads after the mouse moved on isn't shown. */
  let imageHover = 0
  let previewLeaveTimer = 0
  /** Stops waiting for the `[Image #N]` of an image just pasted. */
  let stopAwaitingPaste: (() => void) | null = null

  function write(data: string): void {
    window.api.terminals.write(terminalId, data)
  }

  /**
   * The numbers of the images pasted in the tab's session; asked for once per row the mouse enters, at
   * most every second. Known from the last second, they come right away.
   */
  function pastedImageIds(): ReadonlySet<number> | Promise<ReadonlySet<number>> {
    if (!imageIds || Date.now() - imageIds.at > IMAGE_IDS_MS) {
      const asked: NonNullable<typeof imageIds> = { at: Date.now(), ids: Promise.resolve(new Set()), known: null }
      asked.ids = window.api.terminals.pastedImageIds(terminalId).then((ids) => (asked.known = new Set(ids)))
      imageIds = asked
    }
    return imageIds.known ?? imageIds.ids
  }

  function showImage(id: number, event: MouseEvent): void {
    clearTimeout(previewLeaveTimer)
    const shown = imagePreview.value
    // The same link back after its row was drawn anew: the preview stays as it is.
    if (shown?.id === id) {
      if (shown.x !== event.clientX || shown.y !== event.clientY) imagePreview.value = { ...shown, x: event.clientX, y: event.clientY }
      return
    }
    const hover = ++imageHover
    imagePreview.value = { id, x: event.clientX, y: event.clientY, image: null }
    void window.api.terminals.pastedImage(terminalId, id).then(
      (image) => {
        if (hover !== imageHover || !imagePreview.value) return
        imagePreview.value = image ? { ...imagePreview.value, image } : null
      },
      () => {
        if (hover === imageHover) imagePreview.value = null
      },
    )
  }

  function hideImage(): void {
    clearTimeout(previewLeaveTimer)
    imageHover++
    imagePreview.value = null
  }

  /** The mouse left the link, or xterm dropped it to draw its row anew: the preview goes unless it comes back. */
  function leaveImage(): void {
    clearTimeout(previewLeaveTimer)
    if (imagePreview.value) previewLeaveTimer = window.setTimeout(hideImage, PREVIEW_LEAVE_MS)
  }

  async function openImage(id: number): Promise<void> {
    const shown = imagePreview.value
    hideImage()
    const image = shown?.id === id && shown.image ? shown.image : await window.api.terminals.pastedImage(terminalId, id).catch(() => null)
    if (image) openedImage.value = { id, ...image }
  }

  /** The `[Image #N]` on the screen and a little above, where Claude Code's prompt is. */
  function screenImageRefs(t: Terminal): Map<number, number> {
    const buffer = t.buffer.active
    return countImageRefs(buffer, buffer.baseY - PASTE_ROWS_ABOVE, buffer.baseY + t.rows)
  }

  /**
   * An image goes from the clipboard to Claude Code, which puts it at the cursor as `[Image #N]`. Once
   * that shows, the app keeps a copy of the clipboard under the number: so the image shows before the
   * prompt is sent, while the transcript doesn't have it yet.
   */
  function awaitPastedImage(): void {
    const t = term
    if (!t) return
    stopAwaitingPaste?.()
    const before = screenImageRefs(t)
    const subscription = t.onWriteParsed(() => {
      const id = addedImageRef(before, screenImageRefs(t))
      if (id === null) return
      stop()
      void window.api.terminals.keepPastedImage(terminalId, id).then(
        () => (imageIds = null),
        () => undefined,
      )
    })
    const timer = window.setTimeout(() => stop(), PASTE_WAIT_MS)
    function stop(): void {
      subscription.dispose()
      clearTimeout(timer)
      if (stopAwaitingPaste === stop) stopAwaitingPaste = null
    }
    stopAwaitingPaste = stop
  }

  async function copySelection(): Promise<boolean> {
    if (!term?.hasSelection()) return false
    await navigator.clipboard.writeText(term.getSelection())
    return true
  }

  async function pasteClipboard(): Promise<void> {
    const text = await navigator.clipboard.readText()
    if (text) {
      term?.paste(text)
      return
    }
    // Claude Code takes the image from the clipboard itself and puts an [Image #N] at the cursor:
    // on Alt+V under Windows (Ctrl+V is the terminal's text paste there), elsewhere on Ctrl+V.
    if (claudeSession && (await window.api.app.clipboardHasImage())) {
      awaitPastedImage()
      write(appStore.info?.platform === 'win32' ? '\x1bv' : '\x16')
    }
  }

  function enableWebgl(): void {
    if (!term) return
    if (webgl) {
      holdWebgl(webglKey, { shown: () => shown, release: disableWebgl })
      return
    }
    if (webglLosses >= MAX_WEBGL_LOSSES) return
    try {
      const loaded = loadWebgl(term)
      loaded.addon.onContextLoss(() => {
        // GPU reset or too many contexts: a terminal on screen gets a new one right away, a hidden one
        // when shown again; the DOM renderer draws meanwhile.
        webglLosses++
        if (webgl !== loaded) {
          loaded.addon.dispose()
          return
        }
        disableWebgl()
        if (shown) enableWebgl()
      })
      webgl = loaded
      holdWebgl(webglKey, { shown: () => shown, release: disableWebgl })
    } catch (error) {
      console.warn('[terminal] WebGL unavailable, using DOM renderer', error)
      webgl = null
    }
  }

  function disableWebgl(): void {
    clearTimeout(hiddenTimer)
    webglHolders.delete(webglKey)
    webgl?.dispose()
    webgl = null
  }

  /** Only terminals on screen keep a WebGL context: one hidden for a while gives it up. */
  function setShown(next: boolean): void {
    if (next) {
      shown = true
      clearTimeout(hiddenTimer)
      if (settingsStore.settings.terminal.renderer === 'webgl') enableWebgl()
      return
    }
    if (!shown) return
    shown = false
    if (webgl) hiddenTimer = window.setTimeout(disableWebgl, WEBGL_HIDDEN_MS)
  }

  /**
   * xterm only shows whole rows. Instead of leaving the rest of the height empty, one more row
   * reaches up to the top edge, where it is cut like the first line of a scrolled list.
   * The container spans the whole width; the left and right padding are kept here. The scrollbar
   * stays at the right edge and lies within the right padding instead of next to it.
   */
  function fit(): void {
    cancelAnimationFrame(fitFrame)
    fitFrame = requestAnimationFrame(() => {
      const el = container.value
      if (!term || !el || el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        const cell = renderService(term).dimensions.css.cell
        if (!cell.width || !cell.height) return
        // The border box: the padding set below does not change it.
        const rect = el.getBoundingClientRect()
        viewHeight = rect.height
        const { left, right } = settingsStore.settings.terminal.padding
        const { cols, offset } = placeColumns(rect.width, cell.width, left, right)
        el.style.paddingLeft = `${offset}px`
        const rows = Math.max(1, Math.ceil(viewHeight / cell.height - 0.001))
        if (rows !== term.rows || cols !== term.cols) {
          // Like the fit addon: a full render after the resize.
          renderService(term).clear()
          term.resize(cols, rows)
        }
        align()
      } catch {
        // renderer not ready yet
      }
    })
  }

  /**
   * Moves the rows down while nothing lies above them, so the start of the output is not cut at
   * the top edge but has the top padding, as far as the bottom allows.
   */
  function align(): void {
    const el = container.value
    if (!term || !el || !viewHeight) return
    const cell = renderService(term).dimensions.css.cell.height
    if (!cell) return
    const top = settingsStore.settings.terminal.padding.top
    // How far the top row reaches above the edge.
    const overhang = Math.max(0, term.rows * cell - viewHeight)
    const buffer = term.buffer.active
    let shift = 0
    if (buffer.type === 'alternate') {
      // Full-screen programs use every row: centred between the top and bottom padding, so any
      // cut is split between top and bottom.
      shift = (overhang + top) / 2
    } else if (buffer.viewportY === 0) {
      shift =
        buffer.viewportY < buffer.baseY
          ? // Scrolled up to the start: the rows at the bottom are history.
            overhang + top
          : // The live screen: only empty rows below the cursor may move under the bottom edge.
            Math.min(overhang + top, emptyRowsAtBottom(term) * cell)
    }
    // Whole device pixels, otherwise the text gets blurry.
    const ratio = window.devicePixelRatio || 1
    const y = Math.round(shift * ratio) / ratio
    if (y === shiftY) return
    shiftY = y
    el.style.transform = y ? `translateY(${y}px)` : ''
  }

  function focus(): void {
    term?.focus()
  }

  /**
   * Enter on `/diff` in a Claude session shows all changes of its folder in the app instead of Claude
   * Code's diff panel (setting `claude.diffCommand`): the Enter stays here and the input is emptied,
   * so Claude Code shows nothing and Claude sees nothing. Emptied with Ctrl+E (to its end) and a
   * backspace per character; Ctrl+U would leave the hint "Ctrl+Y to paste deleted text", Ctrl+C
   * "Press Ctrl-C again to exit". Whether Enter would run `/diff` is read off the screen (see
   * claudeInputAt); where that fails, the Enter goes on and Claude Code's own `/diff` runs.
   */
  function showChanges(): boolean {
    if (!claudeSession || !term || !settingsStore.settings.claude.diffCommand) return false
    const buffer = term.buffer.active
    const lines = Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
    const input = claudeInputAt(lines, buffer.cursorY)
    if (input?.command !== '/diff') return false
    write('\x05' + '\x7f'.repeat([...input.text].length))
    fileTree.showAllChanges(terminalId)
    return true
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true
    // App shortcuts bubble up to the window listener instead of reaching the shell. Alt+arrow only
    // where it leads to another terminal of the tab (in groups, to another group).
    const shortcut = matchShortcut(e)
    if (shortcut && (shortcut.action !== 'focus-pane' || terminalsStore.neighbour(terminalId, shortcut.direction!))) return false
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey
    const key = e.key.toLowerCase()
    if (ctrl && key === 'c' && (e.shiftKey || term?.hasSelection())) {
      e.preventDefault()
      void copySelection().then((copied) => copied && term?.clearSelection())
      return false
    }
    if (ctrl && key === 'v') {
      e.preventDefault()
      void pasteClipboard()
      return false
    }
    // Claude Code's own key for an image from the clipboard under Windows; it goes on to Claude Code.
    if (claudeSession && key === 'v' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && appStore.info?.platform === 'win32') {
      awaitPastedImage()
    }
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Claude Code inserts a newline on Ctrl+J (line feed) in every terminal.
      e.preventDefault()
      write('\n')
      return false
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing && showChanges()) {
      e.preventDefault()
      return false
    }
    return true
  }

  onMounted(async () => {
    const el = container.value
    if (!el) return
    const s = settingsStore.settings.terminal
    await ensureFontLoaded(s.fontFamily, s.fontSize)
    if (disposed) return

    // xterm works around the line wrapping of old ConPTY versions (Windows 10) by the build number;
    // the ConPTY of Windows Terminal that new tabs use (setting `modernConpty`) doesn't need that.
    const windowsBuild = appStore.info?.windowsBuild ?? null
    const build = windowsBuild && s.modernConpty ? Math.max(windowsBuild, MODERN_CONPTY_BUILD) : windowsBuild
    setSlotTints(slotTints.value)
    term = new Terminal({
      ...terminalOptions(s, palette.value, slotTints.value),
      allowProposedApi: true,
      allowTransparency: true,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
      ...(build ? { windowsPty: { backend: 'conpty' as const, buildNumber: build } } : {}),
      linkHandler: {
        activate: (_event, uri) => {
          if (/^https?:\/\//i.test(uri)) void window.api.app.openExternal(uri)
        },
      },
    })
    searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    term.registerLinkProvider(urlLinks(term, { open: (url) => void window.api.app.openExternal(url) }))
    // Images pasted into Claude Code show where it names them, before and after the prompt is sent.
    if (claudeSession) {
      term.registerLinkProvider(
        pastedImageLinks(term, { ids: pastedImageIds, hover: showImage, leave: leaveImage, open: (id) => void openImage(id) }),
      )
    }
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = s.unicode === 'graphemes' ? '15-graphemes' : '11'

    term.open(el)
    const blockGlyphs = drawBlockGlyphs(term)
    cleanups.push(() => blockGlyphs.dispose())
    const lig = (ligatures = drawLigatures(
      term,
      () => settingsStore.settings.terminal.ligatures,
      () => webgl !== null,
    ))
    cleanups.push(() => lig.dispose())
    // Right away for a terminal on screen, so the output so far isn't drawn by the DOM renderer first.
    setShown(el.getClientRects().length > 0)
    term.attachCustomKeyEventHandler(handleKey)

    const t = term
    // The output so far may hold queries (device attributes, cursor position, colors). When an earlier
    // view answered them (the window reloaded), replies now would reach the program as input and show
    // up in its prompt, e.g. `[?1;2c`; they are dropped while that output is replayed.
    let replaying = false
    const forward = (data: string) => {
      if (!replaying) write(data)
    }
    const subscriptions = [
      t.onData(forward),
      t.onBinary(forward),
      t.onResize(({ cols, rows }) => window.api.terminals.resize(terminalId, cols, rows)),
      t.onScroll(() => {
        align()
        // The rows move under the mouse: the preview stays only if xterm finds the same link there again.
        leaveImage()
      }),
      t.onWriteParsed(() => {
        align()
        forgetCachedLinks(t)
      }),
      t.buffer.onBufferChange(() => align()),
      t.onSelectionChange(() => {
        hasSelection.value = t.hasSelection()
        if (settingsStore.settings.terminal.copyOnSelect && t.hasSelection()) {
          void navigator.clipboard.writeText(t.getSelection())
        }
      }),
      ...answerColorQueries(t, () => ({ background: palette.value.background, dark: dark.value })),
    ]
    cleanups.push(() => subscriptions.forEach((s) => s.dispose()))

    const onContextMenu = (event: MouseEvent) => {
      if (!settingsStore.settings.terminal.rightClickPaste) return
      event.preventDefault()
      if (t.hasSelection()) void copySelection().then(() => t.clearSelection())
      else void pasteClipboard()
    }
    el.addEventListener('contextmenu', onContextMenu)
    cleanups.push(() => el.removeEventListener('contextmenu', onContextMenu))

    // Subscribe before fetching the buffer; the stream offsets remove any overlap.
    let end = -1
    const queued: [string, number][] = []
    const writeChunk = (data: string, offset: number) => {
      if (offset + data.length <= end) return
      t.write(filterOutput(offset < end ? data.slice(end - offset) : data))
      end = offset + data.length
    }
    cleanups.push(
      terminalBus.onData(terminalId, (data, offset) => {
        if (end < 0) queued.push([data, offset])
        else writeChunk(data, offset)
      }),
    )
    try {
      const buffer = await window.api.terminals.attach(terminalId)
      if (disposed) return
      const replay = filterOutput(buffer.data)
      if (buffer.answered && replay) {
        replaying = true
        // Called once xterm has parsed it, before the output that came in meanwhile.
        t.write(replay, () => (replaying = false))
      } else t.write(replay)
      end = buffer.end
    } catch {
      end = 0
    }
    for (const [data, offset] of queued.splice(0)) writeChunk(data, offset)

    resizeObserver = new ResizeObserver(() => fit())
    resizeObserver.observe(el)
    // Hidden tabs, groups and pages have no size: WebGL only while on screen (see `setShown`).
    visibilityObserver = new IntersectionObserver((entries) => setShown(entries.at(-1)?.isIntersecting ?? false))
    visibilityObserver.observe(el)
    ready.value = true
    fit()
    if (active.value) await nextTick(() => focus())
  })

  watch(active, (isActive) => {
    if (!isActive) {
      hideImage()
      return
    }
    // Before the tab comes on screen, so it doesn't show a frame of the DOM renderer.
    setShown(true)
    void nextTick(() => {
      fit()
      focus()
    })
  })

  watch(
    () => [settingsStore.settings.terminal, palette.value, slotTints.value] as const,
    async ([s, p, tints], [prev]) => {
      if (!term) return
      if (s.fontFamily !== prev.fontFamily || s.fontSize !== prev.fontSize) await ensureFontLoaded(s.fontFamily, s.fontSize)
      if (!term) return
      setSlotTints(tints)
      Object.assign(term.options, terminalOptions(s, p, tints))
      term.unicode.activeVersion = s.unicode === 'graphemes' ? '15-graphemes' : '11'
      if (s.renderer !== 'webgl') disableWebgl()
      else if (shown) {
        // Switched back on: another try after lost contexts.
        if (prev.renderer !== 'webgl') webglLosses = 0
        enableWebgl()
      }
      ligatures?.update()
      webgl?.addon.clearTextureAtlas()
      fit()
    },
  )

  onBeforeUnmount(() => {
    disposed = true
    stopAwaitingPaste?.()
    clearTimeout(previewLeaveTimer)
    cancelAnimationFrame(fitFrame)
    resizeObserver?.disconnect()
    visibilityObserver?.disconnect()
    for (const cleanup of cleanups.splice(0)) cleanup()
    disableWebgl()
    term?.dispose()
    term = null
  })

  return {
    ready,
    hasSelection,
    /** The pasted image under the mouse, shown next to it. */
    imagePreview,
    /** The pasted image opened in full size by a click on its `[Image #N]`. */
    openedImage,
    closeImage: () => (openedImage.value = null),
    focus,
    fit,
    copySelection,
    pasteClipboard,
    /** Pastes like Ctrl+V, e.g. the paths of dropped files. */
    paste: (text: string) => {
      term?.paste(text)
      focus()
    },
    clear: () => term?.clear(),
    selectAll: () => term?.selectAll(),
    scrollToBottom: () => term?.scrollToBottom(),
    findNext: (query: string) => searchAddon?.findNext(query, { incremental: true }) ?? false,
    findPrevious: (query: string) => searchAddon?.findPrevious(query) ?? false,
    clearSearch: () => searchAddon?.clearDecorations(),
  }
}
