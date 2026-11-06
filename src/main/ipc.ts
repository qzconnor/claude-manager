import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { IpcEvent, IpcInvoke, IpcSend } from '@shared/ipc'
import type {
  AccountCreateInput,
  AccountUpdateInput,
  AutoSwitchEvent,
  AppSettings,
  CswapImportInput,
  DeepPartial,
  TerminalCreateOptions,
} from '@shared/types'
import type { ApiServer } from './api/api-server'
import type { AppContext } from './context'
import { listFontFamilies } from './lib/fonts'
import { SESSION_ID_RE } from './lib/session-files'
import { windowState } from './window/main-window'

/** Sessions moved to the recycle bin in one go. */
const MAX_REMOVE = 10_000

const SETTINGS_FILE_FILTERS = [{ name: 'Claude-Manager-Einstellungen', extensions: ['json'] }]

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
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
  ipcMain.handle(IpcInvoke.terminalsCreate, (_e, options: TerminalCreateOptions) => ctx.terminals.open(options))
  ipcMain.handle(IpcInvoke.terminalsKill, (_e, id: unknown) => ctx.terminals.kill(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsClose, (_e, id: unknown) => ctx.terminals.close(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsRename, (_e, id: unknown, title: unknown) => {
    // Empty is allowed: the tab follows the session's title again.
    if (typeof title !== 'string') throw new Error('Ungültiger Parameter: title')
    ctx.terminals.rename(requireString(id, 'id'), title)
  })
  ipcMain.handle(IpcInvoke.terminalsBuffer, (_e, id: unknown) => ctx.terminals.buffer(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsContinueWith, (_e, id: unknown, accountId: unknown) =>
    ctx.handoff.continueTerminal(requireString(id, 'id'), requireString(accountId, 'accountId')),
  )
  ipcMain.handle(IpcInvoke.terminalsSetMuted, (_e, id: unknown, muted: unknown) => {
    if (typeof muted !== 'boolean') throw new Error('Ungültiger Parameter: muted')
    ctx.terminals.setMuted(requireString(id, 'id'), muted)
  })
  ipcMain.on(IpcSend.terminalViewing, (_e, id: unknown) => {
    ctx.notifications.setViewing(typeof id === 'string' && id ? id : null)
  })
  ipcMain.on(IpcSend.terminalColorScheme, (_e, dark: unknown) => {
    if (typeof dark === 'boolean') ctx.terminals.setColorScheme(dark)
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
  ctx.terminals.on('changed', (terminals) => broadcast(IpcEvent.terminalsChanged, terminals))
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
  ctx.git.on('changed', (cwd, branch) => broadcast(IpcEvent.gitBranchChanged, cwd, branch))

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

export function forwardWindowState(win: BrowserWindow): void {
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(IpcEvent.windowState, windowState(win))
  }
  for (const event of ['maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(event as 'maximize', send)
  }
}
