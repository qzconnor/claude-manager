import type {
  Account,
  AccountCreateInput,
  AccountTokenStats,
  AccountUpdateInput,
  AccountUsage,
  ApiStatus,
  AppInfo,
  CommandStatus,
  AppSettings,
  CswapImportInput,
  CswapStatus,
  DeepPartial,
  DialogRequest,
  SessionDetail,
  SessionGroup,
  TerminalCreateOptions,
  TerminalInfo,
  TranscriptToolDetail,
  WindowState,
} from './types'

/** Request/response channels (ipcRenderer.invoke ↔ ipcMain.handle). */
export const IpcInvoke = {
  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
  appOpenPath: 'app:open-path',
  appPickDirectory: 'app:pick-directory',
  appListFonts: 'app:list-fonts',
  appClipboardHasImage: 'app:clipboard-has-image',

  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowState: 'window:state',
  windowSetTitleBarColors: 'window:set-title-bar-colors',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',

  accountsList: 'accounts:list',
  accountsCreate: 'accounts:create',
  accountsUpdate: 'accounts:update',
  accountsRemove: 'accounts:remove',
  accountsRefresh: 'accounts:refresh',

  cswapStatus: 'cswap:status',
  cswapImport: 'cswap:import',

  terminalsList: 'terminals:list',
  terminalsCreate: 'terminals:create',
  terminalsKill: 'terminals:kill',
  terminalsClose: 'terminals:close',
  terminalsRename: 'terminals:rename',
  terminalsBuffer: 'terminals:buffer',
  terminalsContinueWith: 'terminals:continue-with',

  sessionsList: 'sessions:list',
  sessionsGet: 'sessions:get',
  sessionsToolCall: 'sessions:tool-call',
  sessionsContinueWith: 'sessions:continue-with',

  usageGet: 'usage:get',
  usageRefresh: 'usage:refresh',
  usageStats: 'usage:stats',

  commandStatus: 'command:status',
  commandSetRegistered: 'command:set-registered',

  apiStatus: 'api:status',
  apiRegenerateToken: 'api:regenerate-token',
} as const

/** Fire-and-forget channels renderer → main (ipcRenderer.send ↔ ipcMain.on). */
export const IpcSend = {
  terminalWrite: 'terminals:write',
  terminalResize: 'terminals:resize',
  /** The page listens for dialog requests (see src/main/window/dialogs.ts). */
  dialogsReady: 'dialogs:ready',
  dialogAnswer: 'dialogs:answer',
} as const

/** Events main → renderer (webContents.send ↔ ipcRenderer.on). */
export const IpcEvent = {
  windowState: 'event:window-state',
  settingsChanged: 'event:settings-changed',
  accountsChanged: 'event:accounts-changed',
  terminalsChanged: 'event:terminals-changed',
  terminalData: 'event:terminal-data',
  terminalExit: 'event:terminal-exit',
  /** Ask the window to show a terminal tab (e.g. opened through the local API). */
  terminalActivate: 'event:terminal-activate',
  usageChanged: 'event:usage-changed',
  sessionsChanged: 'event:sessions-changed',
  apiStatusChanged: 'event:api-status-changed',
  /** The main process asks the window to show a message box. */
  dialogRequest: 'event:dialog-request',
} as const

export type Unsubscribe = () => void

/** The API the preload script exposes as `window.api`. */
export interface ManagerApi {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<string>
    pickDirectory(defaultPath?: string | null): Promise<string | null>
    listFonts(): Promise<string[]>
    /** Whether the clipboard holds an image, e.g. a screenshot. */
    clipboardHasImage(): Promise<boolean>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    state(): Promise<WindowState>
    /** Colors of the native caption buttons and whether the native backdrop should be dark. */
    setTitleBarColors(colors: { color: string; symbolColor: string; dark: boolean }): Promise<void>
    onState(cb: (state: WindowState) => void): Unsubscribe
    /** Message boxes of the main process, shown in the app instead of as native dialogs. */
    onDialog(cb: (request: DialogRequest) => void): Unsubscribe
    answerDialog(id: string, confirmed: boolean): void
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    reset(section?: keyof AppSettings): Promise<AppSettings>
    onChanged(cb: (settings: AppSettings) => void): Unsubscribe
  }
  accounts: {
    list(): Promise<Account[]>
    create(input: AccountCreateInput): Promise<Account>
    update(id: string, patch: AccountUpdateInput): Promise<Account>
    remove(id: string, options: { deleteConfigDir: boolean }): Promise<void>
    refresh(): Promise<Account[]>
    onChanged(cb: (accounts: Account[]) => void): Unsubscribe
  }
  /** Taking accounts over from claude-swap (only name, email and organization). */
  cswap: {
    status(): Promise<CswapStatus>
    /** Creates browser login accounts; each still has to be logged in once. */
    import(input: CswapImportInput): Promise<Account[]>
  }
  terminals: {
    list(): Promise<TerminalInfo[]>
    create(options: TerminalCreateOptions): Promise<TerminalInfo>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    /** Kill the process but keep the tab (shows exit state). */
    kill(id: string): Promise<void>
    /** Kill (if needed) and forget the terminal. */
    close(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    /** Output produced so far (for re-attaching a view); `end` is the stream offset after `data`. */
    buffer(id: string): Promise<{ data: string; end: number }>
    /**
     * Ends the tab and continues its session in a new one with `accountId`'s limits.
     * Tokens and API keys run the session where it lies; for a browser login it is copied over.
     */
    continueWith(id: string, accountId: string): Promise<TerminalInfo>
    onChanged(cb: (terminals: TerminalInfo[]) => void): Unsubscribe
    onData(cb: (id: string, data: string, offset: number) => void): Unsubscribe
    onExit(cb: (id: string, exitCode: number) => void): Unsubscribe
    onActivate(cb: (id: string) => void): Unsubscribe
  }
  sessions: {
    list(accountId?: string): Promise<SessionGroup[]>
    get(accountId: string, sessionId: string): Promise<SessionDetail>
    /** Complete input and output of one tool call. */
    toolCall(accountId: string, sessionId: string, toolUseId: string): Promise<TranscriptToolDetail | null>
    /** Opens the session in a new tab that runs with `targetAccountId`'s limits. */
    continueWith(accountId: string, sessionId: string, targetAccountId: string): Promise<TerminalInfo>
    onChanged(cb: (accountId: string) => void): Unsubscribe
  }
  usage: {
    get(): Promise<AccountUsage[]>
    refresh(accountId?: string): Promise<AccountUsage[]>
    stats(accountId: string, days?: number): Promise<AccountTokenStats>
    onChanged(cb: (usage: AccountUsage[]) => void): Unsubscribe
  }
  /** The `cm` command line launcher. */
  command: {
    status(): Promise<CommandStatus>
    setRegistered(registered: boolean): Promise<CommandStatus>
  }
  api: {
    status(): Promise<ApiStatus>
    regenerateToken(): Promise<ApiStatus>
    onStatus(cb: (status: ApiStatus) => void): Unsubscribe
  }
}
