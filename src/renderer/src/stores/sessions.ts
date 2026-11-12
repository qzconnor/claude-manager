import { defineStore } from 'pinia'
import { ref } from 'vue'
import { cleanTags } from '@shared/session-marks'
import type { SessionGroup, SessionRef, SessionRemoveResult } from '@shared/types'
import { errorMessage } from '@/lib/errors'

export const useSessionsStore = defineStore('sessions', () => {
  const groups = ref<SessionGroup[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  /** Why the last full load failed; the list says so instead of loading on and on. */
  const error = ref<string | null>(null)
  /** Sessions are being moved to the recycle bin. */
  const removing = ref(false)
  /** Sessions on their way to the recycle bin (see `useSessionRemoval`): the lists leave them out. */
  const leaving = new Set<string>()
  let pending: Promise<void> | null = null
  /** The latest request for an account's list: an older answer that comes later doesn't count. */
  const requests = new Map<string, number>()
  let requestCount = 0

  /** Reads all accounts' sessions. Doesn't throw: a failure is in `error`. */
  async function load(): Promise<void> {
    if (pending) return pending
    // What it brings is newer than the answers to the requests before it.
    requests.clear()
    loading.value = true
    pending = window.api.sessions
      .list()
      .then((next) => {
        groups.value = withoutLeaving(next)
        loaded.value = true
        error.value = null
      })
      .catch((failure: unknown) => {
        error.value = errorMessage(failure)
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
    const [kept] = withoutLeaving([group])
    const index = groups.value.findIndex((g) => g.accountId === accountId)
    if (index === -1) groups.value = [...groups.value, kept]
    else groups.value = groups.value.map((g, i) => (i === index ? kept : g))
  }

  function withoutLeaving(list: SessionGroup[]): SessionGroup[] {
    if (leaving.size === 0) return list
    return list.map((g) => {
      const sessions = g.sessions.filter((s) => !leaving.has(`${g.accountId}:${s.id}`))
      return sessions.length === g.sessions.length ? g : { ...g, sessions }
    })
  }

  /** Takes the sessions out of the lists, until `remove` deletes them or `bringBack` returns them. */
  function hide(refs: SessionRef[]): void {
    for (const ref of refs) leaving.add(`${ref.accountId}:${ref.sessionId}`)
    groups.value = withoutLeaving(groups.value)
  }

  /** The hidden sessions are in the lists again, as their accounts have them now. */
  async function bringBack(refs: SessionRef[]): Promise<void> {
    for (const ref of refs) leaving.delete(`${ref.accountId}:${ref.sessionId}`)
    await Promise.all([...new Set(refs.map((r) => r.accountId))].map((id) => reloadAccount(id).catch(() => undefined)))
  }

  async function remove(refs: SessionRef[]): Promise<SessionRemoveResult> {
    removing.value = true
    try {
      const result = await window.api.sessions.remove(refs)
      // Right away, not only once the accounts have been read again.
      const gone = new Set(result.removed.map((r) => `${r.accountId}:${r.sessionId}`))
      for (const key of gone) leaving.delete(key)
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

  /**
   * Pins the session or gives it other tags: with every account at once, as main keeps them by session
   * id; the lists that main sends next say the same. Failed, the lists are read again.
   */
  async function mark(sessionId: string, change: { pinned?: boolean; tags?: string[] }): Promise<void> {
    const tags = change.tags && cleanTags(change.tags)
    groups.value = groups.value.map((g) =>
      g.sessions.some((s) => s.id === sessionId)
        ? {
            ...g,
            sessions: g.sessions.map((s) =>
              s.id === sessionId ? { ...s, ...(change.pinned !== undefined && { pinned: change.pinned }), ...(tags && { tags }) } : s,
            ),
          }
        : g,
    )
    try {
      if (change.pinned !== undefined) await window.api.sessions.pin(sessionId, change.pinned)
      if (tags) await window.api.sessions.tag(sessionId, tags)
    } catch (failure) {
      void load()
      throw failure
    }
  }

  window.api.sessions.onChanged((accountId) => {
    if (loaded.value) void reloadAccount(accountId)
  })

  return { groups, loading, loaded, error, removing, load, reloadAccount, hide, bringBack, remove, mark }
})
