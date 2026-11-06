import type {
  Account,
  AutoSwitchEvent,
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
  GitBranch,
  PaneNode,
  PaneSplit,
  SessionDetail,
  SessionGroup,
  SessionRef,
  SessionRemoveResult,
  SessionSearchHit,
  SettingsImportResult,
  TerminalCreateOptions,
  TerminalInfo,
  TranscriptToolDetail,
  ReleaseNote,
  ReleaseReference,
  UpdateState,
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
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',

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
  terminalsAttach: 'terminals:attach',
  terminalsContinueWith: 'terminals:continue-with',
  terminalsSetMuted: 'terminals:set-muted',
  terminalsLayouts: 'terminals:layouts',
  terminalsArrange: 'terminals:arrange',

  notificationsTest: 'notifications:test',

  sessionsList: 'sessions:list',
  sessionsGet: 'sessions:get',
  sessionsToolCall: 'sessions:tool-call',
  sessionsSearch: 'sessions:search',
  sessionsContinueWith: 'sessions:continue-with',
  sessionsRemove: 'sessions:remove',

  usageGet: 'usage:get',
  usageRefresh: 'usage:refresh',
  usageStats: 'usage:stats',

  gitBranch: 'git:branch',

  commandStatus: 'command:status',
  commandSetRegistered: 'command:set-registered',

  apiStatus: 'api:status',
  apiRegenerateToken: 'api:regenerate-token',

  updatesState: 'updates:state',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  updatesReleases: 'updates:releases',
  updatesReference: 'updates:reference',
} as const

/** Fire-and-forget channels renderer → main (ipcRenderer.send ↔ ipcMain.on). */
export const IpcSend = {
  terminalWrite: 'terminals:write',
  terminalResize: 'terminals:resize',
  /** The terminals the window shows (those of the selected tab), none while another page is open. */
  terminalViewing: 'terminals:viewing',
  /** Whether the terminal theme is dark (see TerminalService.setColorScheme). */
  terminalColorScheme: 'terminals:color-scheme',
  /** Order of the tabs in the window, after one was moved. */
  terminalReorder: 'terminals:reorder',
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
  /** A tab was replaced by one that continues its session with another account; before the old one closes. */
  terminalReplaced: 'event:terminal-replaced',
  /** A session at a limit went on with another account by itself, or that failed. */
  terminalAutoSwitch: 'event:terminal-auto-switch',
  usageChanged: 'event:usage-changed',
  /** A warning about a limit was clicked: the window shows the usage page. */
  usageShow: 'event:usage-show',
  /** The branch of the repository last asked for changed (e.g. a checkout in the terminal). */
  gitBranchChanged: 'event:git-branch-changed',
  sessionsChanged: 'event:sessions-changed',
  apiStatusChanged: 'event:api-status-changed',
  updatesChanged: 'event:updates-changed',
  /** The update notification was clicked. */
  updatesShow: 'event:updates-show',
  /** The main process asks the window to show a message box. */
  dialogRequest: 'event:dialog-request',
} as const

export type Unsubscribe = () => void

/** The API the preload script exposes as `window.api`. */
export interface ManagerApi {
  /** `process.platform` of the app, known right away (unlike `app.info()`). */
  platform: string
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<string>
    pickDirectory(defaultPath?: string | null): Promise<string | null>
    listFonts(): Promise<string[]>
    /** Whether the clipboard holds an image, e.g. a screenshot. */
    clipboardHasImage(): Promise<boolean>
    /** Path of a file dragged into the window; empty for files that don't exist on disk. */
    pathForFile(file: File): string
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
    /** Saves the settings to a file the user picks, without accounts. The path, or null when cancelled. */
    export(): Promise<string | null>
    /** Takes over the settings of a file the user picks; null when cancelled. */
    import(): Promise<SettingsImportResult | null>
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
    /** The tabs with more than one terminal; every other terminal has a tab of its own. */
    layouts(): Promise<PaneSplit[]>
    /**
     * Puts these terminals together in one tab, as `layout` shares its space, and takes them out of
     * the tabs they were in. A single id gives the terminal a tab of its own.
     */
    arrange(layout: PaneNode): Promise<void>
    /** Null when Claude Code shouldn't trust the folder (the user said no in the app's question). */
    create(options: TerminalCreateOptions): Promise<TerminalInfo | null>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    /** Kill the process but keep the tab (shows exit state). */
    kill(id: string): Promise<void>
    /** Kill (if needed) and forget the terminal. */
    close(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    /**
     * Output produced so far, for a view of the tab; `end` is the stream offset after `data`.
     * `answered`: an earlier view already answered the queries in it, they mustn't be answered again.
     */
    attach(id: string): Promise<{ data: string; end: number; answered: boolean }>
    /**
     * Ends the tab and continues its session in a new one with `accountId`'s limits.
     * Tokens and API keys run the session where it lies; for a browser login it is copied over.
     * Null when the folder isn't trusted for that account: the tab then stays as it is.
     */
    continueWith(id: string, accountId: string): Promise<TerminalInfo | null>
    /** A muted tab sends no notifications and doesn't flash the taskbar. */
    setMuted(id: string, muted: boolean): Promise<void>
    /** Tells which terminals the window shows (none: another page): their news counts as seen. */
    viewing(ids: string[]): void
    /** Tells whether the terminal theme is dark; programs that asked for it hear when that changes. */
    colorScheme(dark: boolean): void
    /** Order of the tabs (ids) after one was moved; the next start restores them in it. */
    reorder(ids: string[]): void
    onChanged(cb: (terminals: TerminalInfo[], layouts: PaneSplit[]) => void): Unsubscribe
    onData(cb: (id: string, data: string, offset: number) => void): Unsubscribe
    onExit(cb: (id: string, exitCode: number) => void): Unsubscribe
    onActivate(cb: (id: string) => void): Unsubscribe
    /** The new tab takes the place of the old one, which closes right after. */
    onReplaced(cb: (oldId: string, info: TerminalInfo) => void): Unsubscribe
    onAutoSwitch(cb: (event: AutoSwitchEvent) => void): Unsubscribe
  }
  sessions: {
    list(accountId?: string): Promise<SessionGroup[]>
    get(accountId: string, sessionId: string): Promise<SessionDetail>
    /** Complete input and output of one tool call. */
    toolCall(accountId: string, sessionId: string, toolUseId: string): Promise<TranscriptToolDetail | null>
    /**
     * Sessions of all accounts whose prompts and answers contain every word of `query`, newest first.
     * An empty query only brings the search index up to date, e.g. while the search opens.
     */
    search(query: string): Promise<SessionSearchHit[]>
    /** Opens the session in a new tab that runs with `targetAccountId`'s limits; null when its folder isn't trusted. */
    continueWith(accountId: string, sessionId: string, targetAccountId: string): Promise<TerminalInfo | null>
    /**
     * Moves sessions to the recycle bin: transcript, subagents, `/rewind` snapshots.
     * Sessions open in a tab or a running Claude Code are kept.
     */
    remove(sessions: SessionRef[]): Promise<SessionRemoveResult>
    onChanged(cb: (accountId: string) => void): Unsubscribe
  }
  notifications: {
    /** Shows an example notification with the current settings. */
    test(): Promise<void>
  }
  usage: {
    get(): Promise<AccountUsage[]>
    refresh(accountId?: string): Promise<AccountUsage[]>
    stats(accountId: string, days?: number): Promise<AccountTokenStats>
    onChanged(cb: (usage: AccountUsage[]) => void): Unsubscribe
    /** A warning about a limit was clicked. */
    onShow(cb: () => void): Unsubscribe
  }
  git: {
    /**
     * Branch of the repository `cwd` lies in; null without git or outside a repository.
     * Changes to it are reported through `onBranchChanged` until another `cwd` is asked for.
     */
    branch(cwd: string): Promise<GitBranch | null>
    onBranchChanged(cb: (cwd: string, branch: GitBranch | null) => void): Unsubscribe
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
  /** Updates of the app itself, from the GitHub releases. */
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<void>
    download(): Promise<void>
    /** Quits and installs a downloaded update; the new version starts by itself. */
    install(): Promise<void>
    /** Published versions with their release notes, newest first. */
    releases(): Promise<ReleaseNote[]>
    /** A pull request (or issue) from the notes with its description – the details of a change. */
    reference(number: number): Promise<ReleaseReference>
    onChanged(cb: (state: UpdateState) => void): Unsubscribe
    onShow(cb: () => void): Unsubscribe
  }
}
