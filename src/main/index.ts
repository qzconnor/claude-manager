import { homedir, release } from 'node:os'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { IpcEvent } from '@shared/ipc'
import type { AppInfo } from '@shared/types'
import { ApiServer } from './api/api-server'
import { CommandIntegration } from './cli/command-integration'
import { isLaunchRequest, readLaunchRequest, resolveLaunch, type LaunchRequest } from './cli/launch'
import type { AppContext } from './context'
import { forwardWindowState, registerApiIpc, registerIpc } from './ipc'
import { AccountService } from './services/account-service'
import { ClaudeCli } from './services/claude-cli'
import { CswapImport } from './services/cswap-import'
import { IndexerClient } from './services/indexer-client'
import { LoginProfiles } from './services/login-profiles'
import { SessionHandoff } from './services/session-handoff'
import { SessionService } from './services/session-service'
import { SettingsService } from './services/settings-service'
import { TerminalService } from './services/terminal-service'
import { UsageService } from './services/usage-service'
import { WindowDialogs } from './window/dialogs'
import { createMainWindow, revealWindow } from './window/main-window'
import { WindowMaterialController } from './window/material'

app.setName('Claude Manager')
if (process.platform === 'win32') app.setAppUserModelId('de.claude-manager.app')

// Started through the `cm` command: a running instance takes the request over.
const launchRequest = readLaunchRequest(process.argv)

if (!app.requestSingleInstanceLock(launchRequest ? { ...launchRequest } : undefined)) {
  app.quit()
} else {
  void bootstrap(launchRequest)
}

async function bootstrap(launchRequest: LaunchRequest | null): Promise<void> {
  await app.whenReady()
  const userDataDir = app.getPath('userData')

  const userAgent = `claude-manager/${app.getVersion()}`
  const settings = new SettingsService(userDataDir)
  const accounts = new AccountService(userDataDir, new LoginProfiles(userDataDir, userAgent))
  await accounts.init()
  const cli = new ClaudeCli(() => settings.get().claude.executablePath)
  const indexer = new IndexerClient(userDataDir)
  const terminals = new TerminalService(accounts, cli, settings)
  const sessions = new SessionService(accounts, indexer)
  sessions.init()
  const handoff = new SessionHandoff(accounts, sessions, terminals, settings)
  const usage = new UsageService(accounts, settings, indexer, userDataDir, userAgent)
  await usage.init()
  const command = new CommandIntegration()

  settings.on('changed', (next, previous) => {
    if (next.claude.executablePath !== previous.claude.executablePath) cli.invalidate()
  })

  const ctx: AppContext = {
    userDataDir,
    settings,
    accounts,
    cswap: new CswapImport(accounts),
    cli,
    indexer,
    terminals,
    sessions,
    handoff,
    usage,
    command,
    async appInfo(): Promise<AppInfo> {
      return {
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        userDataDir,
        homeDir: homedir(),
        claudeExecutable: cli.resolve(),
        claudeVersion: (await Promise.all([cli.version(), cli.checkLoginEmail()]))[0],
        windowsBuild: process.platform === 'win32' ? Number(release().split('.')[2]) || null : null,
      }
    },
  }
  registerIpc(ctx)
  const dialogs = new WindowDialogs()

  let mainWindow: BrowserWindow | null = null

  /** Brings the window to the front and selects the terminal's tab. */
  const showTerminal = (id: string) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    revealWindow(win)
    win.webContents.send(IpcEvent.terminalActivate, id)
  }

  /** `cm` typed in a terminal or the Explorer address bar (src/launcher/cm.cs). */
  const openFromCommandLine = (request: LaunchRequest) => {
    try {
      const options = resolveLaunch(request, accounts.list(), settings.get().general.defaultAccountId)
      showTerminal(terminals.create(options).id)
    } catch (error) {
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      void dialogs.show(win, {
        kind: 'alert',
        warning: true,
        title: '„cm“ konnte keine Session öffnen',
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const api = new ApiServer(ctx, {
    version: app.getVersion(),
    activateTerminal: showTerminal,
  })
  registerApiIpc(api)
  await api.init()
  const openWindow = (): BrowserWindow => {
    const win = createMainWindow(settings.get(), userDataDir)
    const material = new WindowMaterialController(win)
    const applyAppearance = () => {
      const { appearance } = settings.get()
      void material.apply(appearance.material, appearance.keepMaterialWhenInactive)
    }
    applyAppearance()
    const off = settings.on('changed', (next, previous) => {
      if (
        next.appearance.material !== previous.appearance.material ||
        next.appearance.keepMaterialWhenInactive !== previous.appearance.keepMaterialWhenInactive
      ) {
        applyAppearance()
      }
    })
    forwardWindowState(win)

    let confirmedClose = false
    let asking = false
    win.on('close', (event) => {
      if (confirmedClose || !settings.get().general.confirmCloseRunning) return
      const running = terminals.runningCount()
      if (running === 0) return
      event.preventDefault()
      // Closing again while the question is open (e.g. from the taskbar) only brings it back.
      if (asking) return revealWindow(win)
      asking = true
      void dialogs
        .show(win, {
          title: 'Claude Manager beenden?',
          description:
            running === 1
              ? 'Es läuft noch 1 Terminal. Es wird beim Beenden geschlossen, Claude-Code-Sessions lassen sich später über „Sessions“ fortsetzen.'
              : `Es laufen noch ${running} Terminals. Sie werden beim Beenden geschlossen, Claude-Code-Sessions lassen sich später über „Sessions“ fortsetzen.`,
          confirmText: 'Beenden',
          destructive: true,
        })
        .then((confirmed) => {
          asking = false
          if (!confirmed || win.isDestroyed()) return
          confirmedClose = true
          win.close()
        })
    })
    win.on('closed', () => {
      off()
      if (mainWindow === win) mainWindow = null
    })
    mainWindow = win
    return win
  }

  // Dark/light of the native backdrop follows the app theme (set by the renderer via settings).
  nativeTheme.themeSource = 'dark'

  const firstWindow = openWindow()
  if (launchRequest) {
    // Wait for the page so it can select the new tab.
    firstWindow.webContents.once('did-finish-load', () => openFromCommandLine(launchRequest))
  }

  app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
    if (!mainWindow) openWindow()
    else revealWindow(mainWindow)
    if (isLaunchRequest(additionalData)) openFromCommandLine(additionalData)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    api.dispose()
    terminals.disposeAll()
    usage.dispose()
    sessions.dispose()
    accounts.dispose()
    indexer.dispose()
  })
}
