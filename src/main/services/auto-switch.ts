import { accountChoices, suggestedChoice, type BlockedAccount } from '@shared/account-choice'
import type { Account, SessionLimit, TerminalInfo } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'
import type { AccountService } from './account-service'
import type { SessionHandoff } from './session-handoff'
import type { SettingsService } from './settings-service'
import type { TerminalService } from './terminal-service'
import type { UsageService } from './usage-service'

/** How long an account counts as limited after a switch away from it, when Claude Code named no reset. */
const UNKNOWN_RESET_MS = 5 * 60 * 60 * 1000

type Events = {
  /** The session of `from` stopped at a limit and goes on in `to`, with `target`'s limits. */
  switched: [from: TerminalInfo, to: TerminalInfo, target: Account]
  /** Switching to `target` didn't work; `from` stays (stopped, if it got that far). */
  failed: [from: TerminalInfo, target: Account, message: string]
}

/** What identifies one limit of a tab, so each one is handled once. */
const limitKey = (limit: SessionLimit) => `${limit.type}\n${limit.resetsAt}\n${limit.message}`

/**
 * Setting `claude.autoSwitch`: a session that stops at a usage limit continues by itself with the
 * account the limit notice suggests (the first one that is logged in and not at a limit). Without
 * such an account the tab keeps its notice, as without the setting.
 */
export class AutoSwitch extends TypedEmitter<Events> {
  /** Tabs whose limit was dealt with, by id: their limit, so a new one is dealt with again. */
  private readonly handled = new Map<string, string>()
  private readonly switching = new Set<string>()
  /** Tabs whose current limit this service tells about: the switch started, went through or failed. */
  private readonly telling = new Set<string>()
  /**
   * Accounts left at a limit, also by hand. Their tab is gone, but the limit stays until the reset:
   * no other session should go to them (and two sessions never take turns on two full accounts).
   */
  private remembered: BlockedAccount[] = []

  constructor(
    private readonly accounts: Pick<AccountService, 'list'>,
    private readonly terminals: Pick<TerminalService, 'list' | 'on'>,
    private readonly usage: Pick<UsageService, 'getAll'>,
    private readonly settings: Pick<SettingsService, 'get' | 'on'>,
    private readonly handoff: Pick<SessionHandoff, 'continueTerminal' | 'on'>,
  ) {
    super()
  }

  init(): void {
    this.terminals.on('changed', (terminals) => this.check(terminals))
    // Comes while the old tab is still there, with its limit.
    this.handoff.on('replaced', (oldId) => {
      const old = this.terminals.list().find((t) => t.id === oldId)
      if (old?.limit) this.remember(old.authAccountId, old.limit)
    })
    // Switched on: tabs that stand at a limit right now go on, too.
    this.settings.on('changed', (next, previous) => {
      if (next.claude.autoSwitch && !previous.claude.autoSwitch) this.check(this.terminals.list())
    })
  }

  /**
   * Whether this service tells about the tab's limit: its session goes on with another account, or
   * the attempt failed. The usual notice about the limit is left out then.
   */
  tellsLimit(terminalId: string): boolean {
    return this.telling.has(terminalId)
  }

  private check(terminals: readonly TerminalInfo[]): void {
    for (const id of [...this.handled.keys()]) {
      if (terminals.some((t) => t.id === id)) continue
      this.handled.delete(id)
      this.telling.delete(id)
    }
    if (!this.settings.get().claude.autoSwitch) return
    for (const tab of terminals) {
      const limit = tab.limit
      if (tab.mode !== 'session' || tab.status !== 'running' || !limit || !tab.sessionId) continue
      const key = limitKey(limit)
      if (this.switching.has(tab.id) || this.handled.get(tab.id) === key) continue
      this.handled.set(tab.id, key)
      const target = this.pick(tab, terminals)
      if (!target) {
        this.telling.delete(tab.id)
        continue
      }
      this.telling.add(tab.id)
      void this.switchTab(tab, target)
    }
  }

  private remember(accountId: string, limit: SessionLimit): void {
    const resetsAt = limit.resetsAt ?? new Date(Date.now() + UNKNOWN_RESET_MS).toISOString()
    this.remembered.push({ accountId, resetsAt })
  }

  /** Same choice as the limit notice in the tab, plus the accounts switched away from before. */
  private pick(tab: TerminalInfo, terminals: readonly TerminalInfo[]): Account | undefined {
    const now = Date.now()
    this.remembered = this.remembered.filter((b) => !b.resetsAt || Date.parse(b.resetsAt) > now)
    const blocked = [
      ...terminals.flatMap((t) => (t.limit ? [{ accountId: t.authAccountId, resetsAt: t.limit.resetsAt }] : [])),
      ...this.remembered,
    ]
    const usage = new Map(this.usage.getAll().map((u) => [u.accountId, u]))
    const choices = accountChoices(
      { accounts: this.accounts.list(), usage: (id) => usage.get(id), blocked, now },
      tab.accountId,
      tab.authAccountId,
    )
    return suggestedChoice(choices)?.account
  }

  private async switchTab(from: TerminalInfo, target: Account): Promise<void> {
    this.switching.add(from.id)
    try {
      const to = await this.handoff.continueTerminal(from.id, target.id)
      if (to) this.emit('switched', from, to, target)
      else this.emit('failed', from, target, `Der Ordner ist für „${target.name}“ nicht freigegeben.`)
    } catch (error) {
      this.emit('failed', from, target, error instanceof Error ? error.message : String(error))
    } finally {
      this.switching.delete(from.id)
    }
  }
}
