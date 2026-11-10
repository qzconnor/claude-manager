<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'
import { computed, type HTMLAttributes } from 'vue'
import AccountDot from '@/components/common/AccountDot.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLauncher } from '@/composables/useLauncher'
import { useAccountsStore } from '@/stores/accounts'

/**
 * The plus of a folder in the session list: a new session there. A folder belongs to no account, so
 * with several accounts it asks which one to start with.
 */
const props = defineProps<{ path: string; name: string; size?: 'icon-xs' | 'icon-sm'; class?: HTMLAttributes['class'] }>()

const accounts = useAccountsStore()
const launcher = useLauncher()
const several = computed(() => accounts.accounts.length > 1)
const label = computed(() => `Neue Session in ${props.name}`)
</script>

<template>
  <DropdownMenu v-if="several">
    <DropdownMenuTrigger as-child>
      <Button v-tooltip="label" variant="ghost" :size="size ?? 'icon-xs'" :aria-label="label" :class="props.class">
        <PlusIcon />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-60">
      <DropdownMenuLabel class="truncate">Neue Session in {{ name }} mit</DropdownMenuLabel>
      <DropdownMenuItem v-for="account in accounts.accounts" :key="account.id" @select="launcher.newSession(account.id, path)">
        <AccountDot :color="account.color" />
        <span class="truncate">{{ account.name }}</span>
        <DropdownMenuShortcut v-if="account.id === launcher.defaultAccountId()">Standard</DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
  <Button
    v-else
    v-tooltip="label"
    variant="ghost"
    :size="size ?? 'icon-xs'"
    :aria-label="label"
    :class="props.class"
    @click="launcher.newSession(undefined, path)"
  >
    <PlusIcon />
  </Button>
</template>
