import { homedir, release } from 'node:os'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { IpcEvent } from '@shared/ipc'
import type { AppInfo } from '@shared/types'
import { ApiServer } from './api/api-server'
import { AppTools } from './browser/app-tools'
import { BrowserControl } from './browser/browser-control'
import { BrowserTools } from './browser/browser-tools'
import { BrowserMcpServer } from './browser/mcp-server'
import { CommandIntegration } from './cli/command-integration'
import { isLaunchRequest, readLaunchRequest, resolveLaunch, type LaunchRequest } from './cli/launch'
import type { AppContext } from './context'
import { announceQuitting, forwardWindowState, registerApiIpc, registerIpc } from './ipc'
import { takeJsonProblems } from './lib/json-file'
import { linuxPackage } from './lib/linux'
import { AUTOSTART_ARG, setLaunchAtLogin } from './lib/login-item'
import { selectLinuxPasswordStore } from './lib/secrets'
import { fallbackSessionFolder } from './lib/session-folder'
import { loadShellEnv } from './lib/shell-env'
import { AccountService } from './services/account-service'
import { SessionPrompt } from './services/app-context'
import { ClaudeCli } from './services/claude-cli'
import { CswapImport } from './services/cswap-import'
import { FileTreeService } from './services/file-tree-service'
import { GitService } from './services/git-service'
import { IndexerClient } from './services/indexer-client'
import { NotificationService } from './services/notification-service'
import { LoginProfiles } from './services/login-profiles'
import { AutoSwitch } from './services/auto-switch'
import { SessionHandoff } from './services/session-handoff'
import { SessionHooks } from './services/session-hooks'
import { SessionServer } from './services/session-server'
import { SessionNames } from './services/session-names'
import { SessionService } from './services/session-service'
import { SettingsService } from './services/settings-service'
import { TerminalRestore } from './services/terminal-restore'
import { TerminalService } from './services/terminal-service'
import { UpdateService } from './services/update-service'
import { UsageService } from './services/usage-service'
import { ThemeService } from './services/theme-service'
import { WorkspaceService } from './services/workspace-service'
import { WorkspaceTrust } from './services/workspace-trust'
import { WindowDialogs } from './window/dialogs'
import { createMainWindow, openAppWindows, revealWindow } from './window/main-window'
import { WindowMaterialController } from './window/material'
import { AppTray } from './window/tray'

app.setName('Claude Manager')
// Development builds get their own profile. With the installed app's profile they would fail to get
// the single instance lock while it runs (and hand over to it), and Chromium's caches would collide.
if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Claude Manager Dev'))
// The appId of electron-builder.yml: the installer gives the shortcuts this ID, and Windows only
// shows notifications (and groups the taskbar button with the pinned one) when they match.
if (process.platform === 'win32') app.setAppUserModelId('local.claude-manager')
selectLinuxPasswordStore()

// Started through the `cm` command: a running instance takes the request over.
const launchRequest = readLaunchRequest(process.argv)

if (!app.requestSingleInstanceLock(launchRequest ? { ...launchRequest } : undefined)) {
  app.quit()
} else {
  // Linux: the PATH & co. of the user's shell, read while Electron starts up (see shell-env.ts).
  void bootstrap(launchRequest, loadShellEnv())
}

async function bootstrap(launchRequest: LaunchRequest | null, shellEnv: Promise<void>): Promise<void> {
  await Promise.all([app.whenReady(), shellEnv])
  const userDataDir = app.getPath('userData')

  const userAgent = `claude-manager/${app.getVersion()}`
  const settings = new SettingsService(userDataDir)
  const accounts = new AccountService(userDataDir, new LoginProfiles(userDataDir, userAgent))
  await accounts.init()
  const cli = new ClaudeCli(() => settings.get().claude.executablePath)
  // Known before the first session starts, for the options that depend on it (see SessionPrompt).
  void cli.version()
  const indexer = new IndexerClient(userDataDir)
  const dialogs = new WindowDialogs()
  let mainWindow: BrowserWindow | null = null
  // Claude Code's question whether to trust a folder comes up in the app, before the session starts.
  const trust = new WorkspaceTrust(accounts, async (options) => {
    const win = mainWindow
    return win && !win.isDestroyed() ? dialogs.show(win, options) : null
  })
  // The names the user gave sessions: tabs, the session list and the API show them.
  const sessionNames = new SessionNames(userDataDir)
  sessionNames.init()
  const terminals = new TerminalService(accounts, cli, settings, trust, sessionNames)
  const workspaces = new WorkspaceService(userDataDir)
  workspaces.init()
  const themes = new ThemeService(userDataDir, (path) => shell.trashItem(path))
  themes.init()
  // Claude sessions learn that they run in the app, without the user seeing it (setting `appContext`),
  // and get the prompts of the workspaces they work in.
  terminals.addSessionArgs(new SessionPrompt(userDataDir, cli, settings, workspaces))
  const browser = new BrowserControl(terminals)
  // Claude sessions the app starts reach the app over its server: the browser's MCP server and their
  // hooks, before the tabs are restored. Without the server they start without both.
  const sessionServer = new SessionServer()
  await sessionServer.start().catch((error) => console.error('[session-server] server could not start', error))
  const browserMcp = new BrowserMcpServer(sessionServer, userDataDir, settings, new BrowserTools(browser), app.getVersion())
  browserMcp.init()
  terminals.addSessionArgs(browserMcp)
  const files = new FileTreeService()
  // Sessions tell their state through Claude Code's hooks (setting `hookState`), and which files Claude touches.
  const sessionHooks = new SessionHooks(sessionServer, userDataDir, settings, (id, call) => {
    terminals.applyHook(id, call)
    // A new turn, or the end of one, ends the shell commands still taken for running (Esc ends one silently).
    const event = call.event
    if (event.kind === 'prompt' || event.kind === 'failure' || (event.kind === 'stop' && !event.background)) files.endShells(id)
    if (call.files) files.activity(id, call.files)
  })
  sessionHooks.init()
  terminals.addSessionArgs(sessionHooks)
  const sessions = new SessionService(accounts, indexer, terminals, sessionNames)
  sessions.init()
  const handoff = new SessionHandoff(accounts, sessions, terminals, settings)
  const usage = new UsageService(accounts, settings, indexer, userDataDir, userAgent)
  await usage.init()
  // The server's tools for the app itself (limits, earlier sessions, themes, shells), before the tabs are restored.
  // A session started with tools allowed without asking: once that is switched off, the app asks.
  browserMcp.setAsk((options) => trust.ask(options))
  browserMcp.setAppTools(new AppTools({ terminals, usage, sessions, accounts, settings, themes }))
  const autoSwitch = new AutoSwitch(accounts, terminals, usage, settings, handoff)
  autoSwitch.init()
  const git = new GitService()
  const command = new CommandIntegration(userDataDir)
  void command.init()
  const updates = new UpdateService(userAgent)
  updates.init()
  const notifications = new NotificationService(terminals, accounts, usage, settings, userDataDir, () => mainWindow, {
    terminal: (id) => showTerminal(id),
    usage: () => showUsage(),
  })
  await notifications.init()
  notifications.watchAutoSwitch(autoSwitch)

  settings.on('changed', (next, previous) => {
    if (next.claude.executablePath !== previous.claude.executablePath) {
      cli.invalidate()
      void cli.version()
    }
  })

  const ctx: AppContext = {
    userDataDir,
    settings,
    accounts,
    cswap: new CswapImport(accounts),
    cli,
    indexer,
    terminals,
    browser,
    sessions,
    handoff,
    autoSwitch,
    usage,
    notifications,
    git,
    files,
    command,
    updates,
    workspaces,
    themes,
    trust,
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
        fallbackCwd: fallbackSessionFolder(),
        claudeExecutable: cli.resolve(),
        claudeVersion: (await Promise.all([cli.version(), cli.checkLoginEmail()]))[0],
        windowsBuild: process.platform === 'win32' ? Number(release().split('.')[2]) || null : null,
        linuxPackage: linuxPackage(),
        packaged: app.isPackaged,
      }
    },
  }
  registerIpc(ctx)
  // Runs while the window loads; its tabs appear as soon as they are open.
  const restore = new TerminalRestore(userDataDir, terminals, accounts, settings)
  const restored = restore.init().catch((error) => console.error('[restore] tabs could not be restored', error))

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
      if (asking) return revealWindow(win, { steal: true })
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

  /** Brings the window to the front with the usage page (a warning about a limit was clicked). */
  const showUsage = () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    revealWindow(win)
    win.webContents.send(IpcEvent.usageShow)
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
      const id = existing?.id ?? (await terminals.open(options))?.id
      if (id) showTerminal(id)
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
    // The taskbar button flashes after a turn (NotificationService) until the window is in front.
    win.on('focus', () => {
      win.flashFrame(false)
      notifications.windowFocused()
    })
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

  // Started by the system at login: with the tray icon the window stays hidden until it is opened.
  const startHidden = process.argv.includes(AUTOSTART_ARG) && tray.visible
  const firstWindow = openWindow({ hidden: startHidden })
  // Accounts, settings … that were broken or locked at the start: the user learns what the app did.
  const problems = takeJsonProblems()
  if (problems.length > 0) {
    void dialogs.show(firstWindow, {
      kind: 'alert',
      warning: true,
      title: problems.length === 1 ? 'Eine Datei der App war nicht in Ordnung' : 'Dateien der App waren nicht in Ordnung',
      description: problems.map((problem) => problem.message).join('\n\n'),
      code: dirname(problems[0].file),
    })
  }
  // Tabs of the last run that didn't open: the user learns why and can try again right away. A window
  // hidden in the tray stays hidden; those tabs come again on the next start.
  void restored.then(async () => {
    let failures = restore.takeFailures()
    while (failures.length > 0 && !startHidden && !firstWindow.isDestroyed()) {
      await dialogs.whenReady(firstWindow)
      const again = failures.some((failure) => failure.kept)
      const retry = await dialogs.show(firstWindow, {
        kind: again ? 'confirm' : 'alert',
        warning: true,
        title: failures.length === 1 ? 'Ein Tab vom letzten Mal ging nicht auf' : `${failures.length} Tabs vom letzten Mal gingen nicht auf`,
        description: again
          ? 'Die App versucht es beim nächsten Start noch einmal, oder jetzt gleich.'
          : 'Sie gingen schon bei mehreren Starts nicht auf, die App versucht es nicht mehr.',
        code: failures.map((failure) => `${failure.title}: ${failure.reason}${failure.kept ? '' : ' (aufgegeben)'}`).join('\n'),
        confirmText: again ? 'Erneut versuchen' : 'OK',
        cancelText: 'Später',
      })
      if (!again || !retry) break
      failures = await restore.retry()
    }
  })
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
    if (openAppWindows().length === 0) openWindow()
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
    // Before the tabs close, otherwise an empty list would be remembered (here and in the window).
    restore.dispose()
    announceQuitting()
    terminals.disposeAll()
    browserMcp.dispose()
    sessionHooks.dispose()
    sessionServer.dispose()
    usage.dispose()
    workspaces.dispose()
    themes.dispose()
    git.dispose()
    files.dispose()
    sessions.dispose()
    accounts.dispose()
    indexer.dispose()
  })
}
