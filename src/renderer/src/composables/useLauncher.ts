import { useRouter } from 'vue-router'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { SessionSummary, SplitDirection, TerminalCreateOptions, TerminalInfo } from '@shared/types'
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

  return {
    defaultAccountId,
    launch,
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
    /** A browser in a new tab, or next to a terminal (`split`); the empty page asks for an address. */
    async browser(url?: string | null, split?: TerminalCreateOptions['split']) {
      try {
        const info = await terminals.openBrowser({ url, split })
        if (router.currentRoute.value.name !== 'terminals') await router.push({ name: 'terminals' })
        return info
      } catch (error) {
        toastError(error, 'Browser konnte nicht geöffnet werden')
        return undefined
      }
    },
    shell: (accountId: string, cwd?: string | null) => launch({ accountId, mode: 'shell', cwd }),
    /**
     * Splits the part of `from` in its tab: the new terminal comes to the right (`row`) or below
     * (`column`) and runs like `from`, a new session or a shell with the same account in the same folder.
     * A browser passes on the terminal beside it. Next to a login or a lone browser, a new session of
     * the default account starts.
     */
    split(from: TerminalInfo, direction: SplitDirection) {
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
    },
  }
}
