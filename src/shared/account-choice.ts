import type { Account, AccountUsage, UsageWindow } from './types'
import { canLendCredentials, sameLogin } from './utils'

/** An account known to be at a limit, e.g. because a tab stopped there; until `resetsAt` (null: not known). */
export interface BlockedAccount {
  accountId: string
  resetsAt: string | null
}

/** What is known about an account taking over a session, for the hint next to it. */
export type AccountStanding =
  | { kind: 'logged-out' }
  /** A session stopped at its limit, with this account or another one with the same login. */
  | { kind: 'blocked'; resetsAt: string | null }
  /** API keys have no limits, they cost per use. */
  | { kind: 'pay-per-use' }
  /** The fuller of the 5-hour and the weekly window. */
  | { kind: 'usage'; label: string; percent: number }
  | { kind: 'unknown' }

export interface AccountChoice {
  account: Account
  standing: AccountStanding
  /** Known to be at a limit right now. */
  limited: boolean
  /** Not logged in, so it can't take over. */
  disabled: boolean
  /** A browser login: the session is copied to this account instead of borrowing its key. */
  copies: boolean
}

export interface AccountChoiceContext {
  accounts: readonly Account[]
  usage: (accountId: string) => AccountUsage | undefined
  blocked: readonly BlockedAccount[]
  now: number
}

function standing(account: Account, context: AccountChoiceContext): AccountStanding {
  if (account.authState === 'missing') return { kind: 'logged-out' }

  // A session that stopped at a limit is the most precise source (also for tokens). Accounts with the
  // same login share their limits, e.g. the standard account and its twin from cswap.
  const block = context.blocked.find((b) => {
    if (b.resetsAt && Date.parse(b.resetsAt) <= context.now) return false
    if (b.accountId === account.id) return true
    const other = context.accounts.find((a) => a.id === b.accountId)
    return !!other && sameLogin(other.identity, account.identity)
  })
  if (block) return { kind: 'blocked', resetsAt: block.resetsAt }
  if (account.kind === 'apiKey') return { kind: 'pay-per-use' }

  const usage = context.usage(account.id)
  // No credentials, or a long-lived token Anthropic refused (revoked): a session with it wouldn't start.
  if (usage?.status === 'no-credentials' || (account.kind === 'token' && usage?.status === 'unauthorized')) return { kind: 'logged-out' }
  // Also the numbers of the last query that worked, when the latest failed (offline, the usage API
  // busy): a window that was full stays full until it resets.
  const windows = [
    { label: '5 Std.', percent: percentNow(usage?.fiveHour, context.now) },
    { label: 'Woche', percent: percentNow(usage?.sevenDay, context.now) },
  ].filter((w): w is { label: string; percent: number } => w.percent !== null)
  if (windows.length === 0) return { kind: 'unknown' }
  const top = windows.reduce((a, b) => (b.percent > a.percent ? b : a))
  return { kind: 'usage', label: top.label, percent: Math.max(0, Math.min(100, Math.round(top.percent))) }
}

/** How full a window is now: one that has reset since is empty. */
function percentNow(window: UsageWindow | null | undefined, now: number): number | null {
  if (!window) return null
  return window.resetsAt && Date.parse(window.resetsAt) <= now ? 0 : window.percent
}

/**
 * Accounts a session could continue with, except the one it runs with now. Accounts that take
 * over without copying the session come first, then browser logins; accounts at their limit or
 * not logged in go last. Within each group the account order stays.
 */
export function accountChoices(
  context: AccountChoiceContext,
  sessionAccountId: string,
  currentAccountId: string,
): AccountChoice[] {
  const list = context.accounts
    .filter((account) => account.id !== currentAccountId)
    .map((account): AccountChoice => {
      const s = standing(account, context)
      return {
        account,
        standing: s,
        limited: s.kind === 'blocked' || (s.kind === 'usage' && s.percent >= 100),
        disabled: s.kind === 'logged-out',
        copies: account.id !== sessionAccountId && !canLendCredentials(account.kind),
      }
    })
  const rank = (c: AccountChoice) => (c.limited || c.disabled ? 2 : c.copies ? 1 : 0)
  return [0, 1, 2].flatMap((r) => list.filter((c) => rank(c) === r))
}

/** The account to continue with: the first one that is logged in and not at a limit. */
export function suggestedChoice(choices: readonly AccountChoice[]): AccountChoice | undefined {
  return choices.find((c) => !c.limited && !c.disabled)
}
