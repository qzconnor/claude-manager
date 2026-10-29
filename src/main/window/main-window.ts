import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import type { AppSettings, WindowState } from '@shared/types'
import { readJsonSync, writeJsonAtomic } from '../lib/json-file'

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

export function windowState(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), focused: win.isFocused(), fullscreen: win.isFullScreen() }
}

/** Brings the window to the front, also out of the minimized state. */
export function revealWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function createMainWindow(settings: AppSettings, userDataDir: string): BrowserWindow {
  const boundsFile = join(userDataDir, 'window-state.json')
  const saved = restoreBounds(boundsFile)
  const isWin = process.platform === 'win32'

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
    titleBarOverlay: isWin ? { color: '#00000000', symbolColor: '#e8e6e3', height: TITLE_BAR_HEIGHT } : false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win.setMenu(null)
  if (saved.maximized) win.maximize()

  win.once('ready-to-show', () => win.show())

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
