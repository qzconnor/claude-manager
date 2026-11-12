import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isSplit, mapPanes, paneIds, removePanes } from '@shared/panes'
import { MAX_TAB_SETS, parseTabSetTabs, tabSetNameError, tabSetTabLabel } from '@shared/tab-sets'
import type { TabSet, TabSetInput, TabSetOpenResult, TabSetTab, TabSetTerminal } from '@shared/types'
import { readJsonGuardedSync, writeJsonAtomic } from '../lib/json-file'
import { locateTranscript } from '../lib/session-files'
import { TypedEmitter } from '../lib/typed-emitter'
import type { AccountService } from './account-service'
import { folderState } from './terminal-restore'
import type { TerminalService } from './terminal-service'

type Events = {
  changed: [sets: TabSet[]]
}

interface TabSetFile {
  sets: TabSet[]
}

/** Where a session or shell of a set starts: in the folder its session is in now, if it is there. */
interface Place {
  cwd: string
  folder: 'ok' | 'missing' | 'unreachable'
  /** Its session has a transcript to go on with. */
  resume: boolean
}

/** How long a shell has to be quiet after its first output before its command is typed: its prompt is there. */
const PROMPT_QUIET_MS = 300
/** A shell that writes nothing, or keeps writing, gets its command after this time anyway. */
const PROMPT_WAIT_MS = 10_000

const ID_RE = /^[\w-]{1,64}$/

/**
 * Tab sets: tabs saved under a name (sessions, shells, browsers, split tabs), to open them all again
 * with one click, e.g. a project's session with its dev server and its page. Kept in `tab-sets.json`.
 *
 * A session goes on with its session while that is there, else a new one starts in its folder; a
 * shell types its start command once its prompt is there. A tab whose folder or account is gone
 * doesn't open, the others do.
 */
export class TabSetService extends TypedEmitter<Events> {
  private readonly file: string
  private sets: TabSet[] = []
  /** Sets that are opening: a second click meanwhile would open each tab twice. */
  private readonly opening = new Set<string>()
  /** Shells waiting for their prompt to get their start command, to give up on quitting. */
  private readonly waiting = new Set<() => void>()

  constructor(
    userDataDir: string,
    private readonly terminals: TerminalService,
    private readonly accounts: AccountService,
  ) {
    super()
    this.file = join(userDataDir, 'tab-sets.json')
  }

  init(): void {
    const data = readJsonGuardedSync<Partial<TabSetFile>>(this.file)
    const sets = Array.isArray(data?.sets) ? data.sets : []
    const ids = new Set<string>()
    for (const value of sets.slice(0, MAX_TAB_SETS)) {
      const set = parseTabSet(value)
      if (!set || ids.has(set.id)) continue
      ids.add(set.id)
      this.sets.push(set)
    }
  }

  dispose(): void {
    for (const stop of [...this.waiting]) stop()
  }

  /** The sets, in the order they were made. */
  list(): TabSet[] {
    return structuredClone(this.sets)
  }

  /** Makes a set, or replaces the one with `input.id` (keeping its place). */
  async save(input: TabSetInput): Promise<TabSet> {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    const nameError = tabSetNameError(name)
    if (nameError) throw new Error(nameError)
    const tabs = parseTabSetTabs(input?.tabs)
    if (!tabs) throw new Error('Das Tab-Set braucht Tabs, höchstens 50, jeder mit Ordner und Account oder Seite.')
    const id = input.id ?? null
    const at = id === null ? -1 : this.sets.findIndex((s) => s.id === id)
    if (id !== null && at < 0) throw new Error('Das Tab-Set gibt es nicht mehr.')
    const key = name.toLocaleLowerCase()
    const taken = this.sets.some((s) => s.id !== id && s.name.toLocaleLowerCase() === key)
    if (taken) throw new Error(`Ein Tab-Set „${name}“ gibt es schon.`)
    if (at < 0 && this.sets.length >= MAX_TAB_SETS) throw new Error(`Es gibt schon ${MAX_TAB_SETS} Tab-Sets.`)
    const set: TabSet = { id: id ?? randomUUID(), name, tabs, savedAt: new Date().toISOString() }
    const sets = [...this.sets]
    if (at < 0) sets.push(set)
    else sets[at] = set
    await this.write(sets)
    return structuredClone(set)
  }

  async remove(id: string): Promise<void> {
    if (!this.sets.some((s) => s.id === id)) return
    await this.write(this.sets.filter((s) => s.id !== id))
  }

  /**
   * Opens the tabs of the set `id` after the open ones, split tabs as they were. A session that runs,
   * or waits, in a tab already isn't opened again: that tab is it.
   */
  async open(id: string): Promise<TabSetOpenResult> {
    const set = this.sets.find((s) => s.id === id)
    if (!set) throw new Error('Das Tab-Set gibt es nicht mehr.')
    if (this.opening.has(id)) return { firstId: null, failed: [] }
    this.opening.add(id)
    try {
      return await this.openTabs(set.tabs)
    } finally {
      this.opening.delete(id)
    }
  }

  private async openTabs(tabs: TabSetTab[]): Promise<TabSetOpenResult> {
    // All at once: a folder on a network drive that is gone takes seconds to give up on.
    const places = await Promise.all(tabs.map((tab) => (tab.mode === 'browser' ? null : this.place(tab))))
    /** Index in the set → id of the tab opened for it. Tabs that were open already keep their place. */
    const opened = new Map<string, string>()
    const failed: TabSetOpenResult['failed'] = []
    let firstId: string | null = null
    for (const [index, tab] of tabs.entries()) {
      try {
        const { id, fresh } =
          tab.mode === 'browser'
            ? { id: this.terminals.openBrowser({ url: tab.url, title: tab.title }).id, fresh: true }
            : await this.openTerminal(tab, places[index]!)
        if (fresh) opened.set(String(index), id)
        firstId ??= id
      } catch (error) {
        failed.push({ title: tabSetTabLabel(tab), reason: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const tab of tabs) {
      if (!tab.layout) continue
      // Tabs that didn't open leave their space to the others.
      const rest = removePanes(tab.layout, new Set(paneIds(tab.layout).filter((index) => !opened.has(index))))
      if (isSplit(rest)) this.terminals.arrange(mapPanes(rest, (index) => opened.get(index)!))
    }
    return { firstId, failed }
  }

  private async place(tab: TabSetTerminal): Promise<Place> {
    const located = tab.mode === 'session' && tab.sessionId ? await this.locate(tab.accountId, tab.sessionId, tab.cwd) : null
    // In the folder the session is in now: `/cd` may have moved it after the set was saved.
    const cwd = located?.cwd ?? tab.cwd
    return { cwd, folder: cwd ? await folderState(cwd) : 'ok', resume: located !== null }
  }

  private async openTerminal(tab: TabSetTerminal, place: Place): Promise<{ id: string; fresh: boolean }> {
    if (!this.accounts.list().some((a) => a.id === tab.accountId)) throw new Error('Den Account dieses Tabs gibt es nicht mehr.')
    if (place.folder === 'missing') throw new Error(`Den Ordner „${place.cwd}“ gibt es nicht.`)
    if (place.folder === 'unreachable') throw new Error(`Der Ordner „${place.cwd}“ war nicht erreichbar.`)
    const options = { accountId: tab.accountId, cwd: place.cwd, title: tab.title, muted: tab.muted }
    if (tab.mode === 'shell') {
      const info = this.terminals.create({ ...options, mode: 'shell' })
      if (tab.command) this.typeWhenReady(info.id, tab.command)
      return { id: info.id, fresh: true }
    }
    const resumeSessionId = place.resume ? tab.sessionId : null
    // Two processes must never write to the same transcript.
    const running = resumeSessionId ? this.terminals.runningSession(tab.accountId, resumeSessionId) : null
    if (running) return { id: running.id, fresh: false }
    const info = await this.terminals.open({ ...options, mode: 'session', resumeSessionId, args: tab.args })
    if (!info) throw new Error('Nicht gestartet, abgebrochen.')
    return { id: info.id, fresh: true }
  }

  /** The session, if it has a transcript to go on with, with the folder it goes on in. */
  private async locate(accountId: string, sessionId: string, cwd: string): Promise<{ cwd: string } | null> {
    try {
      const located = await locateTranscript(this.accounts.paths(accountId).projectsDir, sessionId, cwd)
      return located ? { cwd: located.cwd ?? cwd } : null
    } catch {
      return null
    }
  }

  /** Types `command` into the shell `id` once its prompt is there: when it was quiet for a moment after its first output. */
  private typeWhenReady(id: string, command: string): void {
    let quiet: NodeJS.Timeout | undefined
    const stop = (): void => {
      clearTimeout(quiet)
      clearTimeout(limit)
      offData()
      offExit()
      this.waiting.delete(stop)
    }
    const type = (): void => {
      stop()
      this.terminals.write(id, `${command}\r`)
    }
    const offData = this.terminals.on('data', (from) => {
      if (from !== id) return
      clearTimeout(quiet)
      quiet = setTimeout(type, PROMPT_QUIET_MS)
    })
    const offExit = this.terminals.on('exit', (from) => {
      if (from === id) stop()
    })
    const limit = setTimeout(type, PROMPT_WAIT_MS)
    this.waiting.add(stop)
  }

  private async write(sets: TabSet[]): Promise<void> {
    await writeJsonAtomic(this.file, { sets } satisfies TabSetFile, { guarded: true })
    this.sets = sets
    this.emit('changed', this.list())
  }
}

function parseTabSet(value: unknown): TabSet | null {
  if (!value || typeof value !== 'object') return null
  const s = value as Record<string, unknown>
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return null
  if (typeof s.name !== 'string' || tabSetNameError(s.name) !== null) return null
  const tabs = parseTabSetTabs(s.tabs)
  if (!tabs) return null
  return { id: s.id, name: s.name.trim(), tabs, savedAt: typeof s.savedAt === 'string' ? s.savedAt : '' }
}
