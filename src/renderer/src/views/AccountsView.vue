<script setup lang="ts">
import { EyeOffIcon, ImportIcon, PlusIcon, RefreshCwIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { Account, CswapStatus } from '@shared/types'
import AccountCard from '@/components/accounts/AccountCard.vue'
import AccountFormDialog from '@/components/accounts/AccountFormDialog.vue'
import CswapImportDialog from '@/components/accounts/CswapImportDialog.vue'
import RemoveAccountDialog from '@/components/accounts/RemoveAccountDialog.vue'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia } from '@/components/ui/item'
import { useLauncher } from '@/composables/useLauncher'
import { attempt } from '@/lib/errors'
import { useAccountsStore } from '@/stores/accounts'

const accounts = useAccountsStore()
const launcher = useLauncher()

/** The standard account stays out of the way while it duplicates another login, until asked for. */
const showStandard = ref(false)
const shownAccounts = computed(() =>
  accounts.standardTwin && !showStandard.value
    ? accounts.accounts.filter((account) => account.id !== SYSTEM_ACCOUNT_ID)
    : accounts.accounts,
)
const standardName = computed(() => accounts.get(SYSTEM_ACCOUNT_ID)?.name)

const formOpen = ref(false)
const editing = ref<Account | null>(null)
const removeOpen = ref(false)
const removing = ref<Account | null>(null)
/** The import is only offered while cswap is installed and knows accounts. */
const cswap = ref<CswapStatus | null>(null)
const importOpen = ref(false)

async function loadCswap() {
  try {
    cswap.value = await window.api.cswap.status()
  } catch {
    cswap.value = null
  }
}

onMounted(loadCswap)

async function openImport() {
  // Fresh state: accounts may have been added or removed since.
  await loadCswap()
  if (cswap.value?.available) importOpen.value = true
}

function add() {
  editing.value = null
  formOpen.value = true
}

function edit(account: Account) {
  editing.value = account
  formOpen.value = true
}

function remove(account: Account) {
  removing.value = account
  removeOpen.value = true
}
</script>

<template>
  <PageContainer>
    <PageHeader title="Accounts" description="Mehrere Claude-Anmeldungen parallel – jede Session läuft mit ihrem eigenen Account.">
      <template #actions>
        <Button variant="outline" @click="attempt(() => accounts.refresh())">
          <RefreshCwIcon data-icon="inline-start" />
          Aktualisieren
        </Button>
        <Button v-if="cswap?.available" variant="outline" @click="openImport">
          <ImportIcon data-icon="inline-start" />
          Aus cswap importieren
        </Button>
        <Button @click="add">
          <PlusIcon data-icon="inline-start" />
          Account hinzufügen
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <AccountCard
        v-for="account in shownAccounts"
        :key="account.id"
        :account="account"
        @edit="edit(account)"
        @remove="remove(account)"
      />
    </div>

    <Item v-if="accounts.standardTwin" variant="muted" size="sm">
      <ItemMedia variant="icon">
        <EyeOffIcon />
      </ItemMedia>
      <ItemContent>
        <ItemDescription>
          „{{ standardName }}“ hat denselben Login wie „{{ accounts.standardTwin.name }}“ und fehlt deshalb im
          Usage-Dashboard{{ showStandard ? '' : ' und hier' }}.
          <template v-if="!showStandard && launcher.defaultAccountId() === SYSTEM_ACCOUNT_ID">
            Für neue Sessions bleibt er Standard.
          </template>
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="outline" size="sm" @click="showStandard = !showStandard">
          {{ showStandard ? 'Ausblenden' : 'Anzeigen' }}
        </Button>
      </ItemActions>
    </Item>

    <AccountFormDialog v-model:open="formOpen" :account="editing" />
    <RemoveAccountDialog v-model:open="removeOpen" :account="removing" />
    <CswapImportDialog v-model:open="importOpen" :status="cswap" />
  </PageContainer>
</template>
