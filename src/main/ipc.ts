import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { IpcEvent, IpcInvoke, IpcSend } from '@shared/ipc'
import { parsePaneNode } from '@shared/panes'
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
  TerminalCreateOptions,
} from '@shared/types'
import type { ApiServer } from './api/api-server'
import { claudeInChromeStatus } from './browser/claude-in-chrome'
import type { AppContext } from './context'
import { listFontFamilies } from './lib/fonts'
import { SESSION_ID_RE } from './lib/session-files'
import { browserDownloads } from './window/browser-downloads'
import { clearBrowserData, loadFavicon } from './window/browser-guests'
import { browserLogins } from './window/browser-logins'
import { openAppWindows, windowState } from './window/main-window'

/** Sessions moved to the recycle bin in one go. */
const MAX_REMOVE = 10_000
/** A page's icon address; inline icons are data URLs of up to the largest icon (see browser-policy.ts). */
const MAX_FAVICON_URL_LENGTH = 400_000

const SETTINGS_FILE_FILTERS = [{ name: 'Claude-Manager-Einstellungen', extensions: ['json'] }]

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

/** The options of a new browser from the window, checked field by field. */
const DOWNLOAD_ACTIONS: ReadonlySet<string> = new Set<BrowserDownloadAction>(['open', 'show', 'cancel', 'remove'])
/** The most folders whose repositories are watched for checkouts at once; one per tab is far below. */
const MAX_WATCHED_FOLDERS = 500
/** The longest user name or password a page gets. */
const MAX_CREDENTIAL_LENGTH = 4096
/** The most file trees watched at once, and open folders per tree. */
const MAX_FILE_TREES = 64
const MAX_TREE_DIRS = 2000
/** Longer paths exist on no file system the app runs on. */
const MAX_PATH_LENGTH = 32_767

/** An absolute path from the window. */
function requirePath(value: unknown, name: string): string {
  const path = requireString(value, name)
  if (path.length > MAX_PATH_LENGTH || !isAbsolute(path) || path.includes('\0')) throw new Error(`Ungültiger Parameter: ${name}`)
  return path
}

/** A folder of a tree relative to its root: `/`-separated, without `..` and empty parts. */
function isTreeDir(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PATH_LENGTH && !value.includes('\0') && (value === '' || value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
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

export function registerIpc(ctx: AppContext): void {
  // --- app -----------------------------------------------------------------
  ipcMain.handle(IpcInvoke.appInfo, () => ctx.appInfo())
  ipcMain.handle(IpcInvoke.appOpenExternal, async (_e, url: unknown) => {
    const target = requireString(url, 'url')
    if (!/^https?:\/\//i.test(target)) throw new Error('Nur http(s)-Links können geöffnet werden.')
    await shell.openExternal(target)
  })
  ipcMain.handle(IpcInvoke.appOpenPath, async (_e, path: unknown) => {
    const target = requireString(path, 'path')
    if (!existsSync(target)) throw new Error(`„${target}“ existiert nicht.`)
    // openPath doesn't throw but answers with the reason, e.g. when Linux has no file manager for folders.
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return error
  })
  ipcMain.handle(IpcInvoke.appShowItem, (_e, path: unknown) => {
    const target = requirePath(path, 'path')
    if (!existsSync(target)) throw new Error(`„${target}“ existiert nicht.`)
    shell.showItemInFolder(target)
  })
  ipcMain.handle(IpcInvoke.appPickDirectory, async (event, defaultPath: unknown) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IpcInvoke.appListFonts, () => listFontFamilies())
  ipcMain.handle(IpcInvoke.appClipboardHasImage, async () =>
    (await clipboard.read()).some((item) => item.types.some((type) => type.startsWith('image/'))),
  )

  // --- window --------------------------------------------------------------
  ipcMain.handle(IpcInvoke.windowMinimize, (event) => senderWindow(event).minimize())
  ipcMain.handle(IpcInvoke.windowToggleMaximize, (event) => {
    const win = senderWindow(event)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IpcInvoke.windowClose, (event) => senderWindow(event).close())
  ipcMain.handle(IpcInvoke.windowState, (event) => windowState(senderWindow(event)))
  ipcMain.handle(IpcInvoke.windowSetTitleBarColors, (event, colors: unknown) => {
    if (!colors || typeof colors !== 'object') return
    const { color, symbolColor, dark } = colors as { color?: unknown; symbolColor?: unknown; dark?: unknown }
    // The acrylic/mica tint follows the native theme.
    nativeTheme.themeSource = dark === false ? 'light' : 'dark'
    // The caption buttons of the title bar overlay exist on Windows and Linux (main-window.ts).
    if (process.platform === 'darwin' || typeof color !== 'string' || typeof symbolColor !== 'string') return
    senderWindow(event).setTitleBarOverlay({ color, symbolColor })
  })

  // --- settings ------------------------------------------------------------
  ipcMain.handle(IpcInvoke.settingsGet, () => ctx.settings.get())
  ipcMain.handle(IpcInvoke.settingsUpdate, (_e, patch: DeepPartial<AppSettings>) => ctx.settings.update(patch ?? {}))
  ipcMain.handle(IpcInvoke.settingsReset, (_e, section?: keyof AppSettings) => ctx.settings.reset(section))
  ipcMain.handle(IpcInvoke.settingsExport, async (event) => {
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
  ipcMain.handle(IpcInvoke.settingsImport, async (event) => {
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
  ipcMain.handle(IpcInvoke.accountsList, () => ctx.accounts.list())
  ipcMain.handle(IpcInvoke.accountsCreate, (_e, input: AccountCreateInput) => ctx.accounts.create(input))
  ipcMain.handle(IpcInvoke.accountsUpdate, (_e, id: unknown, patch: AccountUpdateInput) =>
    ctx.accounts.update(requireString(id, 'id'), patch ?? {}),
  )
  ipcMain.handle(IpcInvoke.accountsRemove, (_e, id: unknown, options: { deleteConfigDir?: unknown }) => {
    const accountId = requireString(id, 'id')
    if (ctx.terminals.runningCount(accountId) > 0) {
      throw new Error('Für dieses Konto laufen noch Terminals. Bitte zuerst schließen.')
    }
    return ctx.accounts.remove(accountId, { deleteConfigDir: options?.deleteConfigDir === true })
  })
  ipcMain.handle(IpcInvoke.accountsRefresh, () => ctx.accounts.refresh())
  ctx.accounts.on('changed', (accounts) => broadcast(IpcEvent.accountsChanged, accounts))

  // --- cswap import --------------------------------------------------------
  ipcMain.handle(IpcInvoke.cswapStatus, () => ctx.cswap.status())
  ipcMain.handle(IpcInvoke.cswapImport, (_e, input: CswapImportInput) => ctx.cswap.import(input))

  // --- terminals -----------------------------------------------------------
  ipcMain.handle(IpcInvoke.terminalsList, () => ctx.terminals.list())
  ipcMain.handle(IpcInvoke.terminalsLayouts, () => ctx.terminals.layouts())
  ipcMain.handle(IpcInvoke.terminalsArrange, (_e, layout: unknown) => {
    const parsed = parsePaneNode(layout)
    if (!parsed) throw new Error('Ungültiger Parameter: layout')
    ctx.terminals.arrange(parsed)
  })
  ipcMain.handle(IpcInvoke.terminalsCreate, (_e, options: TerminalCreateOptions) => ctx.terminals.open(options))
  ipcMain.handle(IpcInvoke.terminalsOpenBrowser, (_e, options: unknown) => ctx.terminals.openBrowser(browserOptions(options)))
  ipcMain.handle(IpcInvoke.terminalsKill, (_e, id: unknown) => ctx.terminals.kill(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsClose, (_e, id: unknown) => ctx.terminals.close(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsRename, (_e, id: unknown, title: unknown) => {
    // Empty is allowed: the tab follows the session's title again.
    if (typeof title !== 'string') throw new Error('Ungültiger Parameter: title')
    ctx.terminals.rename(requireString(id, 'id'), title)
  })
  ipcMain.handle(IpcInvoke.terminalsAttach, (_e, id: unknown) => ctx.terminals.attach(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsContinueWith, (_e, id: unknown, accountId: unknown) =>
    ctx.handoff.continueTerminal(requireString(id, 'id'), requireString(accountId, 'accountId')),
  )
  ipcMain.handle(IpcInvoke.terminalsRestartSession, (_e, id: unknown) => ctx.handoff.restartTerminal(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsSetMuted, (_e, id: unknown, muted: unknown) => {
    if (typeof muted !== 'boolean') throw new Error('Ungültiger Parameter: muted')
    ctx.terminals.setMuted(requireString(id, 'id'), muted)
  })
  ipcMain.on(IpcSend.terminalViewing, (_e, ids: unknown) => {
    ctx.notifications.setViewing(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!id) : [])
  })
  ipcMain.on(IpcSend.terminalColorScheme, (_e, dark: unknown) => {
    if (typeof dark === 'boolean') ctx.terminals.setColorScheme(dark)
  })
  ipcMain.handle(IpcInvoke.browserFavicon, (_e, url: unknown) =>
    typeof url === 'string' && url.length <= MAX_FAVICON_URL_LENGTH ? loadFavicon(url) : null,
  )
  ipcMain.on(IpcSend.browserAttach, (event, id: unknown, contentsId: unknown) => {
    if (typeof id === 'string' && typeof contentsId === 'number') ctx.browser.attach(id, contentsId, event.sender)
  })
  ipcMain.handle(IpcInvoke.browserLog, (_e, id: unknown) => ctx.browser.log(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.browserClearLog, (_e, id: unknown) => ctx.browser.clearLog(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.browserTakeOver, (_e, id: unknown, takenOver: unknown) =>
    ctx.browser.takeOver(requireString(id, 'id'), takenOver === true),
  )
  ipcMain.handle(IpcInvoke.browserControls, () => ctx.browser.controls())
  ipcMain.handle(IpcInvoke.browserClearData, () => clearBrowserData())
  ipcMain.handle(IpcInvoke.browserResetViewport, (_e, id: unknown) => ctx.browser.resetViewport(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.browserResetEmulation, (_e, id: unknown) => ctx.browser.resetEmulation(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.browserResetRoutes, (_e, id: unknown) => ctx.browser.resetRoutes(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.browserClaudeInChrome, () => claudeInChromeStatus(ctx.accounts))
  ipcMain.handle(IpcInvoke.browserDownloads, () => browserDownloads.list())
  ipcMain.handle(IpcInvoke.browserDownloadAction, (_e, id: unknown, action: unknown) => {
    if (typeof action !== 'string' || !DOWNLOAD_ACTIONS.has(action)) throw new Error('Ungültiger Parameter: action')
    return browserDownloads.act(requireString(id, 'id'), action as BrowserDownloadAction)
  })
  ipcMain.handle(IpcInvoke.browserClearDownloads, () => browserDownloads.clear())
  ipcMain.handle(IpcInvoke.browserLoginAnswer, (_e, id: unknown, credentials: unknown) =>
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
  ipcMain.on(IpcSend.browserPage, (_e, id: unknown, page: unknown) => {
    const { url, title } = (page ?? {}) as Record<string, unknown>
    if (typeof id === 'string' && typeof url === 'string' && typeof title === 'string') {
      ctx.terminals.setBrowserPage(id, { url, title })
    }
  })
  ipcMain.on(IpcSend.terminalReorder, (_e, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) ctx.terminals.reorder(ids)
  })
  ipcMain.on(IpcSend.terminalWrite, (_e, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') ctx.terminals.write(id, data)
  })
  ipcMain.on(IpcSend.terminalResize, (_e, id: unknown, cols: unknown, rows: unknown) => {
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
  ipcMain.handle(IpcInvoke.notificationsTest, () => ctx.notifications.showTest())

  // --- sessions ------------------------------------------------------------
  ipcMain.handle(IpcInvoke.sessionsList, (_e, accountId?: unknown) =>
    ctx.sessions.list(typeof accountId === 'string' ? accountId : undefined),
  )
  ipcMain.handle(IpcInvoke.sessionsGet, (_e, accountId: unknown, sessionId: unknown) =>
    ctx.sessions.get(requireString(accountId, 'accountId'), requireString(sessionId, 'sessionId')),
  )
  ipcMain.handle(IpcInvoke.sessionsToolCall, (_e, accountId: unknown, sessionId: unknown, toolUseId: unknown) =>
    ctx.sessions.toolCall(
      requireString(accountId, 'accountId'),
      requireString(sessionId, 'sessionId'),
      requireString(toolUseId, 'toolUseId'),
    ),
  )
  ipcMain.handle(IpcInvoke.sessionsSearch, (_e, query: unknown) =>
    ctx.sessions.search(typeof query === 'string' ? query.slice(0, 200) : ''),
  )
  ipcMain.handle(IpcInvoke.sessionsContinueWith, (_e, accountId: unknown, sessionId: unknown, targetAccountId: unknown) =>
    ctx.handoff.resumeSession(
      requireString(accountId, 'accountId'),
      requireString(sessionId, 'sessionId'),
      requireString(targetAccountId, 'targetAccountId'),
    ),
  )
  ipcMain.handle(IpcInvoke.sessionsRemove, (_e, sessions: unknown) => {
    if (!Array.isArray(sessions) || sessions.length > MAX_REMOVE) throw new Error('Ungültiger Parameter: sessions')
    const refs = sessions.map((s: { accountId?: unknown; sessionId?: unknown } | null) => {
      const sessionId = requireString(s?.sessionId, 'sessionId')
      if (!SESSION_ID_RE.test(sessionId)) throw new Error('Ungültige Session-ID.')
      return { accountId: ctx.accounts.get(requireString(s?.accountId, 'accountId')).id, sessionId }
    })
    return ctx.sessions.remove(refs)
  })
  ctx.sessions.on('changed', (accountId) => broadcast(IpcEvent.sessionsChanged, accountId))

  // --- usage ---------------------------------------------------------------
  ipcMain.handle(IpcInvoke.usageGet, () => ctx.usage.getAll())
  ipcMain.handle(IpcInvoke.usageRefresh, (_e, accountId?: unknown) =>
    ctx.usage.refresh(typeof accountId === 'string' ? accountId : undefined),
  )
  ipcMain.handle(IpcInvoke.usageStats, (_e, accountId: unknown, days?: unknown) =>
    ctx.usage.stats(requireString(accountId, 'accountId'), typeof days === 'number' ? days : 30),
  )
  ctx.usage.on('changed', (usage) => broadcast(IpcEvent.usageChanged, usage))

  // --- git -----------------------------------------------------------------
  ipcMain.handle(IpcInvoke.gitBranch, (_e, cwd: unknown) => ctx.git.branch(requireString(cwd, 'cwd')))
  ipcMain.handle(IpcInvoke.gitWatch, (_e, cwds: unknown) => {
    if (!Array.isArray(cwds) || cwds.length > MAX_WATCHED_FOLDERS) throw new Error('Ungültiger Parameter: cwds')
    return ctx.git.watch(cwds.map((cwd) => requireString(cwd, 'cwds')))
  })
  ipcMain.handle(IpcInvoke.gitWorktreeCheck, (_e, cwd: unknown) => ctx.git.worktreeCheck(requireString(cwd, 'cwd')))
  ipcMain.handle(IpcInvoke.gitWebUrl, (_e, cwd: unknown) => ctx.git.webUrl(requireString(cwd, 'cwd')))
  ctx.git.on('changed', (cwd, branch) => broadcast(IpcEvent.gitBranchChanged, cwd, branch))

  // --- file tree -----------------------------------------------------------
  ipcMain.handle(IpcInvoke.filesList, (_e, dir: unknown) => ctx.files.list(requirePath(dir, 'dir')))
  ipcMain.handle(IpcInvoke.filesStatus, (_e, root: unknown) => ctx.files.status(requirePath(root, 'root')))
  ipcMain.handle(IpcInvoke.filesSearchList, (_e, root: unknown) => ctx.files.searchList(requirePath(root, 'root')))
  ipcMain.handle(IpcInvoke.filesWatch, (_e, trees: unknown) => ctx.files.watch(treesOf(trees)))
  ipcMain.handle(IpcInvoke.filesDiff, (_e, root: unknown, path: unknown, full: unknown) => {
    // A file of the tree: relative to its folder, never above it.
    if (!isTreeDir(path) || path === '') throw new Error('Ungültiger Parameter: path')
    return ctx.files.diff(requirePath(root, 'root'), path, full === true)
  })
  ctx.files.on('changed', (root, dirs, git) => broadcast(IpcEvent.filesChanged, root, dirs, git))
  ctx.files.on('touched', (terminalId, touches) => broadcast(IpcEvent.filesTouched, terminalId, touches))

  // --- `cm` command --------------------------------------------------------
  ipcMain.handle(IpcInvoke.commandStatus, () => ctx.command.status())
  ipcMain.handle(IpcInvoke.commandSetRegistered, (_e, registered: unknown) => {
    if (typeof registered !== 'boolean') throw new Error('Ungültiger Parameter: registered')
    return ctx.command.setRegistered(registered)
  })

  // --- updates -------------------------------------------------------------
  ipcMain.handle(IpcInvoke.updatesState, () => ctx.updates.getState())
  ipcMain.handle(IpcInvoke.updatesCheck, () => ctx.updates.check())
  ipcMain.handle(IpcInvoke.updatesDownload, () => ctx.updates.download())
  ipcMain.handle(IpcInvoke.updatesInstall, () => ctx.updates.install())
  ipcMain.handle(IpcInvoke.updatesReleases, () => ctx.updates.releases())
  ipcMain.handle(IpcInvoke.updatesReference, (_e, number: unknown) => {
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
  ipcMain.handle(IpcInvoke.apiStatus, () => api.status())
  ipcMain.handle(IpcInvoke.apiRegenerateToken, () => api.regenerateToken())
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
