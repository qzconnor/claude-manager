<script setup lang="ts">
import type { Account } from '@shared/types'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAccountsStore } from '@/stores/accounts'
import AccountDot from './AccountDot.vue'

/** `accounts`: the ones to choose from, all without. */
const props = defineProps<{ id?: string; size?: 'sm' | 'default'; class?: string; accounts?: Account[] }>()
const model = defineModel<string>({ required: true })
const store = useAccountsStore()
</script>

<template>
  <Select v-model="model">
    <SelectTrigger :id="id" :size="size" :class="$props.class">
      <SelectValue placeholder="Account wählen" />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectItem v-for="account in props.accounts ?? store.accounts" :key="account.id" :value="account.id">
          <AccountDot :color="account.color" />
          {{ account.name }}
        </SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>
