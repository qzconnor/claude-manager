import { toast } from 'vue-sonner'
import { useRouter } from 'vue-router'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { SessionSummary, SplitDirection, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { reopenOptions, type ClosedTab } from '@/lib/closed-tabs'
import { toastError } from '@/lib/errors'
import { sessionFolder } from '@/lib/session-tree'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

/** Starting Claude Code in a new tab — the single entry point used by all views. */
export function useLauncher() {
  const router = useRouter()
  const terminals = useTerminalsStore()
  const accounts = useAccountsStore()
  const settings = useSettingsStore()
  const ui = useUiStore()

  function defaultAccountId(): string {
    const preferred = settings.settings.general.defaultAccountId
    return accounts.get(preferred) ? preferred : SYSTEM_ACCOUNT_ID
  }

  async function launch(options: TerminalCreateOptions): Promise<TerminalInfo | undefined> {
    try {
      const info = await terminals.open(options)
      // Without trust in the folder no tab opens.
      if (!info) return undefined
      if (router.currentRoute.value.name !== 'terminals') await router.push({ name: 'terminals' })
      return info
    } catch (error) {
      toastError(error, 'Terminal konnte nicht gestartet werden')
      return undefined
    }
  }

  /**
   * Splits the part of `from` in its tab (in groups: a new group beside its group): the new terminal
   * comes to the right (`row`) or below (`column`) and runs like `from`, a new session or a shell with
   * the same account in the same folder. A browser passes on the terminal beside it. Next to a login or
   * a lone browser, a new session of the default account starts.
   */
  function split(from: TerminalInfo, direction: SplitDirection) {
    const split = { terminalId: from.id, direction }
    const like = terminals.workingTerminalOf(from)
    if (!like || like.mode === 'login') return launch({ accountId: defaultAccountId(), split })
    return launch({
      accountId: like.accountId,
      authAccountId: like.authAccountId,
      // Next to a session in a worktree, in the worktree.
      cwd: like.worktree?.path ?? like.cwd,
      mode: like.mode === 'shell' ? 'shell' : 'session',
      split,
    })
  }

  /** A browser in a new tab, or next to a terminal (`split`); the empty page asks for an address. */
  async function browser(url?: string | null, split?: TerminalCreateOptions['split']) {
    try {
      const info = await terminals.openBrowser({ url, split })
      if (router.currentRoute.value.name !== 'terminals') await router.push({ name: 'terminals' })
      return info
    } catch (error) {
      toastError(error, 'Browser konnte nicht geöffnet werden')
      return undefined
    }
  }

  /**
   * Opens a closed tab again (by default the one closed last): a session goes on with its
   * conversation. The entry stays in the list until its tab is open again.
   */
  async function reopen(entry: ClosedTab | undefined = terminals.recentlyClosed[0]) {
    if (!entry) return undefined
    const options = reopenOptions(entry, new Set(accounts.accounts.map((a) => a.id)))
    if (!options) {
      terminals.forgetClosed(entry.id)
      toast.error(`„${entry.title}“ lässt sich nicht wieder öffnen`, { description: 'Sein Account ist nicht mehr da.' })
      return undefined
    }
    const info = await launch(options)
    if (info) terminals.forgetClosed(entry.id)
    return info
  }

  return {
    defaultAccountId,
    launch,
    split,
    browser,
    reopen,
    /**
     * With the tabs in groups, the browser tab with the pages of the session of `terminal` (for a page,
     * the session it belongs to); without pages it asks for an address. Nothing without a session: with
     * the tabs in groups a browser always belongs to one.
     */
    browserFor(terminal: TerminalInfo | null) {
      const session = terminals.sessionFor(terminal)
      if (session) terminals.showBrowser(session.id)
    },
    /**
     * Another page for a session, after its last one (in main's split below it, so it belongs to the
     * session too), else beside the session. With the tabs in groups it shows in the browser tab.
     */
    newPage(sessionId: string, url?: string | null) {
      const last = terminals.browsersOf(sessionId).at(-1)
      return browser(url ?? null, last ? { terminalId: last.id, direction: 'column' } : { terminalId: sessionId, direction: 'row' })
    },
    /**
     * Splits the terminal with the keyboard, while the terminals are shown. In groups: a new group
     * beside the one with the keyboard, with a session like the terminal it shows; with a page shown
     * there, a new session of the default account.
     */
    async splitActive(direction: SplitDirection) {
      if (!terminals.grouped) {
        const shown = router.currentRoute.value.name === 'terminals' ? terminals.active : null
        return shown ? split(shown, direction) : undefined
      }
      const group = terminals.activeGroup
      const shown = group?.tabs.find((t) => t.id === group.active)?.terminal
      if (shown) return split(shown, direction)
      if (!group) return undefined
      const id = terminals.splitEmpty(group.id, direction === 'row' ? 'right' : 'down')
      const info = await launch({ accountId: defaultAccountId() })
      if (!info) terminals.removeEmptyGroup(id)
      return info
    },
    newSession: (accountId?: string, cwd?: string | null) => launch({ accountId: accountId ?? defaultAccountId(), cwd }),
    async newSessionInFolder(accountId?: string) {
      const id = accountId ?? defaultAccountId()
      const dir = await window.api.app.pickDirectory(accounts.get(id)?.defaultCwd ?? null)
      if (dir) await launch({ accountId: id, cwd: dir })
    },
    /**
     * Asks for the name of a worktree, then starts a session in it (`claude --worktree`): a checkout
     * of its own in `<cwd>\.claude\worktrees`, so sessions in the same repository don't get in each
     * other's way.
     */
    newSessionInWorktree(accountId?: string | null, cwd?: string | null) {
      const id = accountId ?? defaultAccountId()
      ui.worktreeRequest = { accountId: id, cwd: cwd ?? accounts.get(id)?.defaultCwd ?? settings.settings.claude.defaultCwd ?? null }
    },
    resume: (session: SessionSummary, fork = false) =>
      launch({
        accountId: session.accountId,
        // A worktree session goes on from where it was started: Claude Code enters the worktree again.
        cwd: sessionFolder(session),
        resumeSessionId: session.id,
        forkSession: fork,
        // Otherwise the tab follows the session's title, also after `/rename`.
        title: fork ? `Fork · ${session.title}` : null,
      }),
    login: (accountId: string) => launch({ accountId, mode: 'login' }),
    shell: (accountId: string, cwd?: string | null) => launch({ accountId, mode: 'shell', cwd }),
  }
}
