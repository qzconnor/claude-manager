import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AccountTokenStats, AccountUsage } from '@shared/types'
import { errorMessage } from '@/lib/errors'

/** Token statistics are kept by account and period: switching back shows the last one at once. */
export const statsKey = (accountId: string, days: number) => `${accountId}:${days}`

export const useUsageStore = defineStore('usage', () => {
  const usage = ref<AccountUsage[]>([])
  const refreshing = ref(false)
  /** By `statsKey`. */
  const stats = ref<Record<string, AccountTokenStats>>({})
  const statsLoading = ref<Record<string, boolean>>({})
  /** Why the last computation failed, by `statsKey`. */
  const statsErrors = ref<Record<string, string>>({})
  /** The latest request by `statsKey`: an older answer that comes later doesn't count. */
  const statsRequests = new Map<string, number>()
  let statsRequestCount = 0

  const byAccount = computed(() => new Map(usage.value.map((u) => [u.accountId, u])))

  async function load(): Promise<void> {
    usage.value = await window.api.usage.get()
  }

  async function refresh(accountId?: string): Promise<void> {
    refreshing.value = true
    try {
      usage.value = await window.api.usage.refresh(accountId)
    } finally {
      refreshing.value = false
    }
  }

  /** Computes the token statistics of an account for the last `days` days. Doesn't throw: a failure is in `statsErrors`. */
  async function loadStats(accountId: string, days = 30): Promise<void> {
    const key = statsKey(accountId, days)
    const request = ++statsRequestCount
    statsRequests.set(key, request)
    statsLoading.value = { ...statsLoading.value, [key]: true }
    try {
      const result = await window.api.usage.stats(accountId, days)
      if (statsRequests.get(key) !== request) return
      stats.value = { ...stats.value, [key]: result }
      const { [key]: _, ...errors } = statsErrors.value
      statsErrors.value = errors
    } catch (error) {
      if (statsRequests.get(key) === request) statsErrors.value = { ...statsErrors.value, [key]: errorMessage(error) }
    } finally {
      if (statsRequests.get(key) === request) statsLoading.value = { ...statsLoading.value, [key]: false }
    }
  }

  window.api.usage.onChanged((next) => {
    usage.value = next
  })

  return { usage, refreshing, stats, statsLoading, statsErrors, byAccount, load, refresh, loadStats }
})
