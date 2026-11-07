import type { Account, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { canLendCredentials } from '@shared/utils'
import { assertNoNewerCopy, copySession, findTranscript } from '../lib/session-files'
import { TypedEmitter } from '../lib/typed-emitter'
import type { AccountService } from './account-service'
import type { SessionService } from './session-service'
import type { SettingsService } from './settings-service'
import type { TerminalService } from './terminal-service'

/**
 * Continues a Claude Code session with another account's limits, e.g. once one hits its limit.
 * A token or API key is lent to the session where it lies; a browser login only works in its own
 * config dir, so the session is copied there and continues as that account's session.
 */
type Events = {
  /** A tab was replaced by one that continues its session; sent while the old tab is still open. */
  replaced: [oldId: string, info: TerminalInfo]
}

export class SessionHandoff extends TypedEmitter<Events> {
  private readonly switching = new Set<string>()

  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly terminals: TerminalService,
    private readonly settings: SettingsService,
  ) {
    super()
  }

  /**
   * Replaces the tab by one that continues its session with `targetId`. Null when the user doesn't
   * trust the folder for the account whose folder the session lands in: the tab then keeps running.
   */
  async continueTerminal(terminalId: string, targetId: string): Promise<TerminalInfo | null> {
    const old = this.terminals.get(terminalId)
    if (old.mode !== 'session') throw new Error('Nur Claude-Code-Sessions können den Account wechseln.')
    const target = this.accounts.get(targetId)
    if (target.id === old.authAccountId && old.status === 'running') {
      throw new Error(`Der Tab läuft schon über „${target.name}“.`)
    }
    return this.handOver(old, target, true)
  }

  /**
   * Starts the tab's session again in its place with the same account, and it goes on with its
   * conversation: changed launch options (such as `--no-chrome`) apply to it. Null as above.
   */
  async restartTerminal(terminalId: string): Promise<TerminalInfo | null> {
    const old = this.terminals.get(terminalId)
    if (old.mode !== 'session') throw new Error('Nur Claude-Code-Sessions lassen sich mit ihrem Verlauf neu starten.')
    return this.handOver(old, this.accounts.get(old.authAccountId), false)
  }

  /** `carryOn`: a session that stopped at its limit gets the continue prompt. */
  private async handOver(old: TerminalInfo, target: Account, carryOn: boolean): Promise<TerminalInfo | null> {
    const terminalId = old.id
    if (!old.sessionId) throw new Error('Welche Session in diesem Tab läuft, ist noch nicht bekannt.')
    if (this.switching.has(terminalId)) throw new Error('Der Wechsel läuft bereits.')
    this.switching.add(terminalId)
    try {
      // A copy that can't be made should not cost the running tab: check before stopping it.
      const copies = !canLendCredentials(target.kind) && target.id !== old.accountId
      if (copies) {
        const transcript = await findTranscript(this.accounts.paths(old.accountId).projectsDir, old.sessionId, old.cwd)
        if (transcript) await assertNoNewerCopy(this.accounts.paths(target.id), old.sessionId, transcript, target.name)
      }
      // Neither should a folder the user doesn't trust for that account.
      const cwd = await this.terminals.trustedCwd(copies ? target.id : old.accountId, old.cwd)
      if (cwd === null) return null
      // Two processes must never write to the same transcript: the old one ends first.
      await this.terminals.stop(terminalId)
      const options = await this.prepare(old.accountId, old.sessionId, cwd, target)
      // The session stopped at its limit: let Claude carry on where it was, so nobody has to type.
      if (carryOn && old.limit && options.resumeSessionId) options.prompt = this.settings.get().claude.continuePrompt || null
      const info = this.terminals.create({
        ...options,
        title: old.fixedTitle ? old.title : null,
        muted: old.muted,
        // Its place in the tab order and in a split tab.
        replaces: terminalId,
      })
      // Before the old tab goes, so the window can select the new one if the old one was.
      this.emit('replaced', terminalId, info)
      this.terminals.close(terminalId)
      return info
    } finally {
      this.switching.delete(terminalId)
    }
  }

  /** Opens a session from the history in a new tab, running with `targetId`; null when its folder isn't trusted. */
  async resumeSession(accountId: string, sessionId: string, targetId: string): Promise<TerminalInfo | null> {
    const [group] = await this.sessions.list(accountId)
    const session = group?.sessions.find((s) => s.id === sessionId)
    if (!session) throw new Error('Session nicht gefunden.')
    // A worktree session goes on from the folder it was started in: Claude Code enters the worktree
    // again, or carries on without it once it was removed.
    const cwd = session.worktree?.originalCwd ?? session.cwd
    const options = await this.prepare(accountId, sessionId, cwd, this.accounts.get(targetId))
    return this.terminals.open(options)
  }

  private async prepare(
    accountId: string,
    sessionId: string,
    cwd: string | null,
    target: Account,
  ): Promise<TerminalCreateOptions> {
    const lend = canLendCredentials(target.kind)
    const transcript = await findTranscript(this.accounts.paths(accountId).projectsDir, sessionId, cwd)
    if (!transcript) {
      // Nothing written yet: a new session with the target account is just as good.
      return lend ? { accountId, authAccountId: target.id, cwd } : { accountId: target.id, cwd }
    }
    if (target.id === accountId) return { accountId, cwd, resumeSessionId: sessionId }
    if (lend) return { accountId, authAccountId: target.id, cwd, resumeSessionId: sessionId }
    await copySession(this.accounts.paths(accountId), this.accounts.paths(target.id), sessionId, transcript, target.name)
    return { accountId: target.id, cwd, resumeSessionId: sessionId }
  }
}
