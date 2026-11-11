import { accountChoices, suggestedChoice, type BlockedAccount } from '@shared/account-choice'
import type { Account, SessionLimit, TerminalInfo } from '@shared/types'
import { readJsonSync, writeJsonAtomic } from '../lib/json-file'
import { TypedEmitter } from '../lib/typed-emitter'
import type { AccountService } from './account-service'
import type { SessionHandoff } from './session-handoff'
import type { SettingsService } from './settings-service'
import type { TerminalService } from './terminal-service'
import type { UsageService } from './usage-service'

/** How long an account counts as limited after a switch away from it, when Claude Code named no reset. */
const UNKNOWN_RESET_MS = 5 * 60 * 60 * 1000
/**
 * A waiting tab tries again this long after a reset: Claude Code names the time of a reset only to the
 * minute or hour, and a session that starts too early stops at the same limit again.
 */
export const RESET_GRACE_MS = 60 * 1000
/** Longer than this, `setTimeout` fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

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
 * such an account the tab keeps its notice and waits: it goes on as soon as an account is free, or
 * with its own account once its limit has reset.
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
   * Kept in `file`, so a restart doesn't forget them.
   */
  private remembered: BlockedAccount[] = []
  /** What `file` holds, so unchanged state isn't written again. */
  private written = '[]'
  /** Tries the waiting tabs again once the next limit has reset. */
  private retryTimer: NodeJS.Timeout | undefined
  /**
   * Sessions that went on with their own account after a reset, with that reset. Should Claude Code
   * stop them at the same limit again, it was too early: they don't start over and over.
   */
  private readonly resumedAt = new Map<string, string>()

  constructor(
    private readonly accounts: Pick<AccountService, 'list' | 'on'>,
    private readonly terminals: Pick<TerminalService, 'list' | 'on'>,
    private readonly usage: Pick<UsageService, 'getAll' | 'on'>,
    private readonly settings: Pick<SettingsService, 'get' | 'on'>,
    private readonly handoff: Pick<SessionHandoff, 'continueTerminal' | 'on'>,
    private readonly file: string | null = null,
  ) {
    super()
  }

  init(): void {
    if (this.file) {
      const saved = readJsonSync<unknown>(this.file)
      if (Array.isArray(saved)) {
        this.remembered = saved.filter(isBlockedAccount)
        this.written = JSON.stringify(this.remembered)
      }
      this.forgetPast()
    }
    this.terminals.on('changed', (terminals) => this.check(terminals))
    // Comes while the old tab is still there, with its limit.
    this.handoff.on('replaced', (oldId) => {
      const old = this.terminals.list().find((t) => t.id === oldId)
      if (old?.limit) this.remember(old.authAccountId, old.limit)
    })
    // Switched on: tabs that stand at a limit right now go on, too.
    this.settings.on('changed', (next, previous) => {
      if (next.claude.autoSwitch !== previous.claude.autoSwitch) this.check(this.terminals.list())
    })
    // An account may be free now: logged in again, or its limits were read anew.
    this.usage.on('changed', () => this.check(this.terminals.list()))
    this.accounts.on('changed', () => {
      this.forgetPast()
      this.check(this.terminals.list())
    })
  }

  dispose(): void {
    clearTimeout(this.retryTimer)
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
    clearTimeout(this.retryTimer)
    if (!this.settings.get().claude.autoSwitch) return
    let waiting = false
    for (const tab of terminals) {
      const limit = tab.limit
      if (tab.mode !== 'session' || tab.status !== 'running' || !limit || !tab.sessionId) continue
      const key = limitKey(limit)
      if (this.switching.has(tab.id) || this.handled.get(tab.id) === key) continue
      const target = this.pick(tab, terminals)
      if (!target) {
        // Tried again with every change, and once the next limit has reset.
        this.telling.delete(tab.id)
        waiting = true
        continue
      }
      this.handled.set(tab.id, key)
      this.telling.add(tab.id)
      void this.switchTab(tab, target)
    }
    if (waiting) this.retryAtNextReset(terminals)
  }

  /** Checks again shortly after the next reset of a limit the app knows of. */
  private retryAtNextReset(terminals: readonly TerminalInfo[]): void {
    const now = Date.now()
    const resets = [
      ...terminals.map((t) => t.limit?.resetsAt),
      ...this.remembered.map((b) => b.resetsAt),
      ...this.usage.getAll().flatMap((u) => [u.fiveHour?.resetsAt, u.sevenDay?.resetsAt]),
    ]
      .map((at) => (at ? Date.parse(at) + RESET_GRACE_MS : NaN))
      .filter((at) => at > now)
    if (resets.length === 0) return
    const delay = Math.min(Math.min(...resets) - now, MAX_TIMEOUT_MS)
    this.retryTimer = setTimeout(() => this.check(this.terminals.list()), delay)
    this.retryTimer.unref?.()
  }

  private remember(accountId: string, limit: SessionLimit): void {
    const resetsAt = limit.resetsAt ?? new Date(Date.now() + UNKNOWN_RESET_MS).toISOString()
    this.remembered.push({ accountId, resetsAt })
    this.forgetPast()
  }

  /** Forgets the limits that have reset and those of accounts that are gone, then saves the rest. */
  private forgetPast(): void {
    const now = Date.now()
    const known = new Set(this.accounts.list().map((a) => a.id))
    this.remembered = this.remembered.filter((b) => (!b.resetsAt || Date.parse(b.resetsAt) > now) && known.has(b.accountId))
    const json = JSON.stringify(this.remembered)
    if (!this.file || json === this.written) return
    this.written = json
    void writeJsonAtomic(this.file, this.remembered).catch(() => undefined)
  }

  /**
   * Same choice as the limit notice in the tab, plus the accounts switched away from before. With
   * none free, the tab's own account once its limit has reset.
   */
  private pick(tab: TerminalInfo, terminals: readonly TerminalInfo[]): Account | undefined {
    const now = Date.now()
    this.forgetPast()
    for (const [sessionId, resetsAt] of this.resumedAt) {
      if (Date.parse(resetsAt) + UNKNOWN_RESET_MS < now) this.resumedAt.delete(sessionId)
    }
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
    const other = suggestedChoice(choices)?.account
    if (other) return other
    const resetsAt = tab.limit?.resetsAt
    if (!resetsAt || Date.parse(resetsAt) + RESET_GRACE_MS > now) return undefined
    if (tab.sessionId && this.resumedAt.get(tab.sessionId) === resetsAt) return undefined
    return this.accounts.list().find((a) => a.id === tab.authAccountId)
  }

  private async switchTab(from: TerminalInfo, target: Account): Promise<void> {
    this.switching.add(from.id)
    if (target.id === from.authAccountId && from.sessionId && from.limit?.resetsAt) {
      this.resumedAt.set(from.sessionId, from.limit.resetsAt)
    }
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

function isBlockedAccount(value: unknown): value is BlockedAccount {
  if (!value || typeof value !== 'object') return false
  const { accountId, resetsAt } = value as Record<string, unknown>
  return typeof accountId === 'string' && typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt))
}
