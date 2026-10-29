import { join } from 'node:path'
import { readJsonSync, writeJsonAtomicSync } from '../lib/json-file'
import { findTranscript, SESSION_ID_RE } from '../lib/session-files'
import type { AccountService } from './account-service'
import type { SettingsService } from './settings-service'
import type { TerminalService } from './terminal-service'

/** What is remembered of a tab. Login tabs are not. */
interface SavedTerminal {
  accountId: string
  authAccountId: string
  cwd: string
  mode: 'session' | 'shell'
  /** Continued on the next start if Claude Code has written it, otherwise a new session starts. */
  sessionId: string | null
  title: string
}

/**
 * Remembers the open tabs and opens them again on the next start (setting `general.restoreTerminals`).
 * The file is rewritten on every change, so the tabs are also back after the app was ended abruptly.
 */
export class TerminalRestore {
  private readonly file: string
  /** Content of the file, so unchanged state is not written again. */
  private written: string
  private offs: (() => void)[] = []
  private disposed = false

  constructor(
    userDataDir: string,
    private readonly terminals: TerminalService,
    private readonly accounts: AccountService,
    private readonly settings: SettingsService,
  ) {
    this.file = join(userDataDir, 'open-terminals.json')
    this.written = JSON.stringify(readJsonSync(this.file) ?? [])
  }

  /** Opens the tabs of the last run, then follows the open tabs. */
  async init(): Promise<void> {
    if (this.settings.get().general.restoreTerminals) await this.restore()
    if (this.disposed) return
    this.offs = [
      this.terminals.on('changed', () => this.save()),
      this.settings.on('changed', (next, previous) => {
        if (next.general.restoreTerminals !== previous.general.restoreTerminals) this.save()
      }),
    ]
    this.save()
  }

  /** Stops following the tabs. Must run before quitting closes them all. */
  dispose(): void {
    this.disposed = true
    for (const off of this.offs) off()
    this.offs = []
  }

  private async restore(): Promise<void> {
    const saved = readJsonSync<unknown>(this.file)
    if (!Array.isArray(saved)) return
    const accountIds = new Set(this.accounts.list().map((a) => a.id))
    for (const tab of saved) {
      if (!isSavedTerminal(tab) || !accountIds.has(tab.accountId)) continue
      try {
        this.terminals.create({
          accountId: tab.accountId,
          // Without the lending account the session runs with its own login again.
          authAccountId: accountIds.has(tab.authAccountId) ? tab.authAccountId : null,
          cwd: tab.cwd,
          mode: tab.mode,
          resumeSessionId: tab.sessionId && (await this.hasTranscript(tab.accountId, tab.sessionId, tab.cwd)) ? tab.sessionId : null,
          title: tab.title,
        })
      } catch {
        // e.g. the folder no longer exists: the tab is left out.
      }
    }
  }

  private async hasTranscript(accountId: string, sessionId: string, cwd: string): Promise<boolean> {
    try {
      return (await findTranscript(this.accounts.paths(accountId).projectsDir, sessionId, cwd)) !== null
    } catch {
      return false
    }
  }

  private save(): void {
    const tabs = this.settings.get().general.restoreTerminals ? this.snapshot() : []
    const json = JSON.stringify(tabs)
    if (json === this.written) return
    try {
      writeJsonAtomicSync(this.file, tabs)
      this.written = json
    } catch {
      // Locked for a moment (antivirus, indexer): the next change writes it.
    }
  }

  private snapshot(): SavedTerminal[] {
    return this.terminals.list().flatMap((t) =>
      t.mode === 'login'
        ? []
        : [{ accountId: t.accountId, authAccountId: t.authAccountId, cwd: t.cwd, mode: t.mode, sessionId: t.sessionId, title: t.title }],
    )
  }
}

function isSavedTerminal(value: unknown): value is SavedTerminal {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.accountId === 'string' &&
    typeof t.authAccountId === 'string' &&
    typeof t.cwd === 'string' &&
    (t.mode === 'session' || t.mode === 'shell') &&
    (t.sessionId === null || (typeof t.sessionId === 'string' && SESSION_ID_RE.test(t.sessionId))) &&
    typeof t.title === 'string'
  )
}
