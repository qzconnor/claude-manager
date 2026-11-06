import type { Account, ClaudeInChromeStatus } from '@shared/types'
import type { ClaudePaths } from '../lib/claude-paths'
import { readGlobalConfig, type GlobalConfig } from '../services/account-service'

/**
 * Whether Claude Code connects a new session to Claude in Chrome by itself, as it decides without
 * `--chrome`/`--no-chrome`: CLAUDE_CODE_ENABLE_CFC first, then "Enabled by default" in the global config.
 * Claude in Chrome needs a claude.ai login, so token and API key accounts never connect.
 */
export function connectsClaudeInChrome(account: Pick<Account, 'kind'>, config: GlobalConfig | null): boolean {
  if (account.kind !== 'system' && account.kind !== 'oauth') return false
  return config?.claudeInChromeDefaultEnabled === true
}

/** Claude Code's reading of a boolean environment variable; undefined when it says neither. */
export function envFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return undefined
}

interface AccountSource {
  list(): Account[]
  paths(id: string): ClaudePaths
}

/** Which of the user's accounts start their sessions with Claude in Chrome. */
export function claudeInChromeStatus(accounts: AccountSource, env: NodeJS.ProcessEnv = process.env): ClaudeInChromeStatus {
  const forced = envFlag(env.CLAUDE_CODE_ENABLE_CFC)
  if (forced !== undefined) return { accounts: [], env: forced }
  const names = accounts
    .list()
    .filter((account) => connectsClaudeInChrome(account, readGlobalConfig(accounts.paths(account.id).globalConfigFile)))
    .map((account) => ({ id: account.id, name: account.name }))
  return { accounts: names, env: false }
}
