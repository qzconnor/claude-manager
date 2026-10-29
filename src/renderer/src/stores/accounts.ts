import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { Account, AccountCreateInput, AccountIdentity, AccountUpdateInput } from '@shared/types'

export const useAccountsStore = defineStore('accounts', () => {
  const accounts = ref<Account[]>([])
  const loaded = ref(false)

  const byId = computed(() => new Map(accounts.value.map((a) => [a.id, a])))

  /**
   * The browser login account with the same login as the standard account. Account switchers
   * like cswap log ~/.claude into one of the other accounts, so the standard account would show
   * the same limits twice. Setup tokens don't count: they can't read the limits.
   */
  const standardTwin = computed(() => {
    const standard = byId.value.get(SYSTEM_ACCOUNT_ID)
    return standard ? accounts.value.find((a) => a.kind === 'oauth' && sameLogin(a.identity, standard.identity)) : undefined
  })

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

  window.api.accounts.onChanged((next) => {
    accounts.value = next
  })

  return { accounts, loaded, byId, standardTwin, get, load, create, update, remove, refresh }
})

function sameLogin(a: AccountIdentity, b: AccountIdentity): boolean {
  return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase() && a.organizationUuid === b.organizationUuid
}
