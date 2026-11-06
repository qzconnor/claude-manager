import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { moveItem } from '@shared/order'
import {
  dropPanes,
  hasPane,
  insertPane,
  mapPanes,
  neighbourPane,
  paneIds,
  parsePaneNode,
  removePanes,
  setRatio,
  type PaneDirection,
  type SplitPath,
} from '@shared/panes'
import type { BrowserOpenOptions, PaneNode, PaneSplit, TerminalCreateOptions, TerminalInfo } from '@shared/types'
import { groupTabs, type TerminalTabGroup } from '@/lib/tabs'

/** A tab with the terminal in it that has (or last had) the keyboard. */
export interface TerminalTab extends TerminalTabGroup {
  focused: TerminalInfo
}

/** A copy without Vue's proxies, which IPC can't send. */
const plain = (layout: PaneNode) => mapPanes(layout, (id) => id)

export const useTerminalsStore = defineStore('terminals', () => {
  /** Every terminal, in the order of the tabs; the terminals of a split tab may lie apart. */
  const terminals = ref<TerminalInfo[]>([])
  /** The tabs with more than one terminal, as the main process keeps them. */
  const splits = ref<PaneSplit[]>([])
  /** The terminal that has the keyboard: in the selected tab, the focused one of its parts. */
  const activeId = ref<string | null>(null)
  /** When each terminal last had the keyboard, so a tab gives it back to the same one. */
  const focusedAt = reactive(new Map<string, number>())
  let focusCount = 0

  /** Of some terminals (at least one), the one that last had the keyboard. */
  const lastFocused = (panes: TerminalInfo[]) =>
    panes.reduce((best, pane) => ((focusedAt.get(pane.id) ?? 0) > (focusedAt.get(best.id) ?? 0) ? pane : best))
  const focusedOf = (tab: TerminalTabGroup) => lastFocused(tab.panes)

  const tabs = computed<TerminalTab[]>(() =>
    groupTabs(terminals.value, splits.value).map((tab) => ({ ...tab, focused: focusedOf(tab) })),
  )
  const active = computed(() => terminals.value.find((t) => t.id === activeId.value) ?? null)
  const activeTab = computed(() => tabOf(activeId.value))
  /** The terminal whose account and folder the window shows (see `workingTerminalOf`). */
  const workingTerminal = computed(() => workingTerminalOf(active.value))
  /** Terminals with a process; browsers run none. */
  const runningCount = computed(() => terminals.value.filter((t) => t.status === 'running' && t.mode !== 'browser').length)

  function tabOf(id: string | null): TerminalTab | null {
    return id ? (tabs.value.find((tab) => tab.panes.some((p) => p.id === id)) ?? null) : null
  }

  /**
   * The terminal itself, or for a browser the terminal of its tab that last had the keyboard: the
   * account and folder the browser works with. A browser alone in its tab has none.
   */
  function workingTerminalOf(terminal: TerminalInfo | null): TerminalInfo | null {
    if (terminal?.mode !== 'browser') return terminal
    const others = tabOf(terminal.id)?.panes.filter((p) => p.mode !== 'browser') ?? []
    return others.length ? lastFocused(others) : null
  }

  function focus(id: string | null): void {
    activeId.value = id
    if (id) focusedAt.set(id, ++focusCount)
  }

  /** Before the tab at `index` goes: the one after it, or the one before. */
  function neighbourTab(index: number): TerminalTab | undefined {
    return tabs.value[index + 1] ?? tabs.value[index - 1]
  }

  function sync(next: TerminalInfo[], nextSplits: PaneSplit[]): void {
    const before = tabs.value
    const index = before.findIndex((tab) => tab.panes.some((p) => p.id === activeId.value))
    terminals.value = next
    splits.value = nextSplits
    for (const id of focusedAt.keys()) if (!next.some((t) => t.id === id)) focusedAt.delete(id)
    if (next.some((t) => t.id === activeId.value)) return
    // The terminal with the keyboard closed by itself: another one of its tab gets it, otherwise the
    // neighbour tab, as if closed by hand.
    const after = tabs.value
    const same = index === -1 ? undefined : after.find((tab) => tab.panes.some((p) => hasPane(before[index].layout, p.id)))
    const target = same ?? (index === -1 ? after.at(-1) : (after[index] ?? after[index - 1]))
    focus(target?.focused.id ?? null)
  }

  async function load(): Promise<void> {
    const [list, layouts] = await Promise.all([window.api.terminals.list(), window.api.terminals.layouts()])
    sync(list, layouts)
  }

  /** Null when the user doesn't trust the folder (asked by the app before Claude Code starts). */
  async function open(options: TerminalCreateOptions): Promise<TerminalInfo | null> {
    const info = await window.api.terminals.create(options)
    if (info) show(info)
    return info
  }

  /** A browser in a new tab or next to a terminal (`options.split`). */
  async function openBrowser(options: BrowserOpenOptions = {}): Promise<TerminalInfo> {
    const info = await window.api.terminals.openBrowser(options)
    show(info)
    return info
  }

  function show(info: TerminalInfo): void {
    if (!terminals.value.some((t) => t.id === info.id)) terminals.value = [...terminals.value, info]
    focus(info.id)
  }

  /** Selects the terminal's tab and gives the terminal the keyboard. */
  function activate(id: string): void {
    if (terminals.value.some((t) => t.id === id)) focus(id)
  }

  /** The neighbour gets the keyboard before closing so the selection doesn't jump to the end. */
  async function close(id: string): Promise<void> {
    if (activeId.value === id) {
      const tab = tabOf(id)!
      const others = tab.panes.filter((p) => p.id !== id)
      if (others.length > 0) focus(focusedOf({ ...tab, panes: others }).id)
      else focus(neighbourTab(tabs.value.indexOf(tab))?.focused.id ?? null)
    }
    await window.api.terminals.close(id)
  }

  /** Closes every terminal of the tab. */
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

  /** Tells main the order of the tabs, so the next start restores them in it. */
  function saveOrder(): void {
    window.api.terminals.reorder(terminals.value.map((t) => t.id))
  }

  /** Moves the tab with this id to `index`, its position in the new order. */
  function move(tabId: string, index: number): void {
    const from = tabs.value.findIndex((tab) => tab.id === tabId)
    if (from === -1) return
    const next = moveItem(tabs.value, from, index)
    if (next.every((tab, i) => tab === tabs.value[i])) return
    terminals.value = next.flatMap((tab) => tab.panes)
    saveOrder()
  }

  /** Puts the tab that replaces `oldId` at its position and selects it (unless `select` is false). */
  function replace(oldId: string, index: number, info: TerminalInfo, select = true): void {
    const list = terminals.value.filter((t) => t.id !== oldId && t.id !== info.id)
    list.splice(Math.min(index, list.length), 0, info)
    terminals.value = list
    if (select) focus(info.id)
    saveOrder()
  }

  /** Starts the same command again in a new terminal in the same place; the old one stays without trust. */
  async function restart(id: string): Promise<void> {
    const old = terminals.value.find((t) => t.id === id)
    // A browser has no command; its pane loads the page again instead.
    if (!old || old.mode === 'browser') return
    const index = terminals.value.indexOf(old)
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
    await window.api.terminals.close(id)
    replace(id, index, info)
  }

  /** Continues the terminal's session with another account's limits, in a new one in the same place. */
  async function continueWith(id: string, accountId: string): Promise<TerminalInfo | null> {
    const index = terminals.value.findIndex((t) => t.id === id)
    if (index === -1) return null
    const info = await window.api.terminals.continueWith(id, accountId)
    if (info) replace(id, index, info)
    return info
  }

  /** Starts a session again in its place; it goes on with its conversation. */
  async function restartSession(id: string): Promise<TerminalInfo | null> {
    const index = terminals.value.findIndex((t) => t.id === id)
    if (index === -1) return null
    const info = await window.api.terminals.restartSession(id)
    if (info) replace(id, index, info)
    return info
  }

  /** Opens a session from the history with another account's limits. */
  async function continueSession(
    accountId: string,
    sessionId: string,
    targetAccountId: string,
  ): Promise<TerminalInfo | null> {
    const info = await window.api.sessions.continueWith(accountId, sessionId, targetAccountId)
    if (info) show(info)
    return info
  }

  function cycle(direction: 1 | -1): void {
    const list = tabs.value
    if (list.length < 2) return
    const index = list.findIndex((tab) => tab.panes.some((p) => p.id === activeId.value))
    focus(list[(index + direction + list.length) % list.length].focused.id)
  }

  /** Selects the tab at `index`; -1 is the last one. False when there is no such tab. */
  function activateAt(index: number): boolean {
    const tab = tabs.value.at(index)
    if (!tab) return false
    focus(tab.focused.id)
    return true
  }

  /** The terminal next to `id` in its tab, null at the edge of the tab. */
  function neighbour(id: string, direction: PaneDirection): string | null {
    const tab = tabOf(id)
    return tab ? neighbourPane(tab.layout, id, direction) : null
  }

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

  // Main replaced a terminal by itself, e.g. switching the account at a limit: the new one takes the
  // old one's place, and the selection only if the old one had it. Comes before the old one closes.
  window.api.terminals.onReplaced((oldId, info) => {
    const index = terminals.value.findIndex((t) => t.id === oldId)
    if (index !== -1) replace(oldId, index, info, activeId.value === oldId)
  })

  window.api.terminals.onChanged((next, layouts) => {
    // Keep the local tab order; append unknown terminals (e.g. opened through the API).
    const known = terminals.value.map((t) => next.find((n) => n.id === t.id)).filter((t): t is TerminalInfo => !!t)
    const added = next.filter((n) => !terminals.value.some((t) => t.id === n.id))
    sync([...known, ...added], layouts)
  })

  return {
    terminals,
    tabs,
    activeId,
    active,
    activeTab,
    tabOf,
    workingTerminal,
    workingTerminalOf,
    runningCount,
    load,
    open,
    openBrowser,
    activate,
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
    move,
    neighbour,
    detach,
    dockLayout,
    dock,
    resize,
  }
})
