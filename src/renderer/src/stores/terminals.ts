import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
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

  async function open(options: TerminalCreateOptions): Promise<TerminalInfo> {
    const info = await window.api.terminals.create(options)
    if (!terminals.value.some((t) => t.id === info.id)) terminals.value = [...terminals.value, info]
    activeId.value = info.id
    return info
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

  /** Puts the tab that replaces `oldId` at its position and selects it. */
  function replace(oldId: string, index: number, info: TerminalInfo): void {
    const list = terminals.value.filter((t) => t.id !== oldId && t.id !== info.id)
    list.splice(Math.min(index, list.length), 0, info)
    terminals.value = list
    activeId.value = info.id
  }

  /** Starts the same command again in a new tab at the same position. */
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
      title: old.title,
    })
    await window.api.terminals.close(id)
    replace(id, index, info)
  }

  /** Continues the tab's session with another account's limits, in a new tab at the same position. */
  async function continueWith(id: string, accountId: string): Promise<TerminalInfo | undefined> {
    const index = terminals.value.findIndex((t) => t.id === id)
    if (index === -1) return undefined
    const info = await window.api.terminals.continueWith(id, accountId)
    replace(id, index, info)
    return info
  }

  /** Opens a session from the history with another account's limits. */
  async function continueSession(accountId: string, sessionId: string, targetAccountId: string): Promise<TerminalInfo> {
    const info = await window.api.sessions.continueWith(accountId, sessionId, targetAccountId)
    if (!terminals.value.some((t) => t.id === info.id)) terminals.value = [...terminals.value, info]
    activeId.value = info.id
    return info
  }

  function cycle(direction: 1 | -1): void {
    if (terminals.value.length < 2) return
    const index = terminals.value.findIndex((t) => t.id === activeId.value)
    const next = (index + direction + terminals.value.length) % terminals.value.length
    activeId.value = terminals.value[next].id
  }

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
    restart,
    continueWith,
    continueSession,
    cycle,
  }
})
