import type { Account, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { canLendCredentials } from '@shared/utils'
import { assertNoNewerCopy, copySession, findTranscript } from '../lib/session-files'
import type { AccountService } from './account-service'
import type { SessionService } from './session-service'
import type { SettingsService } from './settings-service'
import { defaultTerminalTitle, type TerminalService } from './terminal-service'

/**
 * Continues a Claude Code session with another account's limits, e.g. once one hits its limit.
 * A token or API key is lent to the session where it lies; a browser login only works in its own
 * config dir, so the session is copied there and continues as that account's session.
 */
export class SessionHandoff {
  private readonly switching = new Set<string>()

  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly terminals: TerminalService,
    private readonly settings: SettingsService,
  ) {}

  /** Replaces the tab by one that continues its session with `targetId`. */
  async continueTerminal(terminalId: string, targetId: string): Promise<TerminalInfo> {
    const old = this.terminals.get(terminalId)
    if (old.mode !== 'session') throw new Error('Nur Claude-Code-Sessions können den Account wechseln.')
    if (!old.sessionId) throw new Error('Welche Session in diesem Tab läuft, ist noch nicht bekannt.')
    const target = this.accounts.get(targetId)
    if (target.id === old.authAccountId && old.status === 'running') {
      throw new Error(`Der Tab läuft schon über „${target.name}“.`)
    }
    if (this.switching.has(terminalId)) throw new Error('Der Wechsel läuft bereits.')
    this.switching.add(terminalId)
    try {
      // A copy that can't be made should not cost the running tab: check before stopping it.
      if (!canLendCredentials(target.kind) && target.id !== old.accountId) {
        const transcript = await findTranscript(this.accounts.paths(old.accountId).projectsDir, old.sessionId, old.cwd)
        if (transcript) await assertNoNewerCopy(this.accounts.paths(target.id), old.sessionId, transcript, target.name)
      }
      // Two processes must never write to the same transcript: the old one ends first.
      await this.terminals.stop(terminalId)
      const options = await this.prepare(old.accountId, old.sessionId, old.cwd, target)
      // The session stopped at its limit: let Claude carry on where it was, so nobody has to type.
      if (old.limit && options.resumeSessionId) options.prompt = this.settings.get().claude.continuePrompt || null
      const previousAuth = this.accounts.list().find((a) => a.id === old.authAccountId)
      const titleWasDefault = previousAuth && old.title === defaultTerminalTitle(old.mode, previousAuth.name, old.cwd)
      const info = this.terminals.create({ ...options, title: titleWasDefault ? null : old.title })
      this.terminals.close(terminalId)
      return info
    } finally {
      this.switching.delete(terminalId)
    }
  }

  /** Opens a session from the history in a new tab, running with `targetId`. */
  async resumeSession(accountId: string, sessionId: string, targetId: string): Promise<TerminalInfo> {
    const [group] = await this.sessions.list(accountId)
    const session = group?.sessions.find((s) => s.id === sessionId)
    if (!session) throw new Error('Session nicht gefunden.')
    const options = await this.prepare(accountId, sessionId, session.cwd, this.accounts.get(targetId))
    return this.terminals.create({ ...options, title: session.title })
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
