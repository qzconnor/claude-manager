import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { moveItem } from '@shared/order'
import {
  dropPanes,
  hasPane,
  insertPane,
  isSplit,
  mapPanes,
  neighbourPane,
  ownerOf,
  paneIds,
  parsePaneNode,
  removePanes,
  setRatio,
  type PaneDirection,
  type SplitPath,
} from '@shared/panes'
import type { BrowserOpenOptions, PaneNode, PaneSplit, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { groupTabs, type TerminalTabGroup } from '@/lib/tabs'
import {
  addTab,
  allTabs,
  createWorkspace,
  dockTab,
  findGroup,
  groupOfTab,
  mapTabs,
  moveTab,
  pageOfTab,
  pageTab,
  parseWorkspace,
  removeGroup,
  removeTab,
  replaceTab,
  resizeGroups as resizeWorkspace,
  setActive,
  showTab,
  splitGroup,
  type DropSide,
  type PageName,
  type Workspace,
} from '@/lib/workspace'
import { useSettingsStore } from './settings'

/** A tab with the terminal in it that has (or last had) the keyboard. */
export interface TerminalTab extends TerminalTabGroup {
  focused: TerminalInfo
}

/** With the tabs in groups, a tab of a group: a terminal, or one of the app's pages. */
export type GroupTabItem = { id: string; terminal: TerminalInfo; page?: undefined } | { id: string; page: PageName; terminal?: undefined }

/** A group with what its tabs show, in the order of its tab bar. */
export interface GroupView {
  id: string
  tabs: GroupTabItem[]
  /** The tab it shows. */
  active: string | null
}

/** Where a new terminal goes in the groups: beside a terminal (in a new group), or right before one (taking its place). */
type Placement = { beside: string; side: PaneDirection } | { before: string } | null

const STORAGE_KEY = 'claude-manager.workspace'

interface SavedWorkspace {
  workspace: Workspace
  /** The terminals in the order main restores them, with their mode: after a restart they have new ids. */
  order: { id: string; mode: TerminalInfo['mode'] }[]
}

/** A copy without Vue's proxies, which IPC can't send. */
const plain = (layout: PaneNode) => mapPanes(layout, (id) => id)

const newGroupId = () => `g-${Math.random().toString(36).slice(2, 10)}`

const sideOf = (direction: 'row' | 'column'): PaneDirection => (direction === 'column' ? 'down' : 'right')

/** The split whose part is exactly `id`, if main put it beside another terminal. */
function parentOf(node: PaneNode, id: string): PaneSplit | null {
  if (!isSplit(node)) return null
  if (node.first === id || node.second === id) return node
  return parentOf(node.first, id) ?? parentOf(node.second, id)
}

/**
 * The open terminals and their two layouts, one for each way of showing tabs (setting
 * `appearance.tabPosition`):
 * - In one tab bar (title bar or sidebar), a tab holds one terminal or several side by side. Main keeps
 *   that layout (`splits`, the order of the terminals) and restores it on the next start.
 * - In groups like VS Code's editor groups, every part of the window has its own tab bar, and the pages
 *   open as tabs too. The window keeps that layout (`workspace`, in localStorage).
 * Neither is converted into the other: each comes back as it was left. Terminals opened in the
 * meantime come where they were opened: beside the terminal they were split from (main keeps every
 * split, so both layouts know it), otherwise at the end.
 */
export const useTerminalsStore = defineStore('terminals', () => {
  const settings = useSettingsStore()
  /** The tabs are in groups, not in one tab bar. */
  const grouped = computed(() => settings.settings.appearance.tabPosition === 'groups')

  /** Every terminal; in one tab bar, in the order of its tabs (the terminals of a split tab may lie apart). */
  const terminals = ref<TerminalInfo[]>([])
  /** The tabs with more than one terminal, as the main process keeps them. */
  const splits = ref<PaneSplit[]>([])
  /** The terminals in main's order with their modes: the order main restores them in on the next start. */
  const mainOrder = ref<SavedWorkspace['order']>([])
  /** The groups and their tabs. */
  const workspace = ref<Workspace>(createWorkspace(newGroupId()))
  /** The terminal that has (or last had) the keyboard: in one tab bar, the focused part of the selected tab. */
  const activeId = ref<string | null>(null)
  /** When each terminal last had the keyboard, so a tab gives it back to the same one. */
  const focusedAt = reactive(new Map<string, number>())
  let focusCount = 0
  /** Terminals another one took the place of; they close shortly and get no tab of their own meanwhile. */
  const retired = new Set<string>()

  const byId = computed(() => new Map(terminals.value.map((t) => [t.id, t])))

  /** Of some terminals (at least one), the one that last had the keyboard. */
  const lastFocused = (list: TerminalInfo[]) =>
    list.reduce((best, t) => ((focusedAt.get(t.id) ?? 0) > (focusedAt.get(best.id) ?? 0) ? t : best))
  const focusedOf = (tab: TerminalTabGroup) => lastFocused(tab.panes)

  // ── One tab bar ──

  const tabs = computed<TerminalTab[]>(() =>
    groupTabs(terminals.value, splits.value).map((tab) => ({ ...tab, focused: focusedOf(tab) })),
  )
  const activeTab = computed(() => tabOf(activeId.value))

  function tabOf(id: string | null): TerminalTab | null {
    return id ? (tabs.value.find((tab) => tab.panes.some((p) => p.id === id)) ?? null) : null
  }

  // ── Groups ──

  const groups = computed<GroupView[]>(() =>
    paneIds(workspace.value.layout).flatMap((id) => {
      const group = findGroup(workspace.value, id)
      if (!group) return []
      const items = group.tabs.flatMap<GroupTabItem>((tab) => {
        const page = pageOfTab(tab)
        if (page) return [{ id: tab, page }]
        const terminal = byId.value.get(tab)
        return terminal ? [{ id: tab, terminal }] : []
      })
      return [{ id, tabs: items, active: group.active }]
    }),
  )
  const activeGroup = computed(() => groups.value.find((g) => g.id === workspace.value.activeGroup) ?? groups.value[0] ?? null)
  /** The terminals on screen with the tabs in groups: what each group shows. */
  const visibleIds = computed(() => groups.value.flatMap((g) => (g.active && byId.value.has(g.active) ? [g.active] : [])))

  function groupOf(tab: string): GroupView | null {
    return groups.value.find((g) => g.tabs.some((t) => t.id === tab)) ?? null
  }

  // ── Both ──

  /** The tab with the keyboard: in groups the one the active group shows (a terminal or a page), else the terminal. */
  const focusedTab = computed(() => (grouped.value ? (activeGroup.value?.active ?? null) : activeId.value))
  /** The page whose tab has the keyboard; only with the tabs in groups, otherwise pages aren't tabs. */
  const focusedPage = computed(() => (grouped.value ? pageOfTab(focusedTab.value) : null))
  const active = computed(() => (activeId.value ? (byId.value.get(activeId.value) ?? null) : null))
  /** The terminal whose account and folder the window shows (see `workingTerminalOf`). */
  const workingTerminal = computed(() => workingTerminalOf(active.value))
  /** Terminals with a process; browsers run none. */
  const runningCount = computed(() => terminals.value.filter((t) => t.status === 'running' && t.mode !== 'browser').length)

  /**
   * The terminal itself, or for a browser the terminal beside it in main's layout that last had the
   * keyboard (in groups, else the one of its group): the account and folder the browser works with.
   * A browser alone has none.
   */
  function workingTerminalOf(terminal: TerminalInfo | null): TerminalInfo | null {
    if (terminal?.mode !== 'browser') return terminal
    const notBrowser = (ids: string[]) =>
      ids.flatMap((id) => {
        const t = byId.value.get(id)
        return t && t.mode !== 'browser' ? [t] : []
      })
    const split = splits.value.find((s) => hasPane(s, terminal.id))
    const beside = split ? notBrowser(paneIds(split)) : []
    const others = beside.length || !grouped.value ? beside : notBrowser(groupOf(terminal.id)?.tabs.map((t) => t.id) ?? [])
    return others.length ? lastFocused(others) : null
  }

  function focus(id: string | null): void {
    activeId.value = id
    if (id) focusedAt.set(id, ++focusCount)
  }

  // ── Browsers and their sessions ──

  /**
   * The session (or shell) a browser belongs to: the one it was opened beside, as main keeps it in the
   * same split, also over a restart (see `ownerOf`). Null for a browser on its own. The browsers go
   * with their session when it closes (main does that).
   */
  function sessionOf(browserId: string): TerminalInfo | null {
    const split = splits.value.find((s) => hasPane(s, browserId))
    const owner = split ? ownerOf(split, browserId, (id) => !!byId.value.get(id) && byId.value.get(id)!.mode !== 'browser') : null
    return owner ? (byId.value.get(owner) ?? null) : null
  }

  /** When the terminal last had the keyboard (0: never). */
  function focusedAtOf(id: string): number {
    return focusedAt.get(id) ?? 0
  }

  /** The browsers that belong to a session (see `sessionOf`). */
  function browsersOf(sessionId: string): TerminalInfo[] {
    return terminals.value.filter((t) => t.mode === 'browser' && sessionOf(t.id)?.id === sessionId)
  }

  /** The terminal itself, or for a browser its session; null for a browser on its own. */
  function sessionFor(terminal: TerminalInfo | null): TerminalInfo | null {
    return terminal?.mode === 'browser' ? sessionOf(terminal.id) : terminal
  }

  /** The tabs that go with a tab: a session's browsers, a browser's session. */
  function linked(tab: string): string[] {
    const terminal = byId.value.get(tab)
    if (!terminal) return []
    if (terminal.mode !== 'browser') return browsersOf(tab).map((b) => b.id)
    const session = sessionOf(tab)
    return session ? [session.id] : []
  }

  /**
   * With the tabs in groups, the tabs that go with `tab` are shown in their groups too, without the
   * keyboard; of several in one group the one that had it last.
   */
  function showLinked(ws: Workspace, tab: string): Workspace {
    const partners = linked(tab)
    if (partners.length === 0) return ws
    const own = groupOfTab(ws, tab)?.id
    for (const group of ws.groups) {
      const here = partners.filter((id) => group.tabs.includes(id))
      if (group.id === own || here.length === 0 || (group.active && here.includes(group.active))) continue
      const pick = here.reduce((best, id) => ((focusedAt.get(id) ?? 0) > (focusedAt.get(best) ?? 0) ? id : best))
      ws = showTab(ws, group.id, pick)
    }
    return ws
  }

  /**
   * After the groups changed: the shown tab of the active group has the keyboard. With a page there,
   * the last terminal keeps its claim, as long as it is open.
   */
  function settle(): void {
    const shown = activeGroup.value?.active ?? null
    if (shown && byId.value.has(shown)) {
      if (activeId.value !== shown) focus(shown)
      return
    }
    if (activeId.value && byId.value.has(activeId.value)) return
    const visible = visibleIds.value.flatMap((id) => byId.value.get(id) ?? [])
    const candidates = visible.length ? visible : terminals.value
    activeId.value = candidates.length ? lastFocused(candidates).id : null
  }

  /**
   * Puts a terminal without a tab into the groups. In one tab bar the groups follow along, so the
   * terminal is there when the tabs go into groups: beside the one it was split from, else at the end.
   */
  function place(ws: Workspace, terminal: TerminalInfo, placement: Placement): Workspace {
    if (placement && 'beside' in placement) {
      const group = groupOfTab(ws, placement.beside)
      if (group) {
        const isBrowser = (tab: string | null) => !!tab && byId.value.get(tab)?.mode === 'browser'
        if (terminal.mode === 'browser') {
          // Another browser for a session joins the browser it had, as a tab, and is shown.
          if (isBrowser(placement.beside)) {
            return addTab(ws, group.id, terminal.id, { index: group.tabs.indexOf(placement.beside) + 1, activate: true })
          }
          // Beside a session with a browser shown on that side already: a tab there too.
          const next = neighbourPane(ws.layout, group.id, placement.side)
          const there = next ? findGroup(ws, next) : undefined
          if (there && isBrowser(there.active)) return addTab(ws, there.id, terminal.id, { activate: true })
        }
        return splitGroup(ws, group.id, placement.side, newGroupId(), [terminal.id])
      }
    }
    if (placement && 'before' in placement) {
      const group = groupOfTab(ws, placement.before)
      if (group) return addTab(ws, group.id, terminal.id, { index: group.tabs.indexOf(placement.before) })
    }
    return addTab(ws, ws.activeGroup, terminal.id, grouped.value ? {} : { index: Infinity })
  }

  /**
   * Where main put a terminal it reported: in the place of the terminal after it (it replaces that one,
   * which leaves the tabs of main), or beside the terminal it shares a split with.
   */
  function placementOf(ws: Workspace, terminal: TerminalInfo, list: TerminalInfo[], before: PaneSplit[], after: PaneSplit[]): Placement {
    const index = list.indexOf(terminal)
    const following = list[index + 1]
    const inSplits = (all: PaneSplit[], id: string) => all.some((s) => hasPane(s, id))
    const placed = following && groupOfTab(ws, following.id)
    if (placed && inSplits(before, following.id) && !inSplits(after, following.id)) return { before: following.id }
    const split = after.map((s) => parentOf(s, terminal.id)).find((s) => s !== null)
    if (split) {
      const second = split.second === terminal.id
      const anchor = second ? paneIds(split.first).at(-1)! : paneIds(split.second)[0]
      const side = sideOf(split.direction)
      const flipped: Record<PaneDirection, PaneDirection> = { right: 'left', down: 'up', left: 'right', up: 'down' }
      return { beside: anchor, side: second ? side : flipped[side] }
    }
    return placed ? { before: following.id } : null
  }

  /**
   * Takes main's list in: the local order stays (the tab order in one tab bar), unknown terminals come
   * at the end, those another one replaced stay out. Both layouts follow.
   */
  function sync(next: TerminalInfo[], nextSplits: PaneSplit[]): void {
    const before = tabs.value
    const index = before.findIndex((tab) => tab.panes.some((p) => p.id === activeId.value))
    const splitsBefore = splits.value
    for (const id of retired) if (!next.some((t) => t.id === id)) retired.delete(id)
    const known = terminals.value.flatMap((t) => next.find((n) => n.id === t.id) ?? [])
    const added = next.filter((n) => !retired.has(n.id) && !terminals.value.some((t) => t.id === n.id))
    const list = [...known, ...added]
    terminals.value = list
    splits.value = nextSplits
    mainOrder.value = next.map((t) => ({ id: t.id, mode: t.mode }))
    const ids = new Set(list.map((t) => t.id))
    for (const id of focusedAt.keys()) if (!ids.has(id)) focusedAt.delete(id)

    let ws = workspace.value
    for (const tab of allTabs(ws)) if (!pageOfTab(tab) && !ids.has(tab)) ws = removeTab(ws, tab)
    for (const terminal of list) {
      if (groupOfTab(ws, terminal.id)) continue
      // By main's order: a terminal that replaces another comes right before it there.
      ws = place(ws, terminal, placementOf(ws, terminal, next, splitsBefore, nextSplits))
    }
    workspace.value = ws

    if (grouped.value) return settle()
    if (activeId.value && ids.has(activeId.value)) return
    // The terminal with the keyboard closed by itself: another one of its tab gets it, otherwise the
    // neighbour tab, as if closed by hand.
    const after = tabs.value
    const same = index === -1 ? undefined : after.find((tab) => tab.panes.some((p) => hasPane(before[index].layout, p.id)))
    const target = same ?? (index === -1 ? after.at(-1) : (after[index] ?? after[index - 1]))
    focus(target?.focused.id ?? null)
  }

  /** The groups of the last run, their terminals found again by their order if they have new ids. */
  function restore(list: TerminalInfo[]): Workspace | null {
    let saved: SavedWorkspace | null = null
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as SavedWorkspace | null
    } catch {
      return null
    }
    const ws = saved && parseWorkspace(saved.workspace)
    if (!ws || !Array.isArray(saved?.order)) return null
    const ids = new Set(list.map((t) => t.id))
    const savedTerminals = allTabs(ws).filter((tab) => !pageOfTab(tab))
    let map = new Map<string, string>()
    if (savedTerminals.every((id) => ids.has(id))) {
      map = new Map(savedTerminals.map((id) => [id, id]))
    } else {
      // Logins aren't restored. Terminals that can't be matched lose their tabs, the pages stay.
      const order = saved.order.filter((entry) => entry.mode !== 'login')
      const current = list.filter((t) => t.mode !== 'login')
      const browser = (mode: string) => mode === 'browser'
      if (order.length === current.length && order.every((entry, i) => browser(entry.mode) === browser(current[i].mode))) {
        map = new Map(order.map((entry, i) => [entry.id, current[i].id]))
      }
    }
    return mapTabs(ws, (tab) => (pageOfTab(tab) ? tab : (map.get(tab) ?? null)))
  }

  /** Set once the terminals are loaded; the setting loads before them. */
  let loaded = false

  async function load(): Promise<void> {
    const [list, layouts] = await Promise.all([window.api.terminals.list(), window.api.terminals.layouts()])
    workspace.value = restore(list) ?? createWorkspace(newGroupId())
    sync(list, layouts)
    loaded = true
  }

  /** Set once the app quits: its terminals close then, but come back on the next start. */
  let quitting = false
  window.api.app.onQuitting(() => (quitting = true))

  // The groups are kept for the next start, in both ways of showing tabs, so they can come back.
  watch([workspace, mainOrder], ([ws, order]) => {
    if (quitting) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ workspace: ws, order } satisfies SavedWorkspace))
    } catch {
      // Storage full or blocked: the layout is just not kept.
    }
  })

  // Switched to groups (not the setting arriving at the start): the pages open there last time stay
  // closed, only the page shown now comes along (see GroupShell). The terminal with the keyboard keeps
  // it, in its group.
  watch(grouped, (on) => {
    if (!on || !loaded) return
    let ws = workspace.value
    for (const tab of allTabs(ws)) if (pageOfTab(tab)) ws = removeTab(ws, tab)
    workspace.value = ws
    if (activeId.value && groupOfTab(ws, activeId.value)) activateTab(activeId.value)
    else settle()
  })

  /** Null when the user doesn't trust the folder (asked by the app before Claude Code starts). */
  async function open(options: TerminalCreateOptions): Promise<TerminalInfo | null> {
    const info = await window.api.terminals.create(options)
    if (info) show(info, placementFor(options.split))
    return info
  }

  /** A browser in a new tab or next to a terminal (`options.split`). */
  async function openBrowser(options: BrowserOpenOptions = {}): Promise<TerminalInfo> {
    const info = await window.api.terminals.openBrowser(options)
    show(info, placementFor(options.split))
    return info
  }

  function placementFor(split: TerminalCreateOptions['split']): Placement {
    return split ? { beside: split.terminalId, side: sideOf(split.direction) } : null
  }

  /** Shows a new terminal and gives it the keyboard; main's report may have placed it already. */
  function show(info: TerminalInfo, placement: Placement = null): void {
    if (!terminals.value.some((t) => t.id === info.id)) terminals.value = [...terminals.value, info]
    if (!groupOfTab(workspace.value, info.id)) workspace.value = place(workspace.value, info, placement)
    activate(info.id)
  }

  /**
   * Shows the tab in its group and gives that group the keyboard; a terminal gets the keyboard itself.
   * A session's browser comes forward with it, and a browser's session.
   */
  function activateTab(tab: string): void {
    const group = groupOfTab(workspace.value, tab)
    if (!group) return
    workspace.value = showLinked(setActive(workspace.value, group.id, tab), tab)
    if (byId.value.has(tab)) focus(tab)
  }

  /** Selects the terminal's tab and gives the terminal the keyboard. */
  function activate(id: string): void {
    if (!byId.value.has(id)) return
    if (grouped.value) activateTab(id)
    else focus(id)
  }

  /** With the tabs in groups, gives a group the keyboard, with the tab it shows. */
  function focusGroup(groupId: string): void {
    const group = findGroup(workspace.value, groupId)
    if (!group) return
    workspace.value = setActive(workspace.value, groupId)
    if (group.active) workspace.value = showLinked(workspace.value, group.active)
    if (group.active && byId.value.has(group.active)) focus(group.active)
  }

  /**
   * With the tabs in groups, opens a page as a tab of the first group (on the left, or at the top),
   * whichever group has the keyboard; open already, it is shown where it is.
   */
  function openPage(page: PageName): void {
    const tab = pageTab(page)
    if (!groupOfTab(workspace.value, tab)) workspace.value = addTab(workspace.value, paneIds(workspace.value.layout)[0], tab)
    activateTab(tab)
  }

  /** Closes a page's tab; its group shows the neighbour tab. */
  function closePage(page: PageName): void {
    workspace.value = removeTab(workspace.value, pageTab(page))
    settle()
  }

  /** Before the tab at `index` goes: the one after it, or the one before. */
  function neighbourTab(index: number): TerminalTab | undefined {
    return tabs.value[index + 1] ?? tabs.value[index - 1]
  }

  /**
   * In one tab bar the neighbour gets the keyboard before closing so the selection doesn't jump to the
   * end; in groups, the group shows the neighbour tab once main reports the terminal gone.
   */
  async function close(id: string): Promise<void> {
    if (!grouped.value && activeId.value === id) {
      const tab = tabOf(id)
      const others = tab?.panes.filter((p) => p.id !== id) ?? []
      if (tab && others.length > 0) focus(focusedOf({ ...tab, panes: others }).id)
      else focus((tab && neighbourTab(tabs.value.indexOf(tab))?.focused.id) ?? null)
    }
    await window.api.terminals.close(id)
  }

  /** In one tab bar, closes every terminal of the tab. */
  async function closeTab(tabId: string): Promise<void> {
    const index = tabs.value.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const tab = tabs.value[index]
    if (tab.panes.some((p) => p.id === activeId.value)) focus(neighbourTab(index)?.focused.id ?? null)
    await Promise.all(tab.panes.map((p) => window.api.terminals.close(p.id)))
  }

  async function kill(id: string): Promise<void> {
    await window.api.terminals.kill(id)
  }

  async function rename(id: string, title: string): Promise<void> {
    await window.api.terminals.rename(id, title)
  }

  async function setMuted(id: string, muted: boolean): Promise<void> {
    await window.api.terminals.setMuted(id, muted)
  }

  /** Tells main the order of the tabs in one tab bar, so the next start restores them in it. */
  function saveOrder(): void {
    window.api.terminals.reorder(terminals.value.map((t) => t.id))
  }

  /**
   * Puts the terminal that replaces `oldId` into its place, in both layouts, and selects it (unless
   * `select` is false). Asked twice (main's report and the answer), the second time changes nothing.
   */
  function replace(oldId: string, info: TerminalInfo, select = true): void {
    retired.add(oldId)
    const list = terminals.value.filter((t) => t.id !== info.id)
    const index = list.findIndex((t) => t.id === oldId)
    if (index !== -1 || list.length === terminals.value.length) {
      if (index === -1) list.push(info)
      else list.splice(index, 1, info)
      terminals.value = list
      if (!grouped.value) saveOrder()
    }
    if (groupOfTab(workspace.value, oldId)) workspace.value = replaceTab(workspace.value, oldId, info.id)
    else if (!groupOfTab(workspace.value, info.id)) workspace.value = place(workspace.value, info, null)
    if (select) activate(info.id)
    else if (grouped.value) settle()
  }

  /** Starts the same command again in a new terminal in the same place; the old one stays without trust. */
  async function restart(id: string): Promise<void> {
    const old = terminals.value.find((t) => t.id === id)
    // A browser has no command; its pane loads the page again instead.
    if (!old || old.mode === 'browser') return
    const info = await window.api.terminals.create({
      accountId: old.accountId,
      authAccountId: old.authAccountId,
      cwd: old.cwd,
      mode: old.mode,
      resumeSessionId: old.resumeSessionId,
      title: old.fixedTitle ? old.title : null,
      muted: old.muted,
      replaces: id,
    })
    if (!info) return
    // Before the old one closes, so its group doesn't go with it.
    replace(id, info)
    await window.api.terminals.close(id)
  }

  /** Continues the terminal's session with another account's limits, in a new one in the same place. */
  async function continueWith(id: string, accountId: string): Promise<TerminalInfo | null> {
    if (!byId.value.has(id)) return null
    const info = await window.api.terminals.continueWith(id, accountId)
    if (info) replace(id, info)
    return info
  }

  /** Starts a session again in its place; it goes on with its conversation. */
  async function restartSession(id: string): Promise<TerminalInfo | null> {
    if (!byId.value.has(id)) return null
    const info = await window.api.terminals.restartSession(id)
    if (info) replace(id, info)
    return info
  }

  /** Opens a session from the history with another account's limits. */
  async function continueSession(accountId: string, sessionId: string, targetAccountId: string): Promise<TerminalInfo | null> {
    const info = await window.api.sessions.continueWith(accountId, sessionId, targetAccountId)
    if (info) show(info)
    return info
  }

  /** The next (previous) tab: in groups, within the group with the keyboard, like editor tabs. */
  function cycle(direction: 1 | -1): void {
    if (grouped.value) {
      const group = activeGroup.value
      if (!group || group.tabs.length < 2) return
      const index = group.tabs.findIndex((t) => t.id === group.active)
      activateTab(group.tabs[(index + direction + group.tabs.length) % group.tabs.length].id)
      return
    }
    const list = tabs.value
    if (list.length < 2) return
    const index = list.findIndex((tab) => tab.panes.some((p) => p.id === activeId.value))
    focus(list[(index + direction + list.length) % list.length].focused.id)
  }

  /** Selects the tab at `index` (in groups, of the active group); -1 is the last one. False when there is no such tab. */
  function activateAt(index: number): boolean {
    if (grouped.value) {
      const tab = activeGroup.value?.tabs.at(index)
      if (!tab) return false
      activateTab(tab.id)
      return true
    }
    const tab = tabs.value.at(index)
    if (!tab) return false
    focus(tab.focused.id)
    return true
  }

  /**
   * What Alt+arrow leads to from the terminal `id`: in groups the group next to its group, else the
   * terminal next to it in its tab. Null at the edge.
   */
  function neighbour(id: string, direction: PaneDirection): string | null {
    if (grouped.value) {
      const group = groupOfTab(workspace.value, id)
      return group ? neighbourPane(workspace.value.layout, group.id, direction) : null
    }
    const tab = tabOf(id)
    return tab ? neighbourPane(tab.layout, id, direction) : null
  }

  /**
   * Gives the keyboard to what is next to it in `direction`: the group next to the active one, or in one
   * tab bar the terminal next to the active one in its tab. False at the edge.
   */
  function focusNeighbour(direction: PaneDirection): boolean {
    if (grouped.value) {
      const next = neighbourPane(workspace.value.layout, workspace.value.activeGroup, direction)
      if (next) focusGroup(next)
      return !!next
    }
    const next = activeId.value ? neighbour(activeId.value, direction) : null
    if (next) focus(next)
    return !!next
  }

  /** Moves a tab to `index`: in its group's tab bar, or in the one tab bar (with all terminals of the tab). */
  function move(tabId: string, index: number): void {
    if (grouped.value) {
      const group = groupOfTab(workspace.value, tabId)
      if (group) workspace.value = moveTab(workspace.value, tabId, group.id, index)
      return
    }
    const from = tabs.value.findIndex((tab) => tab.id === tabId)
    if (from === -1) return
    const next = moveItem(tabs.value, from, index)
    if (next.every((tab, i) => tab === tabs.value[i])) return
    terminals.value = next.flatMap((tab) => tab.panes)
    saveOrder()
  }

  // ── Splits in one tab bar ──

  /** Gives the terminal a tab of its own, right after the one it was in, and selects it. */
  function detach(id: string): void {
    const tab = tabOf(id)
    if (!tab || tab.panes.length < 2) return
    const rest = removePanes(tab.layout, new Set([id]))!
    // The split shrinks right away, not only when main answers.
    splits.value = [...dropPanes(splits.value, new Set(paneIds(tab.layout))), ...(typeof rest === 'string' ? [] : [rest])]
    const pane = tab.panes.find((p) => p.id === id)!
    const list = terminals.value.filter((t) => t.id !== id)
    const last = Math.max(...tab.panes.filter((p) => p.id !== id).map((p) => list.indexOf(p)))
    list.splice(last + 1, 0, pane)
    terminals.value = list
    focus(id)
    saveOrder()
    void window.api.terminals.arrange(plain(rest))
  }

  /**
   * The layout of the tab of `targetId` with all terminals of the tab `tabId` on `side` of it. Null
   * when that can't be: the same tab, or a tree deeper than main takes.
   */
  function dockLayout(tabId: string, targetId: string, side: PaneDirection): PaneSplit | null {
    const tab = tabs.value.find((t) => t.id === tabId)
    const target = tabOf(targetId)
    if (!tab || !target || tab === target) return null
    const layout = insertPane(target.layout, targetId, tab.layout, side)
    return parsePaneNode(layout) ? (layout as PaneSplit) : null
  }

  /**
   * Moves all terminals of the tab `tabId` into the tab of `targetId`, on `side` of that terminal, and
   * gives them the keyboard. The tab stays where the target was in the tab bar.
   */
  function dock(tabId: string, targetId: string, side: PaneDirection): void {
    const layout = dockLayout(tabId, targetId, side)
    if (!layout) return
    const tab = tabs.value.find((t) => t.id === tabId)!
    const target = tabOf(targetId)!
    // Shown right away, not only when main answers.
    splits.value = [...dropPanes(splits.value, new Set(paneIds(layout))), layout]
    const moved = new Set(tab.panes.map((p) => p.id))
    const list = terminals.value.filter((t) => !moved.has(t.id))
    const last = Math.max(...target.panes.map((p) => list.indexOf(p)))
    list.splice(last + 1, 0, ...tab.panes)
    terminals.value = list
    focus(tab.focused.id)
    saveOrder()
    void window.api.terminals.arrange(plain(layout))
  }

  /**
   * Another share for the split at `path` in the tab. Shown right away; main keeps it (and the next
   * start restores it) once `save` is set, e.g. when the divider is let go.
   */
  function resize(tabId: string, path: SplitPath, ratio: number, save: boolean): void {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (!tab || typeof tab.layout === 'string') return
    const layout = setRatio(tab.layout, path, ratio) as PaneSplit
    const ids = new Set(paneIds(layout))
    splits.value = [...dropPanes(splits.value, ids), layout]
    if (save) void window.api.terminals.arrange(plain(layout))
  }

  // ── Groups ──

  /** A tab dropped on a group: into it (`center`), or into a new group on that side of it. */
  function dropTab(tab: string, groupId: string, side: DropSide): void {
    workspace.value =
      side === 'center' ? moveTab(workspace.value, tab, groupId) : dockTab(workspace.value, tab, groupId, side, newGroupId())
    activateTab(tab)
  }

  /** An empty group on `side` of `groupId`, with the keyboard: the next tab opens in it. */
  function splitEmpty(groupId: string, side: PaneDirection): string {
    const id = newGroupId()
    workspace.value = setActive(splitGroup(workspace.value, groupId, side, id), id)
    settle()
    return id
  }

  /** Takes a group out of the window; its terminals have to be closed already (or stay without a tab). */
  function removeEmptyGroup(groupId: string): void {
    const group = findGroup(workspace.value, groupId)
    if (!group || group.tabs.some((t) => byId.value.has(t))) return
    workspace.value = removeGroup(workspace.value, groupId)
    settle()
  }

  /** Closes the pages of a group; with its terminals gone (see useTerminalActions) the group goes too. */
  function closeGroupPages(groupId: string): void {
    const group = findGroup(workspace.value, groupId)
    if (!group) return
    let ws = workspace.value
    for (const tab of group.tabs) if (pageOfTab(tab)) ws = removeTab(ws, tab, true)
    workspace.value = ws
    removeEmptyGroup(groupId)
  }

  function resizeGroups(path: SplitPath, ratio: number): void {
    workspace.value = resizeWorkspace(workspace.value, path, ratio)
  }

  // Main replaced a terminal by itself, e.g. switching the account at a limit: the new one takes the
  // old one's place, and the keyboard only if the old one had it. Comes before the old one closes.
  window.api.terminals.onReplaced((oldId, info) => {
    if (byId.value.has(oldId) || groupOfTab(workspace.value, oldId)) replace(oldId, info, activeId.value === oldId)
  })

  window.api.terminals.onChanged((next, layouts) => sync(next, layouts))

  return {
    grouped,
    terminals,
    tabs,
    workspace,
    groups,
    activeGroup,
    focusedTab,
    focusedPage,
    activeId,
    active,
    activeTab,
    visibleIds,
    tabOf,
    groupOf,
    workingTerminal,
    workingTerminalOf,
    sessionOf,
    browsersOf,
    sessionFor,
    linked,
    focusedAt: focusedAtOf,
    runningCount,
    load,
    open,
    openBrowser,
    activate,
    activateTab,
    focusGroup,
    openPage,
    closePage,
    close,
    closeTab,
    kill,
    rename,
    setMuted,
    restart,
    continueWith,
    restartSession,
    continueSession,
    cycle,
    activateAt,
    neighbour,
    focusNeighbour,
    move,
    detach,
    dockLayout,
    dock,
    resize,
    dropTab,
    splitEmpty,
    removeEmptyGroup,
    closeGroupPages,
    resizeGroups,
  }
})
