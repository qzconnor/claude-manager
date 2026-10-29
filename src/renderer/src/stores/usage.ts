import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AccountTokenStats, AccountUsage } from '@shared/types'

export const useUsageStore = defineStore('usage', () => {
  const usage = ref<AccountUsage[]>([])
  const refreshing = ref(false)
  const stats = ref<Record<string, AccountTokenStats>>({})
  const statsLoading = ref<Record<string, boolean>>({})

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

  async function loadStats(accountId: string, days = 30): Promise<AccountTokenStats> {
    statsLoading.value = { ...statsLoading.value, [accountId]: true }
    try {
      const result = await window.api.usage.stats(accountId, days)
      stats.value = { ...stats.value, [accountId]: result }
      return result
    } finally {
      statsLoading.value = { ...statsLoading.value, [accountId]: false }
    }
  }

  window.api.usage.onChanged((next) => {
    usage.value = next
  })

  return { usage, refreshing, stats, statsLoading, byAccount, load, refresh, loadStats }
})
