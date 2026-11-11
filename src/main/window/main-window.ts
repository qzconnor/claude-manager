import { join } from 'node:path'
import { BrowserWindow, screen, session, shell, type WebContents, type WebFrameMain } from 'electron'
import type { AppSettings, WindowState } from '@shared/types'
import { readJsonSync, writeJsonAtomic } from '../lib/json-file'
import { guardBrowserGuests } from './browser-guests'
import { forceForeground } from './foreground'
import { resourceIcon } from './tray'

export const TITLE_BAR_HEIGHT = 40

interface SavedBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

function restoreBounds(file: string): Partial<SavedBounds> {
  const saved = readJsonSync<SavedBounds>(file)
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return {}
  // Only reuse the position if it is still on a connected display.
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 60
  })
  return visible ? saved : { width: saved.width, height: saved.height, maximized: saved.maximized }
}

/** The app's own windows. Popups of browser pages are windows too, but must get nothing of the app. */
const appWindows = new WeakSet<BrowserWindow>()

/** What the app's own pages may use: the clipboard (copying, and pasting into the terminal). */
const APP_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])
let appSessionGuarded = false

/** The app's pages get no permission beyond the clipboard; Electron would grant them all. */
function guardAppSession(): void {
  if (appSessionGuarded) return
  appSessionGuarded = true
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(APP_PERMISSIONS.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => APP_PERMISSIONS.has(permission))
}

/**
 * Whether a message to the main process comes from the page of one of the app's windows: not from a
 * browser tab (webview), the popup of a page or a frame inside a page. Those have no preload, but a
 * page whose renderer was taken over could send the app's messages anyway.
 */
export function fromAppWindow(event: { sender: WebContents; senderFrame: WebFrameMain | null }): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent) return false
  const win = BrowserWindow.fromWebContents(event.sender)
  return !!win && appWindows.has(win) && win.webContents === event.sender
}

/** The app's windows that are open, without the popups of browser pages. */
export function openAppWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((win) => appWindows.has(win) && !win.isDestroyed())
}

export function windowState(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), focused: win.isFocused(), fullscreen: win.isFullScreen() }
}

/**
 * Brings the window to the front, also out of the minimized state. `steal`: also when another app
 * is in front, for a question the user has to see (Windows would only flash the taskbar button).
 */
export function revealWindow(win: BrowserWindow, { steal = false } = {}): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (steal) void forceForeground(win)
}

/** `hidden`: the window only appears with `revealWindow` (start at login into the tray). */
export function createMainWindow(settings: AppSettings, userDataDir: string, { hidden = false } = {}): BrowserWindow {
  const boundsFile = join(userDataDir, 'window-state.json')
  const saved = restoreBounds(boundsFile)
  const isWin = process.platform === 'win32'
  // The caption buttons: Windows draws its own, on Linux Chromium draws them in the same place.
  const captionButtons = isWin || process.platform === 'linux'

  const win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width ?? 1320,
    height: saved.height ?? 840,
    minWidth: 860,
    minHeight: 540,
    show: false,
    title: 'Claude Manager',
    backgroundColor: isWin && settings.appearance.material !== 'none' ? '#00000000' : '#141416',
    ...(isWin ? { backgroundMaterial: settings.appearance.material } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: captionButtons ? { color: '#00000000', symbolColor: '#e8e6e3', height: TITLE_BAR_HEIGHT } : false,
    // Windows takes the icon from the executable; X11 window managers need it from the window.
    ...(process.platform === 'linux' ? { icon: resourceIcon('icon.png') } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The browser tabs; every view is hardened before it starts (browser-guests.ts).
      webviewTag: true,
    },
  })
  appWindows.add(win)
  guardAppSession()
  guardBrowserGuests(win)
  win.setMenu(null)
  if (saved.maximized) {
    // Maximizing also shows the window, so a hidden one does it when it appears.
    if (hidden) win.once('show', () => win.maximize())
    else win.maximize()
  }

  if (!hidden) win.once('ready-to-show', () => win.show())

  // Never open new Electron windows; http(s) links go to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  let saveTimer: NodeJS.Timeout | null = null
  const saveBounds = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const b = win.getNormalBounds()
      void writeJsonAtomic(boundsFile, { ...b, maximized: win.isMaximized() } satisfies SavedBounds).catch(() => undefined)
    }, 500)
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('maximize', saveBounds)
  win.on('unmaximize', saveBounds)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
