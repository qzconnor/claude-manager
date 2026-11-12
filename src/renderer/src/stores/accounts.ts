import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Account, AccountCreateInput, AccountUpdateInput, LoginRenewResult } from '@shared/types'
import { standardTwin as findStandardTwin } from '@shared/utils'

export const useAccountsStore = defineStore('accounts', () => {
  const accounts = ref<Account[]>([])
  const loaded = ref(false)

  const byId = computed(() => new Map(accounts.value.map((a) => [a.id, a])))

  /** The browser login account with the same login as the standard account (see `standardTwin`). */
  const standardTwin = computed(() => findStandardTwin(accounts.value))

  function get(id: string | null | undefined): Account | undefined {
    return id ? byId.value.get(id) : undefined
  }

  async function load(): Promise<void> {
    accounts.value = await window.api.accounts.list()
    loaded.value = true
  }

  async function create(input: AccountCreateInput): Promise<Account> {
    const account = await window.api.accounts.create(input)
    await load()
    return account
  }

  async function update(id: string, patch: AccountUpdateInput): Promise<Account> {
    const account = await window.api.accounts.update(id, patch)
    await load()
    return account
  }

  async function remove(id: string, deleteConfigDir: boolean): Promise<void> {
    await window.api.accounts.remove(id, { deleteConfigDir })
    await load()
  }

  async function refresh(): Promise<void> {
    accounts.value = await window.api.accounts.refresh()
  }

  /** "Jetzt erneuern": a new access token for the browser login; the list follows with the change event. */
  function renewLogin(id: string): Promise<LoginRenewResult> {
    return window.api.accounts.renewLogin(id)
  }

  window.api.accounts.onChanged((next) => {
    accounts.value = next
  })

  return { accounts, loaded, byId, standardTwin, get, load, create, update, remove, refresh, renewLogin }
})
