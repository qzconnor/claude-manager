<script setup lang="ts">
import { RefreshCwIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import PageContainer from '@/components/common/PageContainer.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import AccountUsageCard from '@/components/dashboard/AccountUsageCard.vue'
import TokenStatsSection from '@/components/dashboard/TokenStatsSection.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useLauncher } from '@/composables/useLauncher'
import { attempt } from '@/lib/errors'
import { useAccountsStore } from '@/stores/accounts'
import { useUsageStore } from '@/stores/usage'

const accounts = useAccountsStore()
const usage = useUsageStore()
const launcher = useLauncher()

const statsAccountId = ref(launcher.defaultAccountId())

/** The standard account only shows while its login has no account of its own. */
const usageAccounts = computed(() =>
  accounts.standardTwin ? accounts.accounts.filter((account) => account.id !== SYSTEM_ACCOUNT_ID) : accounts.accounts,
)

// Fall back to the default account if the selected one gets removed.
watch(
  () => accounts.accounts.map((a) => a.id),
  (ids) => {
    if (!ids.includes(statsAccountId.value)) statsAccountId.value = launcher.defaultAccountId()
  },
)
</script>

<template>
  <PageContainer>
    <PageHeader title="Usage" description="Plan-Limits und Token-Verbrauch aller Accounts auf einen Blick.">
      <template #actions>
        <Button variant="outline" :disabled="usage.refreshing" @click="attempt(() => usage.refresh())">
          <Spinner v-if="usage.refreshing" data-icon="inline-start" />
          <RefreshCwIcon v-else data-icon="inline-start" />
          Alle aktualisieren
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 lg:grid-cols-2">
      <AccountUsageCard
        v-for="account in usageAccounts"
        :key="account.id"
        :account="account"
        :usage="usage.byAccount.get(account.id)"
      />
    </div>

    <TokenStatsSection v-model:account-id="statsAccountId" />
  </PageContainer>
</template>
