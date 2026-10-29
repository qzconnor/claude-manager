import { toast } from 'vue-sonner'
import { useRouter } from 'vue-router'
import type { Account, SessionSummary, TerminalInfo } from '@shared/types'
import { canLendCredentials } from '@shared/utils'
import { attempt } from '@/lib/errors'
import { formatClock } from '@/lib/format'
import { clampPercent } from '@/lib/usage'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useUsageStore } from '@/stores/usage'

export interface AccountChoice {
  account: Account
  /** Short status, e.g. "5 Std. 12 %" or "Limit bis 19:40". */
  hint: string | null
  /** Known to be at a limit right now. */
  limited: boolean
  /** Not logged in, so it can't take over. */
  disabled: boolean
  /** A browser login: the session is copied to this account instead of borrowing its key. */
  copies: boolean
}

/** Continuing a session with another account, e.g. when one hit its usage limit. */
export function useAccountSwitch() {
  const router = useRouter()
  const accounts = useAccountsStore()
  const terminals = useTerminalsStore()
  const usage = useUsageStore()
  const settings = useSettingsStore()
  const ui = useUiStore()

  function describe(account: Account, sessionAccountId: string, now: number): AccountChoice {
    const copies = account.id !== sessionAccountId && !canLendCredentials(account.kind)
    const base = { account, copies, limited: false, disabled: false }
    if (account.authState === 'missing') return { ...base, hint: 'nicht angemeldet', disabled: true }

    // Another tab that stopped at this account's limit is the most precise source (also for tokens).
    const blocked = terminals.terminals.find(
      (t) => t.authAccountId === account.id && t.limit && (!t.limit.resetsAt || Date.parse(t.limit.resetsAt) > now),
    )
    if (blocked?.limit) {
      const until = blocked.limit.resetsAt ? `Limit bis ${formatClock(blocked.limit.resetsAt, now)}` : 'Limit erreicht'
      return { ...base, hint: until, limited: true }
    }
    if (account.kind === 'apiKey') return { ...base, hint: 'nach Verbrauch' }

    const u = usage.byAccount.get(account.id)
    const windows = [
      { label: '5 Std.', window: u?.fiveHour },
      { label: 'Woche', window: u?.sevenDay },
    ].filter((w) => w.window)
    if (u?.status !== 'ok' || windows.length === 0) return { ...base, hint: null }
    const top = windows.reduce((a, b) => (b.window!.percent > a.window!.percent ? b : a))
    const percent = clampPercent(top.window!.percent)
    return percent >= 100
      ? { ...base, hint: `${top.label}: Limit erreicht`, limited: true }
      : { ...base, hint: `${top.label} ${percent} %` }
  }

  /**
   * Accounts a session could continue with, except the one it runs with now. Accounts that take
   * over without copying the session come first, then browser logins; accounts at their limit or
   * not logged in go last. Within each group the account order stays.
   */
  function choices(sessionAccountId: string, currentAccountId: string, now = Date.now()): AccountChoice[] {
    const list = accounts.accounts.filter((a) => a.id !== currentAccountId).map((a) => describe(a, sessionAccountId, now))
    const rank = (c: AccountChoice) => (c.limited || c.disabled ? 2 : c.copies ? 1 : 0)
    return [0, 1, 2].flatMap((r) => list.filter((c) => rank(c) === r))
  }

  /** `prompt`: the message sent on its own after the switch, if any. */
  function announce(info: TerminalInfo, sessionAccountId: string, target: Account, prompt = ''): void {
    const sent = prompt && info.resumeSessionId ? `„${prompt}“ ist geschickt, Claude macht weiter. ` : ''
    if (!info.resumeSessionId) {
      toast.success(`Neue Session mit „${target.name}“`, { description: 'Die bisherige Session hatte noch keinen Verlauf.' })
    } else if (info.accountId !== sessionAccountId) {
      const from = accounts.get(sessionAccountId)?.name ?? 'dem bisherigen Account'
      toast.success(`Session zu „${target.name}“ kopiert`, {
        description: `${sent}Sie läuft jetzt dort weiter. Bei „${from}“ bleibt der Stand bis zum Wechsel.`,
      })
    } else {
      toast.success(`Läuft jetzt über „${target.name}“`, {
        description: `${sent}Die erste Antwort liest den Verlauf neu ein und zählt dadurch etwas mehr.`,
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

  return { choices, continueTerminal, continueSession }
}
