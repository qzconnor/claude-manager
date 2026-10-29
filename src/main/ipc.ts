import { existsSync } from 'node:fs'
import { BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { IpcEvent, IpcInvoke, IpcSend } from '@shared/ipc'
import type {
  AccountCreateInput,
  AccountUpdateInput,
  AppSettings,
  CswapImportInput,
  DeepPartial,
  TerminalCreateOptions,
} from '@shared/types'
import type { ApiServer } from './api/api-server'
import type { AppContext } from './context'
import { listFontFamilies } from './lib/fonts'
import { windowState } from './window/main-window'

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
    return shell.openPath(target)
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
    if (process.platform !== 'win32' || typeof color !== 'string' || typeof symbolColor !== 'string') return
    senderWindow(event).setTitleBarOverlay({ color, symbolColor })
  })

  // --- settings ------------------------------------------------------------
  ipcMain.handle(IpcInvoke.settingsGet, () => ctx.settings.get())
  ipcMain.handle(IpcInvoke.settingsUpdate, (_e, patch: DeepPartial<AppSettings>) => ctx.settings.update(patch ?? {}))
  ipcMain.handle(IpcInvoke.settingsReset, (_e, section?: keyof AppSettings) => ctx.settings.reset(section))
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
  ipcMain.handle(IpcInvoke.terminalsCreate, (_e, options: TerminalCreateOptions) => ctx.terminals.create(options))
  ipcMain.handle(IpcInvoke.terminalsKill, (_e, id: unknown) => ctx.terminals.kill(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsClose, (_e, id: unknown) => ctx.terminals.close(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsRename, (_e, id: unknown, title: unknown) =>
    ctx.terminals.rename(requireString(id, 'id'), requireString(title, 'title')),
  )
  ipcMain.handle(IpcInvoke.terminalsBuffer, (_e, id: unknown) => ctx.terminals.buffer(requireString(id, 'id')))
  ipcMain.handle(IpcInvoke.terminalsContinueWith, (_e, id: unknown, accountId: unknown) =>
    ctx.handoff.continueTerminal(requireString(id, 'id'), requireString(accountId, 'accountId')),
  )
  ipcMain.on(IpcSend.terminalWrite, (_e, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') ctx.terminals.write(id, data)
  })
  ipcMain.on(IpcSend.terminalResize, (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id === 'string' && typeof cols === 'number' && typeof rows === 'number') ctx.terminals.resize(id, cols, rows)
  })
  ctx.terminals.on('changed', (terminals) => broadcast(IpcEvent.terminalsChanged, terminals))
  ctx.terminals.on('data', (id, data, offset) => broadcast(IpcEvent.terminalData, id, data, offset))
  ctx.terminals.on('exit', (id, code) => {
    broadcast(IpcEvent.terminalExit, id, code)
    // A login terminal finishing usually means new credentials.
    ctx.accounts.refresh()
  })

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
  ipcMain.handle(IpcInvoke.sessionsContinueWith, (_e, accountId: unknown, sessionId: unknown, targetAccountId: unknown) =>
    ctx.handoff.resumeSession(
      requireString(accountId, 'accountId'),
      requireString(sessionId, 'sessionId'),
      requireString(targetAccountId, 'targetAccountId'),
    ),
  )
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

  // --- `cm` command --------------------------------------------------------
  ipcMain.handle(IpcInvoke.commandStatus, () => ctx.command.status())
  ipcMain.handle(IpcInvoke.commandSetRegistered, (_e, registered: unknown) => {
    if (typeof registered !== 'boolean') throw new Error('Ungültiger Parameter: registered')
    return ctx.command.setRegistered(registered)
  })
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
