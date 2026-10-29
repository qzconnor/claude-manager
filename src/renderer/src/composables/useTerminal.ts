import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme, type ITerminalOptions } from '@xterm/xterm'
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { TerminalSettings } from '@shared/types'
import { matchShortcut } from '@/lib/shortcuts'
import { terminalBus } from '@/lib/terminal-bus'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import type { TerminalPalette } from '@/themes/types'
import { buildFontStack, ensureFontLoaded, useTerminalAppearance } from './useTerminalAppearance'

export interface UseTerminalOptions {
  terminalId: string
  /** Runs Claude Code, which can take images from the clipboard. */
  claudeSession: boolean
  container: Ref<HTMLElement | null>
  /** The tab is visible — fit and focus when this turns true. */
  active: Ref<boolean>
}

export function toXtermTheme(p: TerminalPalette): ITheme {
  return {
    ...p,
    // The container paints the background so the window material can shine through.
    background: '#00000000',
    scrollbarSliderBackground: 'rgba(128, 128, 128, 0.25)',
    scrollbarSliderHoverBackground: 'rgba(128, 128, 128, 0.4)',
    scrollbarSliderActiveBackground: 'rgba(128, 128, 128, 0.55)',
  }
}

export function terminalOptions(s: TerminalSettings, palette: TerminalPalette): ITerminalOptions {
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
    theme: toXtermTheme(palette),
  }
}

export function useTerminal(options: UseTerminalOptions) {
  const { terminalId, claudeSession, container, active } = options
  const settingsStore = useSettingsStore()
  const appStore = useAppStore()
  const { palette } = useTerminalAppearance()

  const ready = ref(false)
  const hasSelection = ref(false)
  let term: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let searchAddon: SearchAddon | null = null
  let webgl: WebglAddon | null = null
  let resizeObserver: ResizeObserver | null = null
  let fitFrame = 0
  let disposed = false
  const cleanups: (() => void)[] = []

  function write(data: string): void {
    window.api.terminals.write(terminalId, data)
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
      write(appStore.info?.platform === 'win32' ? '\x1bv' : '\x16')
    }
  }

  function enableWebgl(): void {
    if (!term || webgl) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // GPU reset or too many contexts — fall back to the DOM renderer.
        addon.dispose()
        if (webgl === addon) webgl = null
      })
      term.loadAddon(addon)
      webgl = addon
    } catch (error) {
      console.warn('[terminal] WebGL unavailable, using DOM renderer', error)
      webgl = null
    }
  }

  function disableWebgl(): void {
    webgl?.dispose()
    webgl = null
  }

  function fit(): void {
    cancelAnimationFrame(fitFrame)
    fitFrame = requestAnimationFrame(() => {
      const el = container.value
      if (!term || !fitAddon || !el || el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fitAddon.fit()
      } catch {
        // renderer not ready yet
      }
    })
  }

  function focus(): void {
    term?.focus()
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true
    // App shortcuts bubble up to the window listener instead of reaching the shell.
    if (matchShortcut(e)) return false
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
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Claude Code inserts a newline on Ctrl+J (line feed) in every terminal.
      e.preventDefault()
      write('\n')
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

    const build = appStore.info?.windowsBuild ?? null
    term = new Terminal({
      ...terminalOptions(s, palette.value),
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
    fitAddon = new FitAddon()
    searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        void window.api.app.openExternal(uri)
      }),
    )
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = s.unicode === 'graphemes' ? '15-graphemes' : '11'

    term.open(el)
    if (s.renderer === 'webgl') enableWebgl()
    term.attachCustomKeyEventHandler(handleKey)

    const t = term
    const subscriptions = [
      t.onData((data) => write(data)),
      t.onBinary((data) => write(data)),
      t.onResize(({ cols, rows }) => window.api.terminals.resize(terminalId, cols, rows)),
      t.onSelectionChange(() => {
        hasSelection.value = t.hasSelection()
        if (settingsStore.settings.terminal.copyOnSelect && t.hasSelection()) {
          void navigator.clipboard.writeText(t.getSelection())
        }
      }),
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
      t.write(offset < end ? data.slice(end - offset) : data)
      end = offset + data.length
    }
    cleanups.push(
      terminalBus.onData(terminalId, (data, offset) => {
        if (end < 0) queued.push([data, offset])
        else writeChunk(data, offset)
      }),
    )
    try {
      const buffer = await window.api.terminals.buffer(terminalId)
      if (disposed) return
      t.write(buffer.data)
      end = buffer.end
    } catch {
      end = 0
    }
    for (const [data, offset] of queued.splice(0)) writeChunk(data, offset)

    resizeObserver = new ResizeObserver(() => fit())
    resizeObserver.observe(el)
    ready.value = true
    fit()
    if (active.value) await nextTick(() => focus())
  })

  watch(active, (isActive) => {
    if (!isActive) return
    void nextTick(() => {
      fit()
      focus()
    })
  })

  watch(
    () => [settingsStore.settings.terminal, palette.value] as const,
    async ([s, p], [prev]) => {
      if (!term) return
      if (s.fontFamily !== prev.fontFamily || s.fontSize !== prev.fontSize) await ensureFontLoaded(s.fontFamily, s.fontSize)
      if (!term) return
      Object.assign(term.options, terminalOptions(s, p))
      term.unicode.activeVersion = s.unicode === 'graphemes' ? '15-graphemes' : '11'
      if (s.renderer === 'webgl') enableWebgl()
      else disableWebgl()
      webgl?.clearTextureAtlas()
      fit()
    },
  )

  onBeforeUnmount(() => {
    disposed = true
    cancelAnimationFrame(fitFrame)
    resizeObserver?.disconnect()
    for (const cleanup of cleanups.splice(0)) cleanup()
    disableWebgl()
    term?.dispose()
    term = null
  })

  return {
    ready,
    hasSelection,
    focus,
    fit,
    copySelection,
    pasteClipboard,
    clear: () => term?.clear(),
    selectAll: () => term?.selectAll(),
    scrollToBottom: () => term?.scrollToBottom(),
    findNext: (query: string) => searchAddon?.findNext(query, { incremental: true }) ?? false,
    findPrevious: (query: string) => searchAddon?.findPrevious(query) ?? false,
    clearSearch: () => searchAddon?.clearDecorations(),
  }
}
