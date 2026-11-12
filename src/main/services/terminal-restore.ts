import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isBrowsableUrl } from '@shared/browser'
import { lastingArgs } from '@shared/claude-args'
import { isSplit, mapPanes, paneIds, parsePaneNode, removePanes } from '@shared/panes'
import type { PaneNode } from '@shared/types'
import { readJsonSync, writeJsonAtomicSync } from '../lib/json-file'
import { locateTranscript, SESSION_ID_RE } from '../lib/session-files'
import type { AccountService } from './account-service'
import type { SettingsService } from './settings-service'
import { defaultTerminalTitle, legacyTerminalTitle, type SleepingTerminal, type TerminalService } from './terminal-service'

/** What is remembered of a terminal. Login tabs are not. */
interface SavedTerminal {
  /** Its id in that run, so the window can put it back into its group. Missing in files of older versions. */
  id?: string
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
  /** Claude Code arguments that hold for every start (see `lastingArgs`). Missing in files of older versions. */
  args?: string[]
  /**
   * On the first terminal of a tab that holds several: how they share its space. Instead of ids its
   * parts name the terminals by their index in the file. Older versions open them in tabs of their own.
   */
  layout?: PaneNode
}

/** What is remembered of a browser: its page. Older versions skip it, the others take its space. */
interface SavedBrowser {
  id?: string
  mode: 'browser'
  url: string
  title: string
  fixedTitle: boolean
  layout?: PaneNode
}

type SavedTab = SavedTerminal | SavedBrowser

/** How long a tab waits for its folder when it starts, e.g. on a network drive that is gone. */
const FOLDER_TIMEOUT_MS = 4000

/**
 * Remembers the open tabs and opens them again on the next start (setting `general.restoreTerminals`).
 * The file is rewritten on every change, so the tabs are also back after the app was ended abruptly.
 *
 * Terminals come back waiting (see `TerminalService.sleep`) and start once the window shows them
 * (`wake`), or right after the start without `general.restoreAsleep`. One that doesn't start, e.g.
 * because its folder is gone, keeps waiting with the reason, until it is tried again or closed.
 */
export class TerminalRestore {
  private readonly file: string
  /** Content of the file, so unchanged state is not written again. */
  private written: string
  private offs: (() => void)[] = []
  private disposed = false
  /** Until then (ms) the file keeps the tabs as they were: see `hold`. */
  private heldUntil = 0
  private holdTimer: NodeJS.Timeout | undefined
  /** The tabs that wait to start, by their id, as the file had them. */
  private readonly asleep = new Map<string, SavedTerminal>()
  /** Those starting right now. */
  private readonly waking = new Set<string>()

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
    if (this.settings.get().general.restoreTerminals) this.restore()
    if (this.disposed) return
    this.offs = [
      this.terminals.on('changed', (list) => {
        // Closed while they waited.
        const ids = new Set(list.map((t) => t.id))
        for (const id of this.asleep.keys()) if (!ids.has(id)) this.asleep.delete(id)
        this.save()
      }),
      this.settings.on('changed', (next, previous) => {
        if (next.general.restoreTerminals !== previous.general.restoreTerminals) this.save()
      }),
    ]
    this.save()
    // Started now, one after the other, as before tabs waited.
    if (!this.settings.get().general.restoreAsleep) for (const id of [...this.asleep.keys()]) await this.wake(id)
  }

  /** Stops following the tabs. Must run before quitting closes them all. */
  dispose(): void {
    this.disposed = true
    clearTimeout(this.holdTimer)
    for (const off of this.offs) off()
    this.offs = []
  }

  /**
   * Starts a tab that waits; the window asks once it shows it, or to try again. One that doesn't start
   * keeps waiting, with the reason.
   */
  async wake(id: string): Promise<void> {
    const tab = this.asleep.get(id)
    if (!tab || this.waking.has(id) || this.disposed) return
    this.waking.add(id)
    this.terminals.setSleep(id, { waking: true, error: null })
    try {
      const error = await this.start(id, tab)
      // Closed or started in another way (e.g. with another account) while its folder was looked at.
      if (this.disposed || !this.asleep.has(id)) return
      if (error === null) this.asleep.delete(id)
      else this.terminals.setSleep(id, { waking: false, error })
    } finally {
      this.waking.delete(id)
    }
  }

  private restore(): void {
    const saved = readJsonSync<unknown>(this.file)
    if (!Array.isArray(saved)) return
    /** Index in the file → id of the tab opened for it. */
    const opened = new Map<string, string>()
    for (const [index, tab] of saved.entries()) {
      if (isSavedBrowser(tab)) {
        const info = this.terminals.openBrowser({ url: tab.url, title: tab.fixedTitle ? tab.title : null, restoredFrom: savedId(tab) })
        opened.set(String(index), info.id)
        continue
      }
      if (!isSavedTerminal(tab)) continue
      const sleeping = this.sleeping(tab)
      if (!sleeping) continue
      const info = this.terminals.sleep(sleeping)
      this.asleep.set(info.id, tab)
      opened.set(String(index), info.id)
    }
    for (const tab of saved) {
      const layout = parsePaneNode((tab as SavedTab | null)?.layout)
      if (!layout) continue
      // Tabs that can't come back leave their space to the others.
      const missing = new Set(paneIds(layout).filter((index) => !opened.has(index)))
      const rest = removePanes(layout, missing)
      if (isSplit(rest)) this.terminals.arrange(mapPanes(rest, (index) => opened.get(index)!))
    }
  }

  /** How a saved terminal waits to start; null when it can't come back (its account is gone). */
  private sleeping(tab: SavedTerminal): SleepingTerminal | null {
    const accounts = new Map(this.accounts.list().map((a) => [a.id, a]))
    if (!accounts.has(tab.accountId)) return null
    // Without the lending account the session runs with its own login again.
    const auth = accounts.get(tab.authAccountId) ?? accounts.get(tab.accountId)!
    // Older versions saved no flag: a title other than the default (theirs had the account in it) was chosen.
    const defaults = [defaultTerminalTitle(tab.mode, auth.name, tab.cwd), legacyTerminalTitle(tab.mode, auth.name, tab.cwd)]
    const fixedTitle = tab.fixedTitle ?? !defaults.includes(tab.title)
    return {
      accountId: tab.accountId,
      authAccountId: auth.id,
      cwd: tab.cwd,
      mode: tab.mode,
      sessionId: tab.sessionId,
      // A default title, also one of an older version, follows the folder the tab starts in.
      title: fixedTitle || !defaults.includes(tab.title) ? tab.title : null,
      fixedTitle,
      muted: tab.muted === true,
      args: tab.args ?? [],
      restoredFrom: savedId(tab),
    }
  }

  /** Starts the waiting tab `id` in its place; the reason when it doesn't start, null when it did. */
  private async start(id: string, tab: SavedTerminal): Promise<string | null> {
    // As it is now: it may have been renamed or muted while it waited.
    const waiting = this.terminals.list().find((t) => t.id === id)
    if (!waiting) return null
    const auth = this.accounts.list().find((a) => a.id === waiting.authAccountId)
    if (!auth) return 'Den Account dieses Tabs gibt es nicht mehr.'
    // In the folder the session is in now: `/cd` may have moved it after the tab was saved.
    const located = tab.sessionId ? await this.locate(tab.accountId, tab.sessionId, tab.cwd) : null
    const cwd = located?.cwd ?? tab.cwd
    // Checked without blocking first: starting the terminal looks at the folder synchronously.
    const folder = cwd ? await folderState(cwd) : 'ok'
    // The app quits, or the tab went, while it waited for its folder.
    if (this.disposed || !this.asleep.has(id)) return null
    if (folder === 'missing') return `Den Ordner „${cwd}“ gibt es nicht.`
    if (folder === 'unreachable') return `Der Ordner „${cwd}“ war nicht erreichbar.`
    // Two processes must never write to the same transcript.
    const elsewhere = this.terminals.runningSession(tab.accountId, tab.sessionId ?? '')
    if (located && elsewhere && elsewhere.id !== id) return 'Die Session läuft schon in einem anderen Tab.'
    try {
      this.terminals.wake(id, {
        accountId: tab.accountId,
        authAccountId: auth.id,
        cwd,
        mode: tab.mode,
        resumeSessionId: located ? tab.sessionId : null,
        title: waiting.fixedTitle ? waiting.title : null,
        muted: waiting.muted,
        args: waiting.args,
        restoredFrom: waiting.restoredFrom ?? null,
      })
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
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

  /**
   * Keeps the tabs as they are now for `ms`: the system is about to shut down or log off, and its
   * processes end before the app does, which would close tabs and leave them out of the file. Should
   * the session go on after all, the tabs are followed again after that time.
   */
  hold(ms: number): void {
    if (this.disposed) return
    this.heldUntil = 0
    this.save()
    this.heldUntil = Date.now() + ms
    clearTimeout(this.holdTimer)
    this.holdTimer = setTimeout(() => {
      this.heldUntil = 0
      if (!this.disposed) this.save()
    }, ms)
  }

  private save(): void {
    if (Date.now() < this.heldUntil) return
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
    const open = terminals.map((t): SavedTab => {
      const layout = layouts.has(t.id) ? { layout: layouts.get(t.id) } : {}
      if (t.mode === 'browser') {
        return { id: t.id, mode: 'browser', url: t.url ?? '', title: t.title, fixedTitle: t.fixedTitle, ...layout }
      }
      return {
        id: t.id,
        accountId: t.accountId,
        authAccountId: t.authAccountId,
        cwd: t.cwd,
        mode: t.mode === 'shell' ? 'shell' : 'session',
        sessionId: t.sessionId,
        title: t.title,
        fixedTitle: t.fixedTitle,
        muted: t.muted,
        ...(t.args.length ? { args: lastingArgs(t.args) } : {}),
        ...layout,
      }
    })
    return open
  }
}

/** Whether a folder is there, without waiting long for one on a network drive that is gone. */
async function folderState(dir: string): Promise<'ok' | 'missing' | 'unreachable'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'unreachable'>((resolve) => {
    timer = setTimeout(() => resolve('unreachable'), FOLDER_TIMEOUT_MS)
  })
  const check = stat(dir).then(
    (info) => (info.isDirectory() ? ('ok' as const) : ('missing' as const)),
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? ('missing' as const) : ('unreachable' as const)),
  )
  try {
    return await Promise.race([check, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function savedId(tab: SavedTab): string | null {
  return typeof tab.id === 'string' && /^[\w-]{1,64}$/.test(tab.id) ? tab.id : null
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
    (t.muted === undefined || typeof t.muted === 'boolean') &&
    (t.args === undefined || (Array.isArray(t.args) && t.args.every((arg) => typeof arg === 'string')))
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
