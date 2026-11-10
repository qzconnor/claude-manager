import type { BrowserControl } from './browser/browser-control'
import type { CommandIntegration } from './cli/command-integration'
import type { AccountService } from './services/account-service'
import type { AutoSwitch } from './services/auto-switch'
import type { ClaudeCli } from './services/claude-cli'
import type { CswapImport } from './services/cswap-import'
import type { FileTreeService } from './services/file-tree-service'
import type { GitService } from './services/git-service'
import type { IndexerClient } from './services/indexer-client'
import type { NotificationService } from './services/notification-service'
import type { SessionHandoff } from './services/session-handoff'
import type { SessionService } from './services/session-service'
import type { SettingsService } from './services/settings-service'
import type { TerminalService } from './services/terminal-service'
import type { UpdateService } from './services/update-service'
import type { UsageService } from './services/usage-service'
import type { WorkspaceService } from './services/workspace-service'
import type { WorkspaceTrust } from './services/workspace-trust'
import type { AppInfo } from '@shared/types'

/** All services of the app — shared by the IPC layer and the local HTTP API. */
export interface AppContext {
  userDataDir: string
  settings: SettingsService
  accounts: AccountService
  /** Taking accounts over from claude-swap. */
  cswap: CswapImport
  cli: ClaudeCli
  indexer: IndexerClient
  terminals: TerminalService
  /** The browser tabs Claude sessions drive through the app's MCP server. */
  browser: BrowserControl
  sessions: SessionService
  /** Continuing sessions with another account's limits. */
  handoff: SessionHandoff
  /** Continues sessions at a limit with another account by themselves (setting `claude.autoSwitch`). */
  autoSwitch: AutoSwitch
  usage: UsageService
  /** Notifications, the flashing taskbar and the unread dot of tabs. */
  notifications: NotificationService
  /** Branch of the repository a terminal works in, for the title bar. */
  git: GitService
  /** Folders, git status and changes for the file tree of the tabs. */
  files: FileTreeService
  command: CommandIntegration
  /** App updates from the GitHub releases. */
  updates: UpdateService
  /** Folders whose projects share a system prompt (`cm_prompts.md`). */
  workspaces: WorkspaceService
  /** Claude Code's trust in folders, asked in the app before a session starts. */
  trust: WorkspaceTrust
  appInfo(): Promise<AppInfo>
}
