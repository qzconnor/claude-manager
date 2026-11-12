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
 * with its own account once its limit has reset. Without the setting a tab waits for the reset of
 * its own limit when asked to („Am Reset fortsetzen“, see `resumeAtReset`). How a tab waits, it
 * tells in `TerminalInfo.resume`.
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
  /** Tabs that go on at the reset of their limit because the user asked them to, also without the setting. */
  private readonly requested = new Set<string>()
  /**
   * Tabs that wait at a limit, with that limit and their session. Claude Code no longer names it once
   * it has reset (`TerminalInfo.limit` is gone then), but the session goes on only a minute later.
   */
  private readonly waiting = new Map<string, { sessionId: string; limit: SessionLimit }>()

  constructor(
    private readonly accounts: Pick<AccountService, 'list' | 'on'>,
    private readonly terminals: Pick<TerminalService, 'list' | 'on' | 'setResume'>,
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

  /**
   * The tab's session goes on by itself with its own account at the reset of its limit (`on`), or no
   * longer. With the automatic switch it may go on earlier with another account that is free.
   */
  resumeAtReset(terminalId: string, on: boolean): void {
    const tab = this.terminals.list().find((t) => t.id === terminalId)
    if (!tab) throw new Error('Tab nicht gefunden.')
    if (on) {
      if (tab.mode !== 'session' || !tab.limit) throw new Error('Die Session steht an keinem Limit.')
      if (!tab.sessionId) throw new Error('Welche Session in diesem Tab läuft, ist noch nicht bekannt.')
      this.requested.add(terminalId)
    } else this.requested.delete(terminalId)
    this.check(this.terminals.list())
  }

  private check(terminals: readonly TerminalInfo[]): void {
    for (const id of new Set([...this.handled.keys(), ...this.requested, ...this.waiting.keys()])) {
      if (terminals.some((t) => t.id === id)) continue
      this.handled.delete(id)
      this.telling.delete(id)
      this.requested.delete(id)
      this.waiting.delete(id)
    }
    clearTimeout(this.retryTimer)
    const auto = this.settings.get().claude.autoSwitch
    let waiting = false
    for (const tab of terminals) {
      const limit = this.limitOf(tab)
      const asked = this.requested.has(tab.id)
      if (tab.mode !== 'session' || tab.status !== 'running' || !limit || !tab.sessionId || !(auto || asked)) {
        this.stopWaiting(tab)
        continue
      }
      const key = limitKey(limit)
      if (this.switching.has(tab.id) || this.handled.get(tab.id) === key) continue
      const target = this.pick(tab, limit, terminals, auto)
      if (!target) {
        // Tried again with every change, and once the next limit has reset.
        this.telling.delete(tab.id)
        this.waiting.set(tab.id, { sessionId: tab.sessionId, limit })
        this.terminals.setResume(tab.id, { byUser: asked, at: this.ownTurnAt(tab.sessionId, limit) })
        waiting = true
        continue
      }
      this.handled.set(tab.id, key)
      this.telling.add(tab.id)
      void this.switchTab(tab, target, limit)
    }
    if (waiting) this.retryAtNextReset(terminals)
  }

  /**
   * The limit the tab stands at: the one Claude Code names, or the one it waits at, which has reset.
   * None once the user went on by hand (Claude works again) or the tab shows another session.
   */
  private limitOf(tab: TerminalInfo): SessionLimit | null {
    if (tab.limit) return tab.limit
    const kept = this.waiting.get(tab.id)
    return kept && kept.sessionId === tab.sessionId && !tab.busy ? kept.limit : null
  }

  private stopWaiting(tab: TerminalInfo): void {
    if (!this.waiting.delete(tab.id) && !tab.resume) return
    // Asked for this limit: the next one asks anew.
    this.requested.delete(tab.id)
    this.terminals.setResume(tab.id, null)
  }

  /** When the session goes on with its own account: a minute after the reset, unless it did already. */
  private ownTurnAt(sessionId: string, limit: SessionLimit): string | null {
    if (!limit.resetsAt || this.resumedAt.get(sessionId) === limit.resetsAt) return null
    return new Date(Date.parse(limit.resetsAt) + RESET_GRACE_MS).toISOString()
  }

  /** Checks again shortly after the next reset of a limit the app knows of. */
  private retryAtNextReset(terminals: readonly TerminalInfo[]): void {
    const now = Date.now()
    const resets = [
      ...terminals.map((t) => t.limit?.resetsAt),
      ...[...this.waiting.values()].map((w) => w.limit.resetsAt),
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
   * With the setting the same choice as the limit notice in the tab, plus the accounts switched away
   * from before. With none free (or without the setting), the tab's own account once `limit` has reset.
   */
  private pick(tab: TerminalInfo, limit: SessionLimit, terminals: readonly TerminalInfo[], auto: boolean): Account | undefined {
    const now = Date.now()
    this.forgetPast()
    for (const [sessionId, resetsAt] of this.resumedAt) {
      if (Date.parse(resetsAt) + UNKNOWN_RESET_MS < now) this.resumedAt.delete(sessionId)
    }
    if (auto) {
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
    }
    const at = tab.sessionId ? this.ownTurnAt(tab.sessionId, limit) : null
    if (!at || Date.parse(at) > now) return undefined
    return this.accounts.list().find((a) => a.id === tab.authAccountId)
  }

  private async switchTab(from: TerminalInfo, target: Account, limit: SessionLimit): Promise<void> {
    this.switching.add(from.id)
    this.waiting.delete(from.id)
    this.requested.delete(from.id)
    this.terminals.setResume(from.id, null)
    if (target.id === from.authAccountId && from.sessionId && limit.resetsAt) {
      this.resumedAt.set(from.sessionId, limit.resetsAt)
    }
    try {
      const to = await this.handoff.continueTerminal(from.id, target.id, true)
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
