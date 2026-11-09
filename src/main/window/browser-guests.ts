import {
  clipboard,
  Menu,
  session,
  shell,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { BLANK_PAGE, BROWSER_PARTITION, isBrowsableUrl } from '@shared/browser'
import { IpcEvent } from '@shared/ipc'
import { matchBrowserShortcut, matchShortcut, type Shortcut } from '@shared/shortcuts'
import { browserDownloads } from './browser-downloads'
import { browserLogins } from './browser-logins'
import { browserPermissions } from './browser-permissions'
import {
  ALLOWED_PERMISSIONS,
  browserUserAgent,
  faviconType,
  hardenWebview,
  MAX_FAVICON_BYTES,
  popupTitle,
  toShortcutKey,
} from './browser-policy'
import { resourceIcon } from './tray'

/**
 * The pages of the browser tabs: `<webview>`s of the window, in a profile of their own (see
 * browser-policy.ts for what they may do).
 */

let sessionReady = false

/**
 * The browser profile: a plain Chrome to the sites, no permissions beyond the clipboard; unless
 * Claude gives a page more for a while (browser_emulate).
 */
function setupBrowserSession(): void {
  if (sessionReady) return
  sessionReady = true
  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()))
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    callback(browserPermissions.decide(contents, permission, mediaTypes) ?? ALLOWED_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const mediaTypes = details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : []
    return browserPermissions.decide(contents, permission, mediaTypes) ?? ALLOWED_PERMISSIONS.has(permission)
  })
  // Files go to the downloads folder right away; Electron would ask where, in a window of its own.
  ses.on('will-download', (_event, item, contents) => browserDownloads.add(item, contents))
}

/** Lets the window hold browser pages, and only as browser-policy.ts allows them. */
export function guardBrowserGuests(win: BrowserWindow): void {
  setupBrowserSession()
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!hardenWebview(webPreferences, params)) event.preventDefault()
  })
  win.webContents.on('did-attach-webview', (_event, guest) => attachGuest(win, guest))
  // The back and forward buttons of the mouse (and of keyboards that have them) reach the window as
  // app commands, also over a page; the window passes them to the browser with the keyboard.
  win.on('app-command', (_event, command) => {
    const shortcut: Shortcut | null =
      command === 'browser-backward' ? { action: 'browser-back' } : command === 'browser-forward' ? { action: 'browser-forward' } : null
    if (shortcut && !win.isDestroyed()) win.webContents.send(IpcEvent.browserShortcut, shortcut)
  })
}

/**
 * Logs the browser out everywhere: cookies, what the sites stored (local storage, IndexedDB,
 * service workers …), the cache and remembered HTTP logins of its profile. Open pages keep what
 * they hold in memory until they load again.
 */
export async function clearBrowserData(): Promise<void> {
  const ses = session.fromPartition(BROWSER_PARTITION)
  await ses.clearStorageData()
  await ses.clearCache()
  await ses.clearAuthCache()
  favicons.clear()
  browserDownloads.clear()
}

/** Icons by their address, as data URLs; pages of a site share theirs. Failures aren't kept. */
const favicons = new Map<string, Promise<string | null>>()
const MAX_FAVICONS = 50

/**
 * The icon a page names (`page-favicon-updated`) as a data URL for the tabs, which may load no
 * images from the web. Fetched like the page, through the browser's profile; null when it is none.
 */
export function loadFavicon(url: string): Promise<string | null> {
  let icon = favicons.get(url)
  if (!icon) {
    icon = fetchFavicon(url)
    if (favicons.size >= MAX_FAVICONS) favicons.delete(favicons.keys().next().value!)
    favicons.set(url, icon)
    void icon.then((found) => found || favicons.delete(url))
  }
  return icon
}

async function fetchFavicon(url: string): Promise<string | null> {
  const remote = url !== BLANK_PAGE && isBrowsableUrl(url)
  // Pages may also carry their icon inline.
  if (!remote && !/^data:image\//i.test(url)) return null
  try {
    const response = remote
      ? await session.fromPartition(BROWSER_PARTITION).fetch(url, { signal: AbortSignal.timeout(10_000) })
      : await fetch(url)
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_FAVICON_BYTES) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    const type = bytes.byteLength <= MAX_FAVICON_BYTES ? faviconType(bytes) : null
    return type && `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return null
  }
}

const ZOOM_STEP = 0.5

/**
 * A link of `guest` wants a tab of its own; the window opens it beside the page's tab, or keeps it in
 * the page's view while Claude drives it (BrowserPane).
 */
function openTab(win: BrowserWindow, guest: WebContents, url: string, background: boolean): void {
  if (!win.isDestroyed() && !guest.isDestroyed()) win.webContents.send(IpcEvent.browserOpenTab, guest.id, url, background)
}

function attachGuest(win: BrowserWindow, guest: WebContents): void {
  // Popups (window.open with a size, e.g. "Sign in with Google") become small windows of their own
  // that keep their opener, so they can report back to the page and close. Links that want a new
  // tab (`target=_blank`, the middle mouse button, Ctrl+click) get one, the others open in the view.
  guest.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'new-window' && isBrowsableUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: popupOptions(win) }
    }
    if (url === BLANK_PAGE || !isBrowsableUrl(url)) return { action: 'deny' }
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      openTab(win, guest, url, disposition === 'background-tab')
    } else {
      void guest.loadURL(url)
    }
    return { action: 'deny' }
  })
  guest.on('did-create-window', (popup) => guardPopup(popup))
  guardNavigation(guest)
  // A site that wants a user name and password asks in the page's pane (BrowserPane) instead of failing.
  guest.on('login', (event, details, info, callback) => {
    event.preventDefault()
    browserLogins.ask(guest, details, info, callback)
  })

  // The window doesn't see the keys of a page: the app's shortcuts go to it from here.
  guest.on('before-input-event', (event, input) => {
    const key = toShortcutKey(input)
    const shortcut = matchShortcut(key) ?? matchBrowserShortcut(key)
    if (!shortcut) return
    event.preventDefault()
    // In a page the zoom keys zoom the page, not the terminals' font.
    if (shortcut.action === 'zoom-in' || shortcut.action === 'zoom-out' || shortcut.action === 'zoom-reset') {
      const level = guest.getZoomLevel()
      guest.setZoomLevel(shortcut.action === 'zoom-reset' ? 0 : level + (shortcut.action === 'zoom-in' ? ZOOM_STEP : -ZOOM_STEP))
      return
    }
    if (!win.isDestroyed()) win.webContents.send(IpcEvent.browserShortcut, shortcut)
  })

  guest.on('context-menu', (_event, params) => {
    if (win.isDestroyed()) return
    const newTab = (url: string) => openTab(win, guest, url, true)
    Menu.buildFromTemplate(contextMenu(guest, params, newTab)).popup({ window: win })
  })
}

/** Pages go to http(s) addresses only, also by redirects. */
function guardNavigation(contents: WebContents): void {
  const guard = (event: { preventDefault: () => void }, url: string) => {
    if (!isBrowsableUrl(url)) event.preventDefault()
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
}

const POPUP_MIN_SIZE = 200

/**
 * The window of a page's popup: above the app (it belongs to it), a plain window with the page's
 * title and host, and no more rights than the page that opened it.
 */
function popupOptions(win: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent: win,
    minWidth: POPUP_MIN_SIZE,
    minHeight: POPUP_MIN_SIZE,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: 'Claude Manager',
    ...(process.platform === 'linux' ? { icon: resourceIcon('icon.png') } : {}),
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      partition: BROWSER_PARTITION,
    },
  }
}

/**
 * A popup may do what its page may do. It has no address bar, so its title names the host; Ctrl+W
 * closes it, and links in it stay in it. A login it needs is refused, as it has no pane to ask in.
 */
function guardPopup(popup: BrowserWindow): void {
  popup.setMenu(null)
  const contents = popup.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (url !== BLANK_PAGE && isBrowsableUrl(url)) void contents.loadURL(url)
    return { action: 'deny' }
  })
  guardNavigation(contents)
  const showTitle = () => {
    if (!popup.isDestroyed()) popup.setTitle(popupTitle(contents.getTitle(), contents.getURL()))
  }
  contents.on('page-title-updated', (event) => {
    event.preventDefault()
    showTitle()
  })
  contents.on('did-navigate', showTitle)
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || input.meta) return
    const key = input.key.toLowerCase()
    if (input.control && !input.shift && key === 'w') {
      event.preventDefault()
      popup.close()
    } else if (key === 'f5' || (input.control && !input.shift && key === 'r')) {
      event.preventDefault()
      contents.reload()
    }
  })
  contents.on('context-menu', (_event, params) => {
    if (!popup.isDestroyed()) Menu.buildFromTemplate(contextMenu(contents, params)).popup({ window: popup })
  })
}

/** `newTab`: opens a link in a tab of its own; a popup has none. */
function contextMenu(guest: WebContents, params: ContextMenuParams, newTab?: (url: string) => void): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  if (params.linkURL && isBrowsableUrl(params.linkURL)) {
    if (newTab) items.push({ label: 'Link in neuem Tab öffnen', click: () => newTab(params.linkURL) })
    items.push(
      { label: 'Link öffnen', click: () => void guest.loadURL(params.linkURL) },
      { label: 'Link im Standardbrowser öffnen', click: () => void shell.openExternal(params.linkURL) },
      { label: 'Link-Adresse kopieren', click: () => clipboard.writeText(params.linkURL) },
      separator,
    )
  }
  if (params.isEditable) {
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags
    items.push(
      { label: 'Ausschneiden', enabled: canCut, click: () => guest.cut() },
      { label: 'Kopieren', enabled: canCopy, click: () => guest.copy() },
      { label: 'Einfügen', enabled: canPaste, click: () => guest.paste() },
      { label: 'Alles auswählen', enabled: canSelectAll, click: () => guest.selectAll() },
      separator,
    )
  } else if (params.selectionText.trim()) {
    items.push({ label: 'Kopieren', click: () => guest.copy() }, separator)
  }
  const history = guest.navigationHistory
  items.push(
    { label: 'Zurück', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Vor', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: 'Neu laden', click: () => guest.reload() },
    { label: 'Neu laden ohne Cache', click: () => guest.reloadIgnoringCache() },
    separator,
    { label: 'Untersuchen', click: () => guest.inspectElement(params.x, params.y) },
  )
  return items
}
