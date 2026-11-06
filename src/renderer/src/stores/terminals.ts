import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { moveItem } from '@shared/order'
import type { TerminalCreateOptions, TerminalInfo } from '@shared/types'

export const useTerminalsStore = defineStore('terminals', () => {
  const terminals = ref<TerminalInfo[]>([])
  const activeId = ref<string | null>(null)

  const active = computed(() => terminals.value.find((t) => t.id === activeId.value) ?? null)
  const runningCount = computed(() => terminals.value.filter((t) => t.status === 'running').length)

  function sync(next: TerminalInfo[]): void {
    const index = terminals.value.findIndex((t) => t.id === activeId.value)
    terminals.value = next
    if (!next.some((t) => t.id === activeId.value)) {
      // A tab that closed by itself hands the selection to its neighbour, as if closed by hand.
      activeId.value = (index === -1 ? next.at(-1) : (next[index] ?? next[index - 1]))?.id ?? null
    }
  }

  async function load(): Promise<void> {
    sync(await window.api.terminals.list())
  }

  /** Null when the user doesn't trust the folder (asked by the app before Claude Code starts). */
  async function open(options: TerminalCreateOptions): Promise<TerminalInfo | null> {
    const info = await window.api.terminals.create(options)
    if (info) show(info)
    return info
  }

  function show(info: TerminalInfo): void {
    if (!terminals.value.some((t) => t.id === info.id)) terminals.value = [...terminals.value, info]
    activeId.value = info.id
  }

  function activate(id: string): void {
    if (terminals.value.some((t) => t.id === id)) activeId.value = id
  }

  /** Activates the neighbour tab before closing so the selection doesn't jump to the end. */
  async function close(id: string): Promise<void> {
    const index = terminals.value.findIndex((t) => t.id === id)
    if (index !== -1 && activeId.value === id) {
      const neighbour = terminals.value[index + 1] ?? terminals.value[index - 1]
      activeId.value = neighbour?.id ?? null
    }
    await window.api.terminals.close(id)
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

  /** Moves a tab to `index`, its position in the new order. */
  function move(id: string, index: number): void {
    const from = terminals.value.findIndex((t) => t.id === id)
    if (from === -1) return
    const next = moveItem(terminals.value, from, index)
    if (next.every((t, i) => t === terminals.value[i])) return
    terminals.value = next
    saveOrder()
  }

  /** Puts the tab that replaces `oldId` at its position and selects it (unless `select` is false). */
  function replace(oldId: string, index: number, info: TerminalInfo, select = true): void {
    const list = terminals.value.filter((t) => t.id !== oldId && t.id !== info.id)
    list.splice(Math.min(index, list.length), 0, info)
    terminals.value = list
    if (select) activeId.value = info.id
    saveOrder()
  }

  /** Starts the same command again in a new tab at the same position; the old one stays without trust. */
  async function restart(id: string): Promise<void> {
    const old = terminals.value.find((t) => t.id === id)
    if (!old) return
    const index = terminals.value.indexOf(old)
    const info = await window.api.terminals.create({
      accountId: old.accountId,
      authAccountId: old.authAccountId,
      cwd: old.cwd,
      mode: old.mode,
      resumeSessionId: old.resumeSessionId,
      title: old.fixedTitle ? old.title : null,
      muted: old.muted,
    })
    if (!info) return
    await window.api.terminals.close(id)
    replace(id, index, info)
  }

  /** Continues the tab's session with another account's limits, in a new tab at the same position. */
  async function continueWith(id: string, accountId: string): Promise<TerminalInfo | null> {
    const index = terminals.value.findIndex((t) => t.id === id)
    if (index === -1) return null
    const info = await window.api.terminals.continueWith(id, accountId)
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
    if (terminals.value.length < 2) return
    const index = terminals.value.findIndex((t) => t.id === activeId.value)
    const next = (index + direction + terminals.value.length) % terminals.value.length
    activeId.value = terminals.value[next].id
  }

  /** Selects the tab at `index`; -1 is the last one. False when there is no such tab. */
  function activateAt(index: number): boolean {
    const tab = terminals.value.at(index)
    if (!tab) return false
    activeId.value = tab.id
    return true
  }

  // Main replaced a tab by itself, e.g. switching the account at a limit: the new tab takes the old
  // one's place, and the selection only if the old one had it. Comes before the old tab closes.
  window.api.terminals.onReplaced((oldId, info) => {
    const index = terminals.value.findIndex((t) => t.id === oldId)
    if (index !== -1) replace(oldId, index, info, activeId.value === oldId)
  })

  window.api.terminals.onChanged((next) => {
    // Keep the local tab order; append unknown terminals (e.g. opened through the API).
    const known = terminals.value.map((t) => next.find((n) => n.id === t.id)).filter((t): t is TerminalInfo => !!t)
    const added = next.filter((n) => !terminals.value.some((t) => t.id === n.id))
    sync([...known, ...added])
  })

  return {
    terminals,
    activeId,
    active,
    runningCount,
    load,
    open,
    activate,
    close,
    kill,
    rename,
    setMuted,
    restart,
    continueWith,
    continueSession,
    cycle,
    activateAt,
    move,
  }
})
