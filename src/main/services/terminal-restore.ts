import { join } from 'node:path'
import { isBrowsableUrl } from '@shared/browser'
import { isSplit, mapPanes, paneIds, parsePaneNode, removePanes } from '@shared/panes'
import type { PaneNode } from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../lib/json-file'
import { locateTranscript, SESSION_ID_RE } from '../lib/session-files'
import type { AccountService } from './account-service'
import type { SettingsService } from './settings-service'
import { defaultTerminalTitle, legacyTerminalTitle, type TerminalService } from './terminal-service'

/** What is remembered of a terminal. Login tabs are not. */
interface SavedTerminal {
  accountId: string
  authAccountId: string
  cwd: string
  mode: 'session' | 'shell'
  /** Continued on the next start if Claude Code has written it, otherwise a new session starts. */
  sessionId: string | null
  title: string
  /** Missing in files of older versions. */
  fixedTitle?: boolean
  /** Missing in files of older versions. */
  muted?: boolean
  /**
   * On the first terminal of a tab that holds several: how they share its space. Instead of ids its
   * parts name the terminals by their index in the file. Older versions open them in tabs of their own.
   */
  layout?: PaneNode
}

/** What is remembered of a browser: its page. Older versions skip it, the others take its space. */
interface SavedBrowser {
  mode: 'browser'
  url: string
  title: string
  fixedTitle: boolean
  layout?: PaneNode
}

type SavedTab = SavedTerminal | SavedBrowser

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
    const accounts = new Map(this.accounts.list().map((a) => [a.id, a]))
    /** Index in the file → id of the terminal opened for it. */
    const opened = new Map<string, string>()
    for (const [index, tab] of saved.entries()) {
      if (isSavedBrowser(tab)) {
        const info = this.terminals.openBrowser({ url: tab.url, title: tab.fixedTitle ? tab.title : null })
        opened.set(String(index), info.id)
        continue
      }
      if (!isSavedTerminal(tab) || !accounts.has(tab.accountId)) continue
      // Without the lending account the session runs with its own login again.
      const auth = accounts.get(tab.authAccountId) ?? accounts.get(tab.accountId)!
      // Older versions saved no flag: a title other than the default (theirs had the account in it) was chosen.
      const defaults = [defaultTerminalTitle(tab.mode, auth.name, tab.cwd), legacyTerminalTitle(tab.mode, auth.name, tab.cwd)]
      const fixedTitle = tab.fixedTitle ?? !defaults.includes(tab.title)
      // In the folder the session is in now: `/cd` may have moved it after the tab was saved.
      const located = tab.sessionId ? await this.locate(tab.accountId, tab.sessionId, tab.cwd) : null
      try {
        const info = this.terminals.create({
          accountId: tab.accountId,
          authAccountId: auth.id,
          cwd: located?.cwd ?? tab.cwd,
          mode: tab.mode,
          resumeSessionId: located ? tab.sessionId : null,
          title: fixedTitle ? tab.title : null,
          muted: tab.muted === true,
        })
        opened.set(String(index), info.id)
      } catch {
        // e.g. the folder no longer exists: the tab is left out.
      }
    }
    for (const tab of saved) {
      const layout = parsePaneNode((tab as SavedTab | null)?.layout)
      if (!layout) continue
      // Terminals that didn't open leave their space to the others.
      const missing = new Set(paneIds(layout).filter((index) => !opened.has(index)))
      const rest = removePanes(layout, missing)
      if (isSplit(rest)) this.terminals.arrange(mapPanes(rest, (index) => opened.get(index)!))
    }
  }

  /** The tab's session, if it has a transcript to resume, with the folder it goes on in. */
  private async locate(accountId: string, sessionId: string, cwd: string): Promise<{ cwd: string } | null> {
    try {
      const located = await locateTranscript(this.accounts.paths(accountId).projectsDir, sessionId, cwd)
      return located ? { cwd: located.cwd ?? cwd } : null
    } catch {
      return null
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

  private snapshot(): SavedTab[] {
    const terminals = this.terminals.list().filter((t) => t.mode !== 'login')
    const index = new Map(terminals.map((t, i) => [t.id, String(i)]))
    /** Id of a tab's first terminal → how the tab shares its space, by index. Login tabs are left out. */
    const layouts = new Map<string, PaneNode>()
    for (const split of this.terminals.layouts()) {
      const saved = removePanes(split, new Set(paneIds(split).filter((id) => !index.has(id))))
      if (isSplit(saved)) layouts.set(paneIds(saved)[0], mapPanes(saved, (id) => index.get(id)!))
    }
    return terminals.map((t): SavedTab => {
      const layout = layouts.has(t.id) ? { layout: layouts.get(t.id) } : {}
      if (t.mode === 'browser') {
        return { mode: 'browser', url: t.url ?? '', title: t.title, fixedTitle: t.fixedTitle, ...layout }
      }
      return {
        accountId: t.accountId,
        authAccountId: t.authAccountId,
        cwd: t.cwd,
        mode: t.mode === 'shell' ? 'shell' : 'session',
        sessionId: t.sessionId,
        title: t.title,
        fixedTitle: t.fixedTitle,
        muted: t.muted,
        ...layout,
      }
    })
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
    typeof t.title === 'string' &&
    (t.fixedTitle === undefined || typeof t.fixedTitle === 'boolean') &&
    (t.muted === undefined || typeof t.muted === 'boolean')
  )
}

function isSavedBrowser(value: unknown): value is SavedBrowser {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    t.mode === 'browser' &&
    typeof t.url === 'string' &&
    isBrowsableUrl(t.url) &&
    typeof t.title === 'string' &&
    typeof t.fixedTitle === 'boolean'
  )
}
