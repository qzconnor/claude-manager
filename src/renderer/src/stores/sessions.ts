import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SessionGroup, SessionRef, SessionRemoveResult } from '@shared/types'

export const useSessionsStore = defineStore('sessions', () => {
  const groups = ref<SessionGroup[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  /** Sessions are being moved to the recycle bin. */
  const removing = ref(false)
  let pending: Promise<void> | null = null
  /** The latest request for an account's list: an older answer that comes later doesn't count. */
  const requests = new Map<string, number>()
  let requestCount = 0

  async function load(): Promise<void> {
    if (pending) return pending
    // What it brings is newer than the answers to the requests before it.
    requests.clear()
    loading.value = true
    pending = window.api.sessions
      .list()
      .then((next) => {
        groups.value = next
        loaded.value = true
      })
      .finally(() => {
        loading.value = false
        pending = null
      })
    return pending
  }

  async function reloadAccount(accountId: string): Promise<void> {
    // A full load under way would replace this answer with its older list.
    if (pending) await pending.catch(() => undefined)
    const request = ++requestCount
    requests.set(accountId, request)
    const [group] = await window.api.sessions.list(accountId)
    if (requests.get(accountId) !== request) return
    requests.delete(accountId)
    // The account is gone: its sessions go with it.
    if (!group) {
      groups.value = groups.value.filter((g) => g.accountId !== accountId)
      return
    }
    const index = groups.value.findIndex((g) => g.accountId === accountId)
    if (index === -1) groups.value = [...groups.value, group]
    else groups.value = groups.value.map((g, i) => (i === index ? group : g))
  }

  async function remove(refs: SessionRef[]): Promise<SessionRemoveResult> {
    removing.value = true
    try {
      const result = await window.api.sessions.remove(refs)
      // Right away, not only once the accounts have been read again.
      const gone = new Set(result.removed.map((r) => `${r.accountId}:${r.sessionId}`))
      if (gone.size > 0) {
        groups.value = groups.value.map((g) => ({
          ...g,
          sessions: g.sessions.filter((s) => !gone.has(`${g.accountId}:${s.id}`)),
        }))
      }
      return result
    } finally {
      removing.value = false
    }
  }

  window.api.sessions.onChanged((accountId) => {
    if (loaded.value) void reloadAccount(accountId)
  })

  return { groups, loading, loaded, removing, load, reloadAccount, remove }
})
