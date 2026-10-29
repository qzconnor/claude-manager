<script setup lang="ts">
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAccountsStore } from '@/stores/accounts'
import AccountDot from './AccountDot.vue'

defineProps<{ id?: string; size?: 'sm' | 'default'; class?: string }>()
const model = defineModel<string>({ required: true })
const accounts = useAccountsStore()
</script>

<template>
  <Select v-model="model">
    <SelectTrigger :id="id" :size="size" :class="$props.class">
      <SelectValue placeholder="Account wählen" />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectItem v-for="account in accounts.accounts" :key="account.id" :value="account.id">
          <AccountDot :color="account.color" />
          {{ account.name }}
        </SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>
