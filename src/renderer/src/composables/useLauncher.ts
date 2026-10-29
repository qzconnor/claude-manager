import { useRouter } from 'vue-router'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { SessionSummary, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { toastError } from '@/lib/errors'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'

/** Starting Claude Code in a new tab — the single entry point used by all views. */
export function useLauncher() {
  const router = useRouter()
  const terminals = useTerminalsStore()
  const accounts = useAccountsStore()
  const settings = useSettingsStore()

  function defaultAccountId(): string {
    const preferred = settings.settings.general.defaultAccountId
    return accounts.get(preferred) ? preferred : SYSTEM_ACCOUNT_ID
  }

  async function launch(options: TerminalCreateOptions): Promise<TerminalInfo | undefined> {
    try {
      const info = await terminals.open(options)
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
    resume: (session: SessionSummary, fork = false) =>
      launch({
        accountId: session.accountId,
        cwd: session.cwd,
        resumeSessionId: session.id,
        forkSession: fork,
        title: fork ? `Fork · ${session.title}` : session.title,
      }),
    login: (accountId: string) => launch({ accountId, mode: 'login' }),
    shell: (accountId: string) => launch({ accountId, mode: 'shell' }),
  }
}
