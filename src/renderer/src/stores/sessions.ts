import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SessionGroup } from '@shared/types'

export const useSessionsStore = defineStore('sessions', () => {
  const groups = ref<SessionGroup[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  let pending: Promise<void> | null = null

  async function load(): Promise<void> {
    if (pending) return pending
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
    const [group] = await window.api.sessions.list(accountId)
    if (!group) return
    const index = groups.value.findIndex((g) => g.accountId === accountId)
    if (index === -1) groups.value = [...groups.value, group]
    else groups.value = groups.value.map((g, i) => (i === index ? group : g))
  }

  window.api.sessions.onChanged((accountId) => {
    if (loaded.value) void reloadAccount(accountId)
  })

  return { groups, loading, loaded, load, reloadAccount }
})
