import {
  clipboard,
  Menu,
  session,
  shell,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { BLANK_PAGE, BROWSER_PARTITION, isBrowsableUrl } from '@shared/browser'
import { IpcEvent } from '@shared/ipc'
import { matchBrowserShortcut, matchShortcut } from '@shared/shortcuts'
import { ALLOWED_PERMISSIONS, browserUserAgent, faviconType, hardenWebview, MAX_FAVICON_BYTES, toShortcutKey } from './browser-policy'

/**
 * The pages of the browser tabs: `<webview>`s of the window, in a profile of their own (see
 * browser-policy.ts for what they may do).
 */

let sessionReady = false

/** The browser profile: a plain Chrome to the sites, no permissions beyond the clipboard. */
function setupBrowserSession(): void {
  if (sessionReady) return
  sessionReady = true
  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()))
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
}

/** Lets the window hold browser pages, and only as browser-policy.ts allows them. */
export function guardBrowserGuests(win: BrowserWindow): void {
  setupBrowserSession()
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!hardenWebview(webPreferences, params)) event.preventDefault()
  })
  win.webContents.on('did-attach-webview', (_event, guest) => attachGuest(win, guest))
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

function attachGuest(win: BrowserWindow, guest: WebContents): void {
  // Links that want a new window open in the same view: popups would be windows of the app.
  guest.setWindowOpenHandler(({ url }) => {
    if (url !== BLANK_PAGE && isBrowsableUrl(url)) void guest.loadURL(url)
    return { action: 'deny' }
  })
  const guard = (event: { preventDefault: () => void }, url: string) => {
    if (!isBrowsableUrl(url)) event.preventDefault()
  }
  guest.on('will-navigate', guard)
  guest.on('will-redirect', guard)

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
    Menu.buildFromTemplate(contextMenu(guest, params)).popup({ window: win })
  })
}

function contextMenu(guest: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  if (params.linkURL && isBrowsableUrl(params.linkURL)) {
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
    separator,
    { label: 'Untersuchen', click: () => guest.inspectElement(params.x, params.y) },
  )
  return items
}
