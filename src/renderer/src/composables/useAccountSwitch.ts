import { toast } from 'vue-sonner'
import { useRouter } from 'vue-router'
import {
  accountChoices,
  type AccountChoice as SharedAccountChoice,
  type AccountStanding,
} from '@shared/account-choice'
import type { Account, AutoSwitchEvent, SessionSummary, TerminalInfo } from '@shared/types'
import { attempt } from '@/lib/errors'
import { formatClock } from '@/lib/format'
import { limitLabel } from '@/lib/usage'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useUsageStore } from '@/stores/usage'

export interface AccountChoice extends SharedAccountChoice {
  /** Short status, e.g. "5 Std. 12 %" or "Limit bis 19:40". */
  hint: string | null
}

function hintFor(standing: AccountStanding, now: number): string | null {
  switch (standing.kind) {
    case 'logged-out':
      return 'nicht angemeldet'
    case 'blocked':
      return standing.resetsAt ? `Limit bis ${formatClock(standing.resetsAt, now)}` : 'Limit erreicht'
    case 'pay-per-use':
      return 'nach Verbrauch'
    case 'usage':
      return standing.percent >= 100 ? `${standing.label}: Limit erreicht` : `${standing.label} ${standing.percent} %`
    default:
      return null
  }
}

/** Continuing a session with another account, e.g. when one hit its usage limit. */
export function useAccountSwitch() {
  const router = useRouter()
  const accounts = useAccountsStore()
  const terminals = useTerminalsStore()
  const usage = useUsageStore()
  const settings = useSettingsStore()
  const ui = useUiStore()

  /**
   * Accounts a session could continue with, except the one it runs with now, in the order of
   * `accountChoices`. Another tab that stopped at an account's limit counts as that limit.
   */
  function choices(sessionAccountId: string, currentAccountId: string, now = Date.now()): AccountChoice[] {
    const blocked = terminals.terminals.flatMap((t) =>
      t.limit ? [{ accountId: t.authAccountId, resetsAt: t.limit.resetsAt }] : [],
    )
    const list = accountChoices(
      { accounts: accounts.accounts, usage: (id) => usage.byAccount.get(id), blocked, now },
      sessionAccountId,
      currentAccountId,
    )
    return list.map((choice) => ({ ...choice, hint: hintFor(choice.standing, now) }))
  }

  /**
   * `prompt`: the message sent on its own after the switch, if any. `cause`: why the app switched by
   * itself; it leads the message, which then says the account it went on with.
   */
  function announce(info: TerminalInfo, sessionAccountId: string, target: Account, prompt = '', cause?: string): void {
    const sent = prompt && info.resumeSessionId ? `„${prompt}“ ist geschickt, Claude macht weiter. ` : ''
    const title = (fallback: string) => (cause ? `${cause} · weiter mit „${target.name}“` : fallback)
    if (!info.resumeSessionId) {
      toast.success(title(`Neue Session mit „${target.name}“`), { description: 'Die bisherige Session hatte noch keinen Verlauf.' })
    } else if (info.accountId !== sessionAccountId) {
      const from = accounts.get(sessionAccountId)?.name ?? 'dem bisherigen Account'
      toast.success(title(`Session zu „${target.name}“ kopiert`), {
        description: `${sent}Sie läuft jetzt dort weiter. Bei „${from}“ bleibt der Stand bis zum Wechsel.`,
      })
    } else {
      toast.success(title(`Läuft jetzt über „${target.name}“`), {
        description: `${sent}Die erste Antwort liest den Verlauf neu ein und zählt dadurch etwas mehr.`,
      })
    }
  }

  /** Tells about a switch the app made by itself at a limit (setting `claude.autoSwitch`), or why it failed. */
  function announceAutoSwitch(event: AutoSwitchEvent): void {
    const from = accounts.get(event.from.authAccountId)?.name ?? 'dem bisherigen Account'
    const cause = `${limitLabel(event.from.limit?.type ?? null)} von „${from}“ erreicht`
    const target = accounts.get(event.targetId)
    if (event.to && target) {
      announce(event.to, event.from.accountId, target, settings.settings.claude.continuePrompt, cause)
    } else {
      toast.error(cause, {
        description: `Der automatische Wechsel zu „${target?.name ?? 'einem anderen Account'}“ ging nicht: ${event.error}`,
      })
    }
  }

  async function continueTerminal(terminal: TerminalInfo, accountId: string): Promise<void> {
    const target = accounts.get(accountId)
    if (!target) return
    if (terminal.status === 'running' && !terminal.limit && settings.settings.general.confirmCloseRunning) {
      const ok = await ui.confirm({
        title: `Mit „${target.name}“ fortsetzen?`,
        description:
          'Claude Code wird in diesem Tab beendet und setzt die Session sofort mit dem anderen Account fort. Was gerade läuft, wird abgebrochen.',
        confirmText: 'Fortsetzen',
      })
      if (!ok) return
    }
    // Same rule as the main process: only a session that stopped at its limit gets the message.
    const prompt = terminal.limit ? settings.settings.claude.continuePrompt : ''
    const sessionAccountId = terminal.accountId
    const info = await attempt(() => terminals.continueWith(terminal.id, accountId), 'Account konnte nicht gewechselt werden')
    if (info) announce(info, sessionAccountId, target, prompt)
  }

  async function continueSession(session: SessionSummary, accountId: string): Promise<void> {
    const target = accounts.get(accountId)
    if (!target) return
    const info = await attempt(
      () => terminals.continueSession(session.accountId, session.id, accountId),
      'Session konnte nicht fortgesetzt werden',
    )
    if (!info) return
    if (router.currentRoute.value.name !== 'terminals') await router.push({ name: 'terminals' })
    announce(info, session.accountId, target)
  }

  return { choices, continueTerminal, continueSession, announceAutoSwitch }
}
