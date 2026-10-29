import type { CommandIntegration } from './cli/command-integration'
import type { AccountService } from './services/account-service'
import type { ClaudeCli } from './services/claude-cli'
import type { CswapImport } from './services/cswap-import'
import type { IndexerClient } from './services/indexer-client'
import type { SessionHandoff } from './services/session-handoff'
import type { SessionService } from './services/session-service'
import type { SettingsService } from './services/settings-service'
import type { TerminalService } from './services/terminal-service'
import type { UsageService } from './services/usage-service'
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
  sessions: SessionService
  /** Continuing sessions with another account's limits. */
  handoff: SessionHandoff
  usage: UsageService
  command: CommandIntegration
  appInfo(): Promise<AppInfo>
}
