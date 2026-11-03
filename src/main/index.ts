import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { IpcEvent } from '@shared/ipc'
import type { AppInfo } from '@shared/types'
import { ApiServer } from './api/api-server'
import { CommandIntegration } from './cli/command-integration'
import { isLaunchRequest, readLaunchRequest, resolveLaunch, type LaunchRequest } from './cli/launch'
import type { AppContext } from './context'
import { forwardWindowState, registerApiIpc, registerIpc } from './ipc'
import { AUTOSTART_ARG, setLaunchAtLogin } from './lib/login-item'
import { AccountService } from './services/account-service'
import { ClaudeCli } from './services/claude-cli'
import { CswapImport } from './services/cswap-import'
import { GitService } from './services/git-service'
import { IndexerClient } from './services/indexer-client'
import { LoginProfiles } from './services/login-profiles'
import { SessionHandoff } from './services/session-handoff'
import { SessionService } from './services/session-service'
import { SettingsService } from './services/settings-service'
import { TerminalRestore } from './services/terminal-restore'
import { TerminalService } from './services/terminal-service'
import { UpdateService } from './services/update-service'
import { UsageService } from './services/usage-service'
import { WindowDialogs } from './window/dialogs'
import { createMainWindow, revealWindow } from './window/main-window'
import { WindowMaterialController } from './window/material'
import { AppTray } from './window/tray'

app.setName('Claude Manager')
// Development builds get their own profile. With the installed app's profile they would fail to get
// the single instance lock while it runs (and hand over to it), and Chromium's caches would collide.
if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Claude Manager Dev'))
// The appId of electron-builder.yml: the installer gives the shortcuts this ID, and Windows only
// shows notifications (and groups the taskbar button with the pinned one) when they match.
if (process.platform === 'win32') app.setAppUserModelId('local.claude-manager')

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
  const git = new GitService()
  const command = new CommandIntegration()
  const updates = new UpdateService(userAgent)
  updates.init()

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
    git,
    command,
    updates,
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
        packaged: app.isPackaged,
      }
    },
  }
  registerIpc(ctx)
  const dialogs = new WindowDialogs()
  // Runs while the window loads; its tabs appear as soon as they are open.
  const restore = new TerminalRestore(userDataDir, terminals, accounts, settings)
  const restored = restore.init().catch((error) => console.error('[restore] tabs could not be restored', error))

  let mainWindow: BrowserWindow | null = null
  /** The app is quitting: the window really closes instead of going to the tray. */
  let quitting = false

  /** Brings the window to the front, also out of the tray. */
  const showWindow = () => {
    if (mainWindow) revealWindow(mainWindow)
    else openWindow()
  }

  let asking = false
  /** Ends the app, after asking about running terminals (setting `confirmCloseRunning`). */
  const quit = async (): Promise<void> => {
    const win = mainWindow
    const running = terminals.runningCount()
    if (win && !win.isDestroyed() && running > 0 && settings.get().general.confirmCloseRunning) {
      // Quitting again while the question is open (e.g. from the taskbar) only brings it back.
      if (asking) return revealWindow(win)
      asking = true
      const confirmed = await dialogs
        .show(win, {
          title: 'Claude Manager beenden?',
          description:
            running === 1
              ? 'Es läuft noch 1 Terminal. Es wird beim Beenden geschlossen, Claude-Code-Sessions lassen sich später über „Sessions“ fortsetzen.'
              : `Es laufen noch ${running} Terminals. Sie werden beim Beenden geschlossen, Claude-Code-Sessions lassen sich später über „Sessions“ fortsetzen.`,
          confirmText: 'Beenden',
          destructive: true,
        })
        .finally(() => (asking = false))
      if (!confirmed) return
    }
    quitting = true
    app.quit()
  }

  const tray = new AppTray({ open: showWindow, quit: () => void quit() })

  /** Brings the window to the front and selects the terminal's tab. */
  const showTerminal = (id: string) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    revealWindow(win)
    win.webContents.send(IpcEvent.terminalActivate, id)
  }

  /**
   * `cm` typed in a terminal or the Explorer address bar (src/launcher/cm.cs). A tab that already
   * shows the folder is only selected, also one restored from the last run.
   */
  const openFromCommandLine = async (request: LaunchRequest) => {
    await restored
    try {
      const { general } = settings.get()
      const { options, existing } = resolveLaunch(
        request,
        accounts.list(),
        general.defaultAccountId,
        general.cmReuseTab ? terminals.list() : [],
      )
      showTerminal(existing?.id ?? terminals.create(options).id)
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
  const openWindow = ({ hidden = false } = {}): BrowserWindow => {
    const win = createMainWindow(settings.get(), userDataDir, { hidden })
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
    // The taskbar button flashes after a turn (see below) until the window is in front.
    win.on('focus', () => win.flashFrame(false))
    // Windows is shutting down or logging off: the window must not hold it back.
    win.on('session-end', () => (quitting = true))

    win.on('close', (event) => {
      // Asked already, or the page has asked before installing an update.
      if (quitting || updates.installing) return
      event.preventDefault()
      // With the tray icon the window only hides: terminals and the API keep running.
      if (tray.visible) win.hide()
      else void quit()
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

  tray.set(settings.get().general.runInTray)
  setLaunchAtLogin(settings.get().general.launchAtLogin, true)
  settings.on('changed', (next, previous) => {
    if (next.general.launchAtLogin !== previous.general.launchAtLogin) setLaunchAtLogin(next.general.launchAtLogin)
    if (next.general.runInTray !== previous.general.runInTray) {
      tray.set(next.general.runInTray)
      // Without the icon a hidden window could not be opened again.
      if (!tray.visible && mainWindow && !mainWindow.isVisible()) revealWindow(mainWindow)
    }
  })

  // Claude Code is done or waits for the user: draw attention when the window is in the background.
  terminals.on('turnEnded', () => {
    const win = mainWindow
    if (!win || win.isDestroyed() || win.isFocused() || !settings.get().general.flashOnTurnEnd) return
    win.flashFrame(true)
  })

  // Started by Windows at login: with the tray icon the window stays hidden until it is opened.
  const firstWindow = openWindow({ hidden: process.argv.includes(AUTOSTART_ARG) && tray.visible })
  if (launchRequest) {
    // Wait for the page so it can select the new tab.
    firstWindow.webContents.once('did-finish-load', () => void openFromCommandLine(launchRequest))
  }

  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    // A start at login while the app already runs changes nothing.
    if (argv.includes(AUTOSTART_ARG)) return
    showWindow()
    if (isLaunchRequest(additionalData)) void openFromCommandLine(additionalData)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  app.on('window-all-closed', () => {
    // With the tray icon the app keeps running and opens a new window from there.
    if (!tray.visible) app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    tray.dispose()
    updates.dispose()
    api.dispose()
    // Before the tabs close, otherwise an empty list would be remembered.
    restore.dispose()
    terminals.disposeAll()
    usage.dispose()
    git.dispose()
    sessions.dispose()
    accounts.dispose()
    indexer.dispose()
  })
}
