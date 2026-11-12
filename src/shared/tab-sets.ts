import { isBrowsableUrl } from './browser'
import { lastingArgs } from './claude-args'
import { isSplit, mapPanes, paneIds, parsePaneNode, removePanes } from './panes'
import type { PaneNode, PaneSplit, TabSetTab, TerminalInfo } from './types'

/** Most tabs one set keeps: more than anyone opens at once. */
export const MAX_TAB_SET_TABS = 50
/** More sets than anyone keeps; the menu lists them all. */
export const MAX_TAB_SETS = 100
export const MAX_TAB_SET_NAME = 80
/** A shell's start command is one line. */
export const MAX_TAB_SET_COMMAND = 2000
const MAX_TITLE = 120
const MAX_PATH = 4096
const MAX_ARGS = 64
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Why `name` can't name a set; null when it can. */
export function tabSetNameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Gib dem Tab-Set einen Namen.'
  if (trimmed.length > MAX_TAB_SET_NAME) return `Der Name ist zu lang (höchstens ${MAX_TAB_SET_NAME} Zeichen).`
  return null
}

/** Why `command` can't start a shell of a set; null when it can (also for none). */
export function tabSetCommandError(command: string): string | null {
  if (/[\r\n]/.test(command)) return 'Der Startbefehl ist eine Zeile.'
  if (command.length > MAX_TAB_SET_COMMAND) return `Der Startbefehl ist zu lang (höchstens ${MAX_TAB_SET_COMMAND} Zeichen).`
  return null
}

/**
 * The tabs of a set from outside (the window, the file): null unless there are some, not too many,
 * and each one is valid. A split tab whose parts don't fit (another tab's index, one that is gone,
 * a part of two split tabs) opens its parts as tabs of their own.
 */
export function parseTabSetTabs(value: unknown): TabSetTab[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TAB_SET_TABS) return null
  const tabs: TabSetTab[] = []
  for (const item of value) {
    const tab = parseTab(item)
    if (!tab) return null
    tabs.push(tab)
  }
  const taken = new Set<string>()
  return tabs.map((tab, i) => {
    if (!tab.layout) return tab
    const { layout, ...rest } = tab
    const ids = paneIds(layout)
    const fits =
      ids[0] === String(i) && ids.every((id) => /^\d+$/.test(id) && Number(id) < tabs.length && !taken.has(id)) && isSplit(layout)
    if (!fits) return rest
    for (const id of ids) taken.add(id)
    return { ...rest, layout }
  })
}

function parseTab(value: unknown): TabSetTab | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim().slice(0, MAX_TITLE) : null
  if (t.title !== null && t.title !== undefined && typeof t.title !== 'string') return null
  const layout = t.layout === undefined ? null : parsePaneNode(t.layout)
  const withLayout = layout ? { layout } : {}
  if (t.mode === 'browser') {
    if (typeof t.url !== 'string' || !isBrowsableUrl(t.url)) return null
    return { mode: 'browser', url: t.url, title, ...withLayout }
  }
  if (t.mode !== 'session' && t.mode !== 'shell') return null
  if (typeof t.accountId !== 'string' || !t.accountId) return null
  if (typeof t.cwd !== 'string' || t.cwd.length > MAX_PATH) return null
  if (typeof t.muted !== 'boolean') return null
  const args = t.args ?? []
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((arg) => typeof arg === 'string' && arg.length <= MAX_PATH)) return null
  const session = t.mode === 'session'
  const sessionId = t.sessionId ?? null
  if (sessionId !== null && (!session || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) return null
  const command = typeof t.command === 'string' ? t.command.trim() : (t.command ?? null)
  if (command !== null && (session || typeof command !== 'string' || tabSetCommandError(command) !== null)) return null
  return {
    mode: t.mode,
    accountId: t.accountId,
    cwd: t.cwd,
    title,
    muted: t.muted,
    args: session ? (args as string[]) : [],
    sessionId,
    command: command || null,
    ...withLayout,
  }
}

/**
 * The open tabs `terminals` as tabs of a set, in this order: sessions and shells with their folder,
 * account, name and session, browsers with their page. Login tabs are left out. Split tabs keep how
 * their parts share their space, among the tabs taken (see `TabSetTerminal.layout`).
 */
export function tabSetTabs(terminals: readonly TerminalInfo[], splits: readonly PaneSplit[]): TabSetTab[] {
  const taken = terminals.filter((t) => t.mode !== 'login')
  const index = new Map(taken.map((t, i) => [t.id, String(i)]))
  const layouts = new Map<string, PaneNode>()
  for (const split of splits) {
    const kept = removePanes(split, new Set(paneIds(split).filter((id) => !index.has(id))))
    if (isSplit(kept)) {
      const layout = mapPanes(kept, (id) => index.get(id)!)
      layouts.set(paneIds(layout)[0], layout)
    }
  }
  return taken.map((t, i): TabSetTab => {
    const layout = layouts.get(String(i))
    const title = t.fixedTitle ? t.title : null
    if (t.mode === 'browser') return { mode: 'browser', url: t.url ?? '', title, ...(layout ? { layout } : {}) }
    const session = t.mode === 'session'
    return {
      mode: session ? 'session' : 'shell',
      accountId: t.accountId,
      cwd: t.cwd,
      title,
      muted: t.muted,
      args: session ? lastingArgs(t.args) : [],
      sessionId: session ? t.sessionId : null,
      command: null,
      ...(layout ? { layout } : {}),
    }
  })
}

/**
 * The tabs `keep` picks, with the split tabs among them sharing their space as before: parts that go
 * leave their space to the others, a split tab left with one part becomes a tab of its own.
 */
export function keepTabs(tabs: readonly TabSetTab[], keep: (tab: TabSetTab, index: number) => boolean): TabSetTab[] {
  /** Old index → new index. */
  const kept = new Map<string, string>()
  tabs.forEach((tab, i) => {
    if (keep(tab, i)) kept.set(String(i), String(kept.size))
  })
  /** New index of its first part → how the split tab shares its space. */
  const layouts = new Map<string, PaneNode>()
  for (const tab of tabs) {
    if (!tab.layout) continue
    const rest = removePanes(tab.layout, new Set(paneIds(tab.layout).filter((i) => !kept.has(i))))
    if (!isSplit(rest)) continue
    const layout = mapPanes(rest, (i) => kept.get(i)!)
    layouts.set(paneIds(layout)[0], layout)
  }
  return tabs.flatMap((tab, i) => {
    const at = kept.get(String(i))
    if (at === undefined) return []
    const { layout: _, ...rest } = tab
    const layout = layouts.get(at)
    return [layout ? { ...rest, layout } : rest]
  })
}

/** What a tab of a set is called: its name, else what it shows (a session's or shell's folder, a page's host). */
export function tabSetTabLabel(tab: TabSetTab): string {
  if (tab.title) return tab.title
  if (tab.mode === 'browser') {
    try {
      return new URL(tab.url).host || tab.url
    } catch {
      return tab.url
    }
  }
  const folder = tab.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? tab.cwd
  return `${tab.mode === 'shell' ? 'Shell' : 'Session'} · ${folder}`
}
