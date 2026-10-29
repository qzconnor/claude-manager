<script setup lang="ts">
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { useAccountsStore } from '@/stores/accounts'
import AccountDot from './AccountDot.vue'

const props = defineProps<{ accountId: string }>()
const accounts = useAccountsStore()
const account = computed(() => accounts.get(props.accountId))
</script>

<template>
  <Badge variant="outline" class="max-w-full">
    <AccountDot :color="account?.color" />
    <span class="truncate">{{ account?.name ?? 'Unbekannter Account' }}</span>
  </Badge>
</template>
