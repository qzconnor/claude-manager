import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcEvent, IpcInvoke, IpcSend, type ManagerApi, type Unsubscribe } from '@shared/ipc'

function subscribe<Args extends unknown[]>(channel: string, cb: (...args: Args) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => cb(...(args as Args))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: ManagerApi = {
  app: {
    info: () => invoke(IpcInvoke.appInfo),
    openExternal: (url) => invoke(IpcInvoke.appOpenExternal, url),
    openPath: (path) => invoke(IpcInvoke.appOpenPath, path),
    pickDirectory: (defaultPath) => invoke(IpcInvoke.appPickDirectory, defaultPath ?? null),
    listFonts: () => invoke(IpcInvoke.appListFonts),
    clipboardHasImage: () => invoke(IpcInvoke.appClipboardHasImage),
  },
  window: {
    minimize: () => invoke(IpcInvoke.windowMinimize),
    toggleMaximize: () => invoke(IpcInvoke.windowToggleMaximize),
    close: () => invoke(IpcInvoke.windowClose),
    state: () => invoke(IpcInvoke.windowState),
    setTitleBarColors: (colors) => invoke(IpcInvoke.windowSetTitleBarColors, colors),
    onState: (cb) => subscribe(IpcEvent.windowState, cb),
    onDialog: (cb) => {
      const off = subscribe(IpcEvent.dialogRequest, cb)
      // Main holds dialogs back until the page can show them.
      ipcRenderer.send(IpcSend.dialogsReady)
      return off
    },
    answerDialog: (id, confirmed) => ipcRenderer.send(IpcSend.dialogAnswer, id, confirmed),
  },
  settings: {
    get: () => invoke(IpcInvoke.settingsGet),
    update: (patch) => invoke(IpcInvoke.settingsUpdate, patch),
    reset: (section) => invoke(IpcInvoke.settingsReset, section),
    onChanged: (cb) => subscribe(IpcEvent.settingsChanged, cb),
  },
  accounts: {
    list: () => invoke(IpcInvoke.accountsList),
    create: (input) => invoke(IpcInvoke.accountsCreate, input),
    update: (id, patch) => invoke(IpcInvoke.accountsUpdate, id, patch),
    remove: (id, options) => invoke(IpcInvoke.accountsRemove, id, options),
    refresh: () => invoke(IpcInvoke.accountsRefresh),
    onChanged: (cb) => subscribe(IpcEvent.accountsChanged, cb),
  },
  cswap: {
    status: () => invoke(IpcInvoke.cswapStatus),
    import: (input) => invoke(IpcInvoke.cswapImport, input),
  },
  terminals: {
    list: () => invoke(IpcInvoke.terminalsList),
    create: (options) => invoke(IpcInvoke.terminalsCreate, options),
    write: (id, data) => ipcRenderer.send(IpcSend.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IpcSend.terminalResize, id, cols, rows),
    kill: (id) => invoke(IpcInvoke.terminalsKill, id),
    close: (id) => invoke(IpcInvoke.terminalsClose, id),
    rename: (id, title) => invoke(IpcInvoke.terminalsRename, id, title),
    buffer: (id) => invoke(IpcInvoke.terminalsBuffer, id),
    continueWith: (id, accountId) => invoke(IpcInvoke.terminalsContinueWith, id, accountId),
    onChanged: (cb) => subscribe(IpcEvent.terminalsChanged, cb),
    onData: (cb) => subscribe(IpcEvent.terminalData, cb),
    onExit: (cb) => subscribe(IpcEvent.terminalExit, cb),
    onActivate: (cb) => subscribe(IpcEvent.terminalActivate, cb),
  },
  sessions: {
    list: (accountId) => invoke(IpcInvoke.sessionsList, accountId),
    get: (accountId, sessionId) => invoke(IpcInvoke.sessionsGet, accountId, sessionId),
    toolCall: (accountId, sessionId, toolUseId) => invoke(IpcInvoke.sessionsToolCall, accountId, sessionId, toolUseId),
    continueWith: (accountId, sessionId, targetAccountId) =>
      invoke(IpcInvoke.sessionsContinueWith, accountId, sessionId, targetAccountId),
    onChanged: (cb) => subscribe(IpcEvent.sessionsChanged, cb),
  },
  usage: {
    get: () => invoke(IpcInvoke.usageGet),
    refresh: (accountId) => invoke(IpcInvoke.usageRefresh, accountId),
    stats: (accountId, days) => invoke(IpcInvoke.usageStats, accountId, days),
    onChanged: (cb) => subscribe(IpcEvent.usageChanged, cb),
  },
  command: {
    status: () => invoke(IpcInvoke.commandStatus),
    setRegistered: (registered) => invoke(IpcInvoke.commandSetRegistered, registered),
  },
  api: {
    status: () => invoke(IpcInvoke.apiStatus),
    regenerateToken: () => invoke(IpcInvoke.apiRegenerateToken),
    onStatus: (cb) => subscribe(IpcEvent.apiStatusChanged, cb),
  },
  updates: {
    state: () => invoke(IpcInvoke.updatesState),
    check: () => invoke(IpcInvoke.updatesCheck),
    download: () => invoke(IpcInvoke.updatesDownload),
    install: () => invoke(IpcInvoke.updatesInstall),
    releases: () => invoke(IpcInvoke.updatesReleases),
    onChanged: (cb) => subscribe(IpcEvent.updatesChanged, cb),
    onShow: (cb) => subscribe(IpcEvent.updatesShow, cb),
  },
}

contextBridge.exposeInMainWorld('api', api)
