import { argsWithoutPrompt, lastingArgs } from '@shared/claude-args'
import { folderKey } from '@shared/folders'
import type { Account, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { canLendCredentials } from '@shared/utils'
import { assertNoNewerCopy, copySession, locateTranscript } from '../lib/session-files'
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
   * Starts the tab again in its place, after its process has ended. A session goes on with the
   * conversation it has now (not the one it was started with: `/resume` and `/clear` change it), with
   * the same account; changed launch options (such as `--no-chrome`) apply to it. A shell, or a session
   * whose id isn't known yet, starts as it was started. Null as above.
   */
  async restartTerminal(terminalId: string): Promise<TerminalInfo | null> {
    const old = this.terminals.get(terminalId)
    if (old.mode === 'browser') throw new Error('Ein Browser lädt seine Seite neu, statt neu zu starten.')
    if (old.mode === 'session' && old.sessionId) return this.handOver(old, this.accounts.get(old.authAccountId), false)
    if (this.switching.has(terminalId)) throw new Error('Der Neustart läuft bereits.')
    this.switching.add(terminalId)
    try {
      const cwd = old.mode === 'session' ? await this.terminals.trustedCwd(old.accountId, old.cwd) : old.cwd
      if (cwd === null) return null
      await this.terminals.stop(terminalId)
      const info = this.terminals.create({
        accountId: old.accountId,
        authAccountId: old.authAccountId === old.accountId ? undefined : old.authAccountId,
        cwd,
        mode: old.mode,
        resumeSessionId: old.resumeSessionId ?? undefined,
        // What picked the conversation picks it again, the prompt isn't sent once more.
        args: argsWithoutPrompt(old.args),
        title: old.fixedTitle ? old.title : null,
        muted: old.muted,
        replaces: terminalId,
      })
      this.emit('replaced', terminalId, info)
      this.terminals.close(terminalId)
      return info
    } finally {
      this.switching.delete(terminalId)
    }
  }

  /**
   * Moves the tab's session to the folder `to`, as `/cd` does, by starting it again: the process ends,
   * the session moves (see SessionService.move) and goes on in the tab in the new folder with its
   * conversation. What the input held and wasn't sent is lost. Not while Claude works. Null when the
   * user doesn't trust `to`: the tab then keeps running where it was. Should the move fail, the session
   * goes on where it was, and the error follows.
   */
  async moveTerminal(terminalId: string, to: string): Promise<TerminalInfo | null> {
    const old = this.terminals.get(terminalId)
    if (old.mode !== 'session') throw new Error('Nur Claude-Code-Sessions lassen sich verschieben.')
    if (!old.sessionId) throw new Error('Welche Session in diesem Tab läuft, ist noch nicht bekannt.')
    if (old.status === 'running' && (old.busy || old.compacting || old.subagents > 0)) {
      throw new Error('Claude arbeitet gerade. Sobald es fertig ist, lässt sich die Session verschieben.')
    }
    if (this.switching.has(terminalId)) throw new Error('Der Wechsel läuft bereits.')
    this.switching.add(terminalId)
    try {
      const sessionId = old.sessionId
      const located = await locateTranscript(this.accounts.paths(old.accountId).projectsDir, sessionId, old.cwd)
      if (folderKey(located?.cwd ?? old.cwd) === folderKey(to)) throw new Error('Die Session ist schon in diesem Ordner.')
      const cwd = await this.terminals.trustedCwd(old.accountId, to)
      if (cwd === null) return null
      // Two processes must never write to the same transcript: the old one ends first.
      await this.terminals.stop(terminalId)
      let failed: unknown = null
      // Nothing written yet: the session simply starts anew in the new folder.
      if (located) await this.sessions.move(old.accountId, sessionId, cwd).catch((error: unknown) => (failed = error))
      const options = await this.prepare(old.accountId, sessionId, failed ? (located?.cwd ?? old.cwd) : cwd, this.accounts.get(old.authAccountId))
      const info = this.terminals.create({
        ...options,
        args: lastingArgs(old.args),
        title: old.fixedTitle ? old.title : null,
        muted: old.muted,
        replaces: terminalId,
      })
      this.emit('replaced', terminalId, info)
      this.terminals.close(terminalId)
      if (failed) throw failed
      return info
    } finally {
      this.switching.delete(terminalId)
    }
  }

  /** `carryOn`: a session that stopped at its limit gets the continue prompt. */
  private async handOver(old: TerminalInfo, target: Account, carryOn: boolean): Promise<TerminalInfo | null> {
    const terminalId = old.id
    if (!old.sessionId) throw new Error('Welche Session in diesem Tab läuft, ist noch nicht bekannt.')
    if (this.switching.has(terminalId)) throw new Error('Der Wechsel läuft bereits.')
    this.switching.add(terminalId)
    try {
      // The session goes on in the folder it is in now (`/cd` may have moved it), or Claude Code won't resume it.
      const located = await locateTranscript(this.accounts.paths(old.accountId).projectsDir, old.sessionId, old.cwd)
      // A copy that can't be made should not cost the running tab: check before stopping it.
      const copies = !canLendCredentials(target.kind) && target.id !== old.accountId
      if (copies && located) await assertNoNewerCopy(this.accounts.paths(target.id), old.sessionId, located.file, target.name)
      // Neither should a folder the user doesn't trust for that account.
      const cwd = await this.terminals.trustedCwd(copies ? target.id : old.accountId, located?.cwd ?? old.cwd)
      if (cwd === null) return null
      // Two processes must never write to the same transcript: the old one ends first.
      await this.terminals.stop(terminalId)
      const options = await this.prepare(old.accountId, old.sessionId, cwd, target)
      // The session stopped at its limit: let Claude carry on where it was, so nobody has to type.
      if (carryOn && old.limit && options.resumeSessionId) options.prompt = this.settings.get().claude.continuePrompt || null
      const info = this.terminals.create({
        ...options,
        // `--model opus` and the like hold for the session, also with another account.
        args: lastingArgs(old.args),
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

  /** `folder`: where the session worked as far as the app knows; it goes on where its transcript says. */
  private async prepare(
    accountId: string,
    sessionId: string,
    folder: string | null,
    target: Account,
  ): Promise<TerminalCreateOptions> {
    const lend = canLendCredentials(target.kind)
    const located = await locateTranscript(this.accounts.paths(accountId).projectsDir, sessionId, folder)
    if (!located) {
      // Nothing written yet: a new session with the target account is just as good.
      return lend ? { accountId, authAccountId: target.id, cwd: folder } : { accountId: target.id, cwd: folder }
    }
    const { file: transcript, cwd } = located
    if (target.id === accountId) return { accountId, cwd, resumeSessionId: sessionId }
    if (lend) return { accountId, authAccountId: target.id, cwd, resumeSessionId: sessionId }
    await copySession(this.accounts.paths(accountId), this.accounts.paths(target.id), sessionId, transcript, target.name)
    return { accountId: target.id, cwd, resumeSessionId: sessionId }
  }
}
