import { lastingArgs } from '@shared/claude-args'
import type { TerminalCreateOptions, TerminalInfo } from '@shared/types'

/** How many closed tabs „Geschlossenen Tab wieder öffnen“ remembers. */
export const MAX_CLOSED_TABS = 10

/** What it takes to open a closed session or shell again. Browsers and logins aren't remembered. */
export interface ClosedTab {
  /** The id the tab had, to tell the entries apart. */
  id: string
  mode: 'session' | 'shell'
  accountId: string
  authAccountId: string
  cwd: string
  /** The session goes on with its conversation; null for a shell or one that had none yet. */
  sessionId: string | null
  title: string
  fixedTitle: boolean
  muted: boolean
  args: string[]
  closedAt: number
}

/** The entry for a terminal that is closed; null for what can't be opened again (browser, login). */
export function closedTabOf(terminal: TerminalInfo, now = Date.now()): ClosedTab | null {
  if (terminal.mode !== 'session' && terminal.mode !== 'shell') return null
  // Claude Code writes the transcript with the first message: before that there is nothing to resume.
  const written = terminal.mode === 'session' && (terminal.context !== null || terminal.resumeSessionId !== null)
  return {
    id: terminal.id,
    mode: terminal.mode,
    accountId: terminal.accountId,
    authAccountId: terminal.authAccountId,
    // For a session in a worktree the folder it was started in: Claude Code enters the worktree again.
    cwd: terminal.cwd,
    sessionId: written ? terminal.sessionId : null,
    title: terminal.title,
    fixedTitle: terminal.fixedTitle,
    muted: terminal.muted,
    args: lastingArgs(terminal.args),
    closedAt: now,
  }
}

/** The list with `entry` first; an older entry of the same session goes, the oldest beyond the limit too. */
export function rememberClosed(list: readonly ClosedTab[], entry: ClosedTab): ClosedTab[] {
  const same = (other: ClosedTab) => other.id === entry.id || (entry.sessionId !== null && other.sessionId === entry.sessionId)
  return [entry, ...list.filter((other) => !same(other))].slice(0, MAX_CLOSED_TABS)
}

/** How to open the tab again; null when its account is gone. Without the lending account it runs with its own login. */
export function reopenOptions(entry: ClosedTab, accountIds: ReadonlySet<string>): TerminalCreateOptions | null {
  if (!accountIds.has(entry.accountId)) return null
  return {
    accountId: entry.accountId,
    authAccountId: entry.authAccountId !== entry.accountId && accountIds.has(entry.authAccountId) ? entry.authAccountId : null,
    cwd: entry.cwd,
    mode: entry.mode,
    resumeSessionId: entry.sessionId,
    args: entry.mode === 'session' ? entry.args : undefined,
    title: entry.fixedTitle ? entry.title : null,
    muted: entry.muted,
  }
}
