import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { inFolder } from '@shared/folders'
import { IpcEvent, IpcInvoke, IpcSend } from '@shared/ipc'
import { parsePaneNode } from '@shared/panes'
import { parseThemeFile } from '@shared/themes/file'
import type { ThemeContent } from '@shared/themes/types'
import type {
  AccountCreateInput,
  AccountUpdateInput,
  AutoSwitchEvent,
  AppSettings,
  BrowserCredentials,
  BrowserDownloadAction,
  BrowserOpenOptions,
  CswapImportInput,
  DeepPartial,
  FileTreeWatch,
  FolderMovedEvent,
  FolderMoveResult,
  TerminalCreateOptions,
} from '@shared/types'
import type { ApiServer } from './api/api-server'
import { claudeInChromeStatus } from './browser/claude-in-chrome'
import type { AppContext } from './context'
import { listFontFamilies } from './lib/fonts'
import type { KeptImage } from './lib/kept-images'
import { SESSION_ID_RE } from './lib/session-files'
import { isTreePath } from './services/file-tree-service'
import { browserDownloads } from './window/browser-downloads'
import { clearBrowserData, loadFavicon } from './window/browser-guests'
import { browserLogins } from './window/browser-logins'
import { fromAppWindow, openAppWindows, windowState } from './window/main-window'

/** Sessions moved to the recycle bin in one go. */
const MAX_REMOVE = 10_000
/** A page's icon address; inline icons are data URLs of up to the largest icon (see browser-policy.ts). */
const MAX_FAVICON_URL_LENGTH = 400_000

const SETTINGS_FILE_FILTERS = [{ name: 'Claude-Manager-Einstellungen', extensions: ['json'] }]
const THEME_FILE_FILTERS = [{ name: 'Claude-Manager-Theme', extensions: ['json'] }]
/** Theme files taken over in one go. */
const MAX_THEME_IMPORT = 100

/** To the app's windows only: a popup of a browser page is a window too, and a page of the web. */
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of openAppWindows()) win.webContents.send(channel, ...args)
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('Kein Fenster gefunden.')
  return win
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Ungültiger Parameter: ${name}`)
  return value
}

/** The number of a pasted image (`[Image #N]`). */
function requireImageNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Ungültiger Parameter: n')
  return value
}

/** Image types of the clipboard a pasted image is kept in, in the order they are preferred. */
const CLIPBOARD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** A larger image isn't kept; Claude Code takes none of that size either. */
const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024

/** The image in the clipboard; null without one. */
async function clipboardImage(): Promise<KeptImage | null> {
  for (const item of await clipboard.read()) {
    const type = CLIPBOARD_IMAGE_TYPES.find((candidate) => item.types.includes(candidate))
    if (!type) continue
    const blob = await item.getType(type)
    if (!(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_CLIPBOARD_IMAGE_BYTES) return null
    return { mediaType: type, data: Buffer.from(await blob.arrayBuffer()) }
  }
  return null
}

/** The options of a new browser from the window, checked field by field. */
const DOWNLOAD_ACTIONS: ReadonlySet<string> = new Set<BrowserDownloadAction>(['open', 'show', 'cancel', 'remove'])
/** The most folders whose repositories are watched for checkouts at once; one per tab is far below. */
const MAX_WATCHED_FOLDERS = 500
/** The longest user name or password a page gets. */
const MAX_CREDENTIAL_LENGTH = 4096
/** The most file trees watched at once, and open folders per tree. */
const MAX_FILE_TREES = 64
const MAX_TREE_DIRS = 2000
/** A workspace prompt goes with every request of its sessions; this is far more than makes sense. */
const MAX_PROMPT_LENGTH = 100_000
/** More workspaces than anyone keeps; a longer list to reorder is no list of them. */
const MAX_WORKSPACES = 10_000
/** Folders the session list checks at once; more than any list shows. */
const MAX_CHECKED_FOLDERS = 20_000
/** Longer paths exist on no file system the app runs on. */
const MAX_PATH_LENGTH = 32_767

/** An absolute path from the window. */
function requirePath(value: unknown, name: string): string {
  const path = requireString(value, name)
  if (path.length > MAX_PATH_LENGTH || !isAbsolute(path) || path.includes('\0')) throw new Error(`Ungültiger Parameter: ${name}`)
  return path
}

/** A theme from the window, checked like a file: colors it lacks come from the built-in theme of its mode. */
function requireTheme(value: unknown): ThemeContent {
  if (typeof value !== 'object' || value === null) throw new Error('Ungültiger Parameter: theme')
  const { name, mode, colors, terminal } = value as Record<string, unknown>
  return parseThemeFile({ name, mode, colors, terminal }, 'Eigenes Theme')
}

/** The text of a workspace prompt; null for none (not a string). */
function promptOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length > MAX_PROMPT_LENGTH) throw new Error('Der Prompt ist zu lang.')
  return value
}

/** A folder of a tree relative to its root: `/`-separated, without `..` and empty parts. */
function isTreeDir(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PATH_LENGTH && isTreePath(value)
}

/** An entry of a tree, not its folder itself. */
function requireTreeEntry(value: unknown, name: string): string {
  if (!isTreeDir(value) || value === '') throw new Error(`Ungültiger Parameter: ${name}`)
  return value
}

function treesOf(value: unknown): FileTreeWatch[] {
  if (!Array.isArray(value) || value.length > MAX_FILE_TREES) throw new Error('Ungültiger Parameter: trees')
  return value.map((tree: { root?: unknown; dirs?: unknown } | null) => {
    const dirs = tree?.dirs
    if (!Array.isArray(dirs) || dirs.length > MAX_TREE_DIRS || !dirs.every(isTreeDir)) throw new Error('Ungültiger Parameter: dirs')
    return { root: requirePath(tree?.root, 'root'), dirs }
  })
}

function credentialsOf(value: unknown): BrowserCredentials | null {
  if (value === null || typeof value !== 'object') return null
  const { username, password } = value as Record<string, unknown>
  if (typeof username !== 'string' || typeof password !== 'string') throw new Error('Ungültiger Parameter: credentials')
  if (username.length > MAX_CREDENTIAL_LENGTH || password.length > MAX_CREDENTIAL_LENGTH) throw new Error('Ungültiger Parameter: credentials')
  return { username, password }
}

function browserOptions(value: unknown): BrowserOpenOptions {
  const { url, title, split } = (value ?? {}) as Record<string, unknown>
  const next: BrowserOpenOptions = {
    url: typeof url === 'string' ? url : null,
    title: typeof title === 'string' ? title : null,
  }
  if (split && typeof split === 'object') {
    const { terminalId, direction } = split as Record<string, unknown>
    next.split = { terminalId: requireString(terminalId, 'split.terminalId'), direction: direction === 'column' ? 'column' : 'row' }
  }
  return next
}

/** `ipcMain.handle` for the app's own windows only (see `fromAppWindow`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromAppWindow(event)) throw new Error('Nachricht von außerhalb der App abgelehnt.')
    return listener(event, ...args)
  })
}

/** `ipcMain.on` for the app's own windows only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (fromAppWindow(event)) listener(event, ...args)
  })
}

export function registerIpc(ctx: AppContext): void {
  // --- app -----------------------------------------------------------------
  handle(IpcInvoke.appInfo, () => ctx.appInfo())
  handle(IpcInvoke.appOpenExternal, async (_e, url: unknown) => {
    const target = requireString(url, 'url')
    if (!/^https?:\/\//i.test(target)) throw new Error('Nur http(s)-Links können geöffnet werden.')
    await shell.openExternal(target)
  })
  handle(IpcInvoke.appOpenPath, async (_e, path: unknown) => {
    const target = requireString(path, 'path')
    if (!existsSync(target)) throw new Error(`„${target}“ existiert nicht.`)
    // openPath doesn't throw but answers with the reason, e.g. when Linux has no file manager for folders.
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return error
  })
  handle(IpcInvoke.appShowItem, (_e, path: unknown) => {
    const target = requirePath(path, 'path')
    if (!existsSync(target)) throw new Error(`„${target}“ existiert nicht.`)
    shell.showItemInFolder(target)
  })
  handle(IpcInvoke.appPickDirectory, async (event, defaultPath: unknown) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(IpcInvoke.appMissingFolders, async (_e, paths: unknown) => {
    if (!Array.isArray(paths) || paths.length > MAX_CHECKED_FOLDERS) throw new Error('Ungültiger Parameter: paths')
    const checked = paths.map((path) => requirePath(path, 'paths'))
    const there = await Promise.all(checked.map((path) => stat(path).then((s) => s.isDirectory(), () => false)))
    return checked.filter((_, i) => !there[i])
  })
  handle(IpcInvoke.appListFonts, () => listFontFamilies())
  handle(IpcInvoke.appClipboardHasImage, async () =>
    (await clipboard.read()).some((item) => item.types.some((type) => type.startsWith('image/'))),
  )

  // --- window --------------------------------------------------------------
  handle(IpcInvoke.windowMinimize, (event) => senderWindow(event).minimize())
  handle(IpcInvoke.windowToggleMaximize, (event) => {
    const win = senderWindow(event)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle(IpcInvoke.windowClose, (event) => senderWindow(event).close())
  handle(IpcInvoke.windowState, (event) => windowState(senderWindow(event)))
  handle(IpcInvoke.windowSetTitleBarColors, (event, colors: unknown) => {
    if (!colors || typeof colors !== 'object') return
    const { color, symbolColor, dark } = colors as { color?: unknown; symbolColor?: unknown; dark?: unknown }
    // The acrylic/mica tint follows the native theme.
    nativeTheme.themeSource = dark === false ? 'light' : 'dark'
    // The caption buttons of the title bar overlay exist on Windows and Linux (main-window.ts).
    if (process.platform === 'darwin' || typeof color !== 'string' || typeof symbolColor !== 'string') return
    senderWindow(event).setTitleBarOverlay({ color, symbolColor })
  })

  // --- settings ------------------------------------------------------------
  handle(IpcInvoke.settingsGet, () => ctx.settings.get())
  handle(IpcInvoke.settingsUpdate, (_e, patch: DeepPartial<AppSettings>) => ctx.settings.update(patch ?? {}))
  handle(IpcInvoke.settingsReset, (_e, section?: keyof AppSettings) => ctx.settings.reset(section))
  handle(IpcInvoke.settingsExport, async (event) => {
    const now = new Date()
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-')
    const { canceled, filePath } = await dialog.showSaveDialog(senderWindow(event), {
      title: 'Einstellungen exportieren',
      defaultPath: join(app.getPath('documents'), `claude-manager-einstellungen-${date}.json`),
      filters: SETTINGS_FILE_FILTERS,
    })
    if (canceled || !filePath) return null
    await ctx.settings.exportTo(filePath, app.getVersion())
    return filePath
  })
  handle(IpcInvoke.settingsImport, async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(senderWindow(event), {
      title: 'Einstellungen importieren',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: SETTINGS_FILE_FILTERS,
    })
    const file = filePaths[0]
    return canceled || !file ? null : ctx.settings.importFrom(file)
  })
  ctx.settings.on('changed', (settings) => broadcast(IpcEvent.settingsChanged, settings))

  // --- accounts ------------------------------------------------------------
  handle(IpcInvoke.accountsList, () => ctx.accounts.list())
  handle(IpcInvoke.accountsCreate, (_e, input: AccountCreateInput) => ctx.accounts.create(input))
  handle(IpcInvoke.accountsUpdate, (_e, id: unknown, patch: AccountUpdateInput) =>
    ctx.accounts.update(requireString(id, 'id'), patch ?? {}),
  )
  handle(IpcInvoke.accountsRemove, (_e, id: unknown, options: { deleteConfigDir?: unknown }) => {
    const accountId = requireString(id, 'id')
    if (ctx.terminals.runningCount(accountId) > 0) {
      throw new Error('Für dieses Konto laufen noch Terminals. Bitte zuerst schließen.')
    }
    return ctx.accounts.remove(accountId, { deleteConfigDir: options?.deleteConfigDir === true })
  })
  handle(IpcInvoke.accountsRefresh, () => ctx.accounts.refresh())
  ctx.accounts.on('changed', (accounts) => broadcast(IpcEvent.accountsChanged, accounts))

  // --- cswap import --------------------------------------------------------
  handle(IpcInvoke.cswapStatus, () => ctx.cswap.status())
  handle(IpcInvoke.cswapImport, (_e, input: CswapImportInput) => ctx.cswap.import(input))

  // --- terminals -----------------------------------------------------------
  handle(IpcInvoke.terminalsList, () => ctx.terminals.list())
  handle(IpcInvoke.terminalsLayouts, () => ctx.terminals.layouts())
  handle(IpcInvoke.terminalsArrange, (_e, layout: unknown) => {
    const parsed = parsePaneNode(layout)
    if (!parsed) throw new Error('Ungültiger Parameter: layout')
    ctx.terminals.arrange(parsed)
  })
  handle(IpcInvoke.terminalsCreate, (_e, options: TerminalCreateOptions) => ctx.terminals.open(options))
  handle(IpcInvoke.terminalsOpenBrowser, (_e, options: unknown) => ctx.terminals.openBrowser(browserOptions(options)))
  handle(IpcInvoke.terminalsKill, (_e, id: unknown) => ctx.terminals.kill(requireString(id, 'id')))
  handle(IpcInvoke.terminalsClose, (_e, id: unknown) => ctx.terminals.close(requireString(id, 'id')))
  handle(IpcInvoke.terminalsRename, (_e, id: unknown, title: unknown) => {
    // Empty is allowed: the tab follows the session's title again.
    if (typeof title !== 'string') throw new Error('Ungültiger Parameter: title')
    ctx.terminals.rename(requireString(id, 'id'), title)
  })
  handle(IpcInvoke.terminalsAttach, (_e, id: unknown) => ctx.terminals.attach(requireString(id, 'id')))
  handle(IpcInvoke.terminalsContinueWith, (_e, id: unknown, accountId: unknown) =>
    ctx.handoff.continueTerminal(requireString(id, 'id'), requireString(accountId, 'accountId')),
  )
  handle(IpcInvoke.terminalsRestartSession, (_e, id: unknown) => ctx.handoff.restartTerminal(requireString(id, 'id')))
  handle(IpcInvoke.terminalsMoveSession, (_e, id: unknown, to: unknown) =>
    ctx.handoff.moveTerminal(requireString(id, 'id'), requirePath(to, 'to')),
  )
  handle(IpcInvoke.terminalsSetMuted, (_e, id: unknown, muted: unknown) => {
    if (typeof muted !== 'boolean') throw new Error('Ungültiger Parameter: muted')
    ctx.terminals.setMuted(requireString(id, 'id'), muted)
  })
  handle(IpcInvoke.terminalsPastedImageIds, (_e, id: unknown) => ctx.terminals.pastedImageIds(requireString(id, 'id')))
  handle(IpcInvoke.terminalsPastedImage, (_e, id: unknown, n: unknown) =>
    ctx.terminals.pastedImage(requireString(id, 'id'), requireImageNumber(n)),
  )
  handle(IpcInvoke.terminalsKeepPastedImage, async (_e, id: unknown, n: unknown) => {
    const terminalId = requireString(id, 'id')
    const number = requireImageNumber(n)
    const image = await clipboardImage()
    return image !== null && ctx.terminals.keepPastedImage(terminalId, number, image)
  })
  on(IpcSend.terminalViewing, (_e, ids: unknown) => {
    ctx.notifications.setViewing(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!id) : [])
  })
  on(IpcSend.terminalColorScheme, (_e, dark: unknown) => {
    if (typeof dark === 'boolean') ctx.terminals.setColorScheme(dark)
  })
  handle(IpcInvoke.browserFavicon, (_e, url: unknown) =>
    typeof url === 'string' && url.length <= MAX_FAVICON_URL_LENGTH ? loadFavicon(url) : null,
  )
  on(IpcSend.browserAttach, (event, id: unknown, contentsId: unknown) => {
    if (typeof id === 'string' && typeof contentsId === 'number') ctx.browser.attach(id, contentsId, event.sender)
  })
  handle(IpcInvoke.browserLog, (_e, id: unknown) => ctx.browser.log(requireString(id, 'id')))
  handle(IpcInvoke.browserClearLog, (_e, id: unknown) => ctx.browser.clearLog(requireString(id, 'id')))
  handle(IpcInvoke.browserTakeOver, (_e, id: unknown, takenOver: unknown) =>
    ctx.browser.takeOver(requireString(id, 'id'), takenOver === true),
  )
  handle(IpcInvoke.browserControls, () => ctx.browser.controls())
  handle(IpcInvoke.browserClearData, () => clearBrowserData())
  handle(IpcInvoke.browserResetViewport, (_e, id: unknown) => ctx.browser.resetViewport(requireString(id, 'id')))
  handle(IpcInvoke.browserResetEmulation, (_e, id: unknown) => ctx.browser.resetEmulation(requireString(id, 'id')))
  handle(IpcInvoke.browserResetRoutes, (_e, id: unknown) => ctx.browser.resetRoutes(requireString(id, 'id')))
  handle(IpcInvoke.browserClaudeInChrome, () => claudeInChromeStatus(ctx.accounts))
  handle(IpcInvoke.browserDownloads, () => browserDownloads.list())
  handle(IpcInvoke.browserDownloadAction, (_e, id: unknown, action: unknown) => {
    if (typeof action !== 'string' || !DOWNLOAD_ACTIONS.has(action)) throw new Error('Ungültiger Parameter: action')
    return browserDownloads.act(requireString(id, 'id'), action as BrowserDownloadAction)
  })
  handle(IpcInvoke.browserClearDownloads, () => browserDownloads.clear())
  handle(IpcInvoke.browserLoginAnswer, (_e, id: unknown, credentials: unknown) =>
    browserLogins.answer(requireString(id, 'id'), credentialsOf(credentials)),
  )
  browserDownloads.on('changed', (downloads) => broadcast(IpcEvent.browserDownloads, downloads))
  browserLogins.on('request', (request) => broadcast(IpcEvent.browserLogin, request))
  browserLogins.on('done', (id) => broadcast(IpcEvent.browserLoginDone, id))
  ctx.browser.on('activity', (id, activity) => broadcast(IpcEvent.browserActivity, id, activity))
  ctx.browser.on('control', (id, control) => broadcast(IpcEvent.browserControl, id, control))
  ctx.browser.on('highlight', (id, highlight) => broadcast(IpcEvent.browserHighlight, id, highlight))
  ctx.browser.on('focus', (id) => broadcast(IpcEvent.browserFocus, id))
  ctx.browser.on('userClick', (id) => broadcast(IpcEvent.browserUserClick, id))
  on(IpcSend.browserPage, (_e, id: unknown, page: unknown) => {
    const { url, title } = (page ?? {}) as Record<string, unknown>
    if (typeof id === 'string' && typeof url === 'string' && typeof title === 'string') {
      ctx.terminals.setBrowserPage(id, { url, title })
    }
  })
  on(IpcSend.terminalReorder, (_e, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) ctx.terminals.reorder(ids)
  })
  on(IpcSend.terminalWrite, (_e, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') ctx.terminals.write(id, data)
  })
  on(IpcSend.terminalResize, (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id === 'string' && typeof cols === 'number' && typeof rows === 'number') ctx.terminals.resize(id, cols, rows)
  })
  ctx.terminals.on('changed', (terminals) => broadcast(IpcEvent.terminalsChanged, terminals, ctx.terminals.layouts()))
  ctx.handoff.on('replaced', (oldId, info) => broadcast(IpcEvent.terminalReplaced, oldId, info))
  ctx.autoSwitch.on('switched', (from, to, target) =>
    broadcast(IpcEvent.terminalAutoSwitch, { from, to, targetId: target.id, error: null } satisfies AutoSwitchEvent),
  )
  ctx.autoSwitch.on('failed', (from, target, error) =>
    broadcast(IpcEvent.terminalAutoSwitch, { from, to: null, targetId: target.id, error } satisfies AutoSwitchEvent),
  )
  ctx.terminals.on('data', (id, data, offset) => broadcast(IpcEvent.terminalData, id, data, offset))
  ctx.terminals.on('exit', (id, code) => {
    broadcast(IpcEvent.terminalExit, id, code)
    // A login terminal finishing usually means new credentials.
    ctx.accounts.refresh()
  })

  // --- notifications -------------------------------------------------------
  handle(IpcInvoke.notificationsTest, () => ctx.notifications.showTest())

  // --- sessions ------------------------------------------------------------
  handle(IpcInvoke.sessionsList, (_e, accountId?: unknown) =>
    ctx.sessions.list(typeof accountId === 'string' ? accountId : undefined),
  )
  handle(IpcInvoke.sessionsGet, (_e, accountId: unknown, sessionId: unknown, limit: unknown) =>
    ctx.sessions.get(
      requireString(accountId, 'accountId'),
      requireString(sessionId, 'sessionId'),
      typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined,
    ),
  )
  handle(IpcInvoke.sessionsToolCall, (_e, accountId: unknown, sessionId: unknown, toolUseId: unknown) =>
    ctx.sessions.toolCall(
      requireString(accountId, 'accountId'),
      requireString(sessionId, 'sessionId'),
      requireString(toolUseId, 'toolUseId'),
    ),
  )
  handle(IpcInvoke.sessionsSearch, (_e, query: unknown) =>
    ctx.sessions.search(typeof query === 'string' ? query.slice(0, 200) : ''),
  )
  handle(IpcInvoke.sessionsContinueWith, (_e, accountId: unknown, sessionId: unknown, targetAccountId: unknown) =>
    ctx.handoff.resumeSession(
      requireString(accountId, 'accountId'),
      requireString(sessionId, 'sessionId'),
      requireString(targetAccountId, 'targetAccountId'),
    ),
  )
  handle(IpcInvoke.sessionsRemove, (_e, sessions: unknown) => {
    if (!Array.isArray(sessions) || sessions.length > MAX_REMOVE) throw new Error('Ungültiger Parameter: sessions')
    const refs = sessions.map((s: { accountId?: unknown; sessionId?: unknown } | null) => {
      const sessionId = requireString(s?.sessionId, 'sessionId')
      if (!SESSION_ID_RE.test(sessionId)) throw new Error('Ungültige Session-ID.')
      return { accountId: ctx.accounts.get(requireString(s?.accountId, 'accountId')).id, sessionId }
    })
    return ctx.sessions.remove(refs)
  })
  handle(IpcInvoke.sessionsRename, (_e, sessionId: unknown, name: unknown) => {
    // Empty is allowed: the session shows Claude Code's title again.
    if (typeof name !== 'string') throw new Error('Ungültiger Parameter: name')
    const id = requireString(sessionId, 'sessionId')
    if (!SESSION_ID_RE.test(id)) throw new Error('Ungültige Session-ID.')
    ctx.sessions.rename(id, name)
  })
  handle(IpcInvoke.sessionsMove, (_e, accountId: unknown, sessionId: unknown, to: unknown) => {
    const id = requireString(sessionId, 'sessionId')
    if (!SESSION_ID_RE.test(id)) throw new Error('Ungültige Session-ID.')
    return ctx.sessions.move(ctx.accounts.get(requireString(accountId, 'accountId')).id, id, requirePath(to, 'to'))
  })
  ctx.sessions.on('changed', (accountId) => broadcast(IpcEvent.sessionsChanged, accountId))

  // --- workspaces ----------------------------------------------------------
  handle(IpcInvoke.workspacesList, () => ctx.workspaces.list())
  handle(IpcInvoke.workspacesCreate, (_e, input: unknown) => {
    const { parent, name, prompt } = (input ?? {}) as Record<string, unknown>
    return ctx.workspaces.create({ parent: requirePath(parent, 'parent'), name: requireString(name, 'name'), prompt: promptOf(prompt) ?? '' })
  })
  handle(IpcInvoke.workspacesAdopt, (_e, path: unknown, prompt: unknown) =>
    ctx.workspaces.adopt(requirePath(path, 'path'), promptOf(prompt)),
  )
  handle(IpcInvoke.workspacesRemove, (_e, path: unknown) => ctx.workspaces.remove(requirePath(path, 'path')))
  handle(IpcInvoke.workspacesReorder, (_e, paths: unknown) => {
    if (!Array.isArray(paths) || paths.length > MAX_WORKSPACES) throw new Error('Ungültiger Parameter: paths')
    return ctx.workspaces.reorder(paths.map((path) => requirePath(path, 'paths')))
  })
  handle(IpcInvoke.workspacesCreateProject, async (_e, workspace: unknown, name: unknown) => {
    const path = await ctx.workspaces.createProject(requirePath(workspace, 'workspace'), requireString(name, 'name'))
    // The user made the folder in the app: Claude Code may work in it without asking.
    await ctx.trust.grant(path)
    return path
  })
  handle(IpcInvoke.workspacesReadPrompt, (_e, path: unknown) => ctx.workspaces.readPrompt(requirePath(path, 'path')))
  handle(IpcInvoke.workspacesWritePrompt, (_e, path: unknown, text: unknown) =>
    ctx.workspaces.writePrompt(requirePath(path, 'path'), promptOf(text) ?? ''),
  )
  handle(IpcInvoke.workspacesMove, async (_e, from: unknown, into: unknown): Promise<FolderMoveResult> => {
    const source = requirePath(from, 'from')
    const parent = requirePath(into, 'into')
    // Their processes keep the folder from moving, and their file trees and git state would point nowhere.
    const open = ctx.terminals.list().filter((t) => t.cwd && inFolder(t.cwd, source))
    if (open.length > 0) {
      const tabs = open.length === 1 ? `ist noch der Tab „${open[0]!.title}“` : `sind noch ${open.length} Tabs`
      throw new Error(`In „${basename(source)}“ ${tabs} offen. Schließe sie, dann lässt sich der Ordner verschieben.`)
    }
    const moved = await ctx.workspaces.move(source, parent)
    return { path: moved.path, sessions: await followMove(source, moved.path), leftover: moved.leftover }
  })
  handle(IpcInvoke.workspacesRelocate, async (_e, from: unknown, to: unknown) => {
    const source = requirePath(from, 'from')
    const target = requirePath(to, 'to')
    if (existsSync(source)) throw new Error(`„${source}“ ist noch da. Verschiebe den Ordner, die Sessions gehen dann mit.`)
    if (!(await stat(target).catch(() => null))?.isDirectory()) throw new Error(`Den Ordner „${target}“ gibt es nicht.`)
    return followMove(source, target)
  })
  ctx.workspaces.on('changed', () => broadcast(IpcEvent.workspacesChanged))

  // --- themes --------------------------------------------------------------
  handle(IpcInvoke.themesList, () => ctx.themes.list())
  handle(IpcInvoke.themesCreate, (_e, theme: unknown) => ctx.themes.create(requireTheme(theme)))
  handle(IpcInvoke.themesSave, (_e, id: unknown, theme: unknown) =>
    ctx.themes.save(requireString(id, 'id'), requireTheme(theme)),
  )
  handle(IpcInvoke.themesRemove, (_e, id: unknown) => ctx.themes.remove(requireString(id, 'id')))
  handle(IpcInvoke.themesExport, async (event, id: unknown) => {
    const themeId = requireString(id, 'id')
    const { canceled, filePath } = await dialog.showSaveDialog(senderWindow(event), {
      title: 'Theme exportieren',
      defaultPath: join(app.getPath('documents'), basename(ctx.themes.fileOf(themeId))),
      filters: THEME_FILE_FILTERS,
    })
    if (canceled || !filePath) return null
    await ctx.themes.exportTo(themeId, filePath)
    return filePath
  })
  handle(IpcInvoke.themesImport, async (event, files: unknown) => {
    if (Array.isArray(files)) {
      if (files.length === 0 || files.length > MAX_THEME_IMPORT) throw new Error('Ungültiger Parameter: files')
      return ctx.themes.importFrom(files.map((file) => requirePath(file, 'files')))
    }
    const { canceled, filePaths } = await dialog.showOpenDialog(senderWindow(event), {
      title: 'Themes importieren',
      defaultPath: app.getPath('documents'),
      properties: ['openFile', 'multiSelections'],
      filters: THEME_FILE_FILTERS,
    })
    return canceled || filePaths.length === 0 ? null : ctx.themes.importFrom(filePaths.slice(0, MAX_THEME_IMPORT))
  })
  handle(IpcInvoke.themesOpenFile, async (_e, id: unknown) => {
    const file = ctx.themes.fileOf(requireString(id, 'id'))
    if (!existsSync(file)) throw new Error('Die Datei des Themes gibt es nicht mehr.')
    // Without a program for JSON files, the file is shown in Explorer instead.
    if (!(await shell.openPath(file))) return true
    shell.showItemInFolder(file)
    return false
  })
  handle(IpcInvoke.themesShowFile, (_e, id: unknown) => {
    const file = ctx.themes.fileOf(requireString(id, 'id'))
    if (!existsSync(file)) throw new Error('Die Datei des Themes gibt es nicht mehr.')
    shell.showItemInFolder(file)
  })
  handle(IpcInvoke.themesOpenFolder, async () => {
    const error = await shell.openPath(ctx.themes.dir)
    if (error) throw new Error(error)
  })
  ctx.themes.on('changed', () => broadcast(IpcEvent.themesChanged))
  ctx.themes.on('saved', (entry) => broadcast(IpcEvent.themesSaved, entry))
  // Moved outside the app, e.g. in Explorer: the sessions go along, and the window learns of it.
  ctx.workspaces.follow(async (from, to) => {
    const sessions = await followMove(from, to)
    broadcast(IpcEvent.workspacesMoved, { from, to, sessions } satisfies FolderMovedEvent)
  })

  /** The folder `from` is now `to`: its sessions go along, and Claude Code trusts it there as before. */
  async function followMove(from: string, to: string): Promise<number> {
    const sessions = await ctx.sessions.relocate(from, to)
    await ctx.trust.carry(from, to)
    return sessions
  }

  // --- usage ---------------------------------------------------------------
  handle(IpcInvoke.usageGet, () => ctx.usage.getAll())
  handle(IpcInvoke.usageRefresh, (_e, accountId?: unknown) =>
    ctx.usage.refresh(typeof accountId === 'string' ? accountId : undefined),
  )
  handle(IpcInvoke.usageStats, (_e, accountId: unknown, days?: unknown) =>
    ctx.usage.stats(requireString(accountId, 'accountId'), typeof days === 'number' ? days : 30),
  )
  ctx.usage.on('changed', (usage) => broadcast(IpcEvent.usageChanged, usage))

  // --- git -----------------------------------------------------------------
  handle(IpcInvoke.gitBranch, (_e, cwd: unknown) => ctx.git.branch(requireString(cwd, 'cwd')))
  handle(IpcInvoke.gitWatch, (_e, cwds: unknown) => {
    if (!Array.isArray(cwds) || cwds.length > MAX_WATCHED_FOLDERS) throw new Error('Ungültiger Parameter: cwds')
    return ctx.git.watch(cwds.map((cwd) => requireString(cwd, 'cwds')))
  })
  handle(IpcInvoke.gitWorktreeCheck, (_e, cwd: unknown) => ctx.git.worktreeCheck(requireString(cwd, 'cwd')))
  handle(IpcInvoke.gitWebUrl, (_e, cwd: unknown) => ctx.git.webUrl(requireString(cwd, 'cwd')))
  handle(IpcInvoke.gitMainWorktree, (_e, cwd: unknown) => ctx.git.mainWorktree(requireString(cwd, 'cwd')))
  ctx.git.on('changed', (cwd, branch) => broadcast(IpcEvent.gitBranchChanged, cwd, branch))

  // --- file tree -----------------------------------------------------------
  handle(IpcInvoke.filesList, (_e, dir: unknown) => ctx.files.list(requirePath(dir, 'dir')))
  handle(IpcInvoke.filesStatus, (_e, root: unknown) => ctx.files.status(requirePath(root, 'root')))
  handle(IpcInvoke.filesSearchList, (_e, root: unknown) => ctx.files.searchList(requirePath(root, 'root')))
  handle(IpcInvoke.filesWatch, (_e, trees: unknown) => ctx.files.watch(treesOf(trees)))
  handle(IpcInvoke.filesDiff, (_e, root: unknown, path: unknown, full: unknown) => {
    // A file of the tree: relative to its folder, never above it.
    if (!isTreeDir(path) || path === '') throw new Error('Ungültiger Parameter: path')
    return ctx.files.diff(requirePath(root, 'root'), path, full === true)
  })
  // Entries of an open tree; the service keeps them in it and checks new names.
  handle(IpcInvoke.filesCreate, (_e, root: unknown, path: unknown, dir: unknown) =>
    ctx.files.create(requirePath(root, 'root'), requireTreeEntry(path, 'path'), dir === true),
  )
  handle(IpcInvoke.filesRename, (_e, root: unknown, from: unknown, to: unknown) =>
    ctx.files.rename(requirePath(root, 'root'), requireTreeEntry(from, 'from'), requireTreeEntry(to, 'to')),
  )
  handle(IpcInvoke.filesTrash, (_e, root: unknown, path: unknown) => ctx.files.trash(requirePath(root, 'root'), requireTreeEntry(path, 'path')))
  ctx.files.on('changed', (root, dirs, git, repo) => broadcast(IpcEvent.filesChanged, root, dirs, git, repo))
  ctx.files.on('touched', (terminalId, touches) => broadcast(IpcEvent.filesTouched, terminalId, touches))

  // --- `cm` command --------------------------------------------------------
  handle(IpcInvoke.commandStatus, () => ctx.command.status())
  handle(IpcInvoke.commandSetRegistered, (_e, registered: unknown) => {
    if (typeof registered !== 'boolean') throw new Error('Ungültiger Parameter: registered')
    return ctx.command.setRegistered(registered)
  })

  // --- updates -------------------------------------------------------------
  handle(IpcInvoke.updatesState, () => ctx.updates.getState())
  handle(IpcInvoke.updatesCheck, () => ctx.updates.check())
  handle(IpcInvoke.updatesDownload, () => ctx.updates.download())
  handle(IpcInvoke.updatesInstall, () => ctx.updates.install())
  handle(IpcInvoke.updatesReleases, () => ctx.updates.releases())
  handle(IpcInvoke.updatesReference, (_e, number: unknown) => {
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
      throw new Error('Ungültiger Parameter: number')
    }
    return ctx.updates.reference(number)
  })
  ctx.updates.on('changed', (state) => broadcast(IpcEvent.updatesChanged, state))
  ctx.updates.on('show', () => broadcast(IpcEvent.updatesShow))
}

/** Local HTTP API status for the settings page. */
export function registerApiIpc(api: ApiServer): void {
  handle(IpcInvoke.apiStatus, () => api.status())
  handle(IpcInvoke.apiRegenerateToken, () => api.regenerateToken())
  api.on('status', (status) => broadcast(IpcEvent.apiStatusChanged, status))
}

/** Tells the windows that the app quits, before the terminals close. */
export function announceQuitting(): void {
  broadcast(IpcEvent.appQuitting)
}

export function forwardWindowState(win: BrowserWindow): void {
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(IpcEvent.windowState, windowState(win))
  }
  for (const event of ['maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(event as 'maximize', send)
  }
}
