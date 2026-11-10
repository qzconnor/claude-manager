<script setup lang="ts">
import { PlusIcon } from '@lucide/vue'
import { computed } from 'vue'
import AccountDot from '@/components/common/AccountDot.vue'
import {
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import { useLauncher } from '@/composables/useLauncher'
import { useAccountsStore } from '@/stores/accounts'

/** „Neue Session hier“ in the context menu of a folder; with several accounts a submenu asks which one. */
defineProps<{ path: string | null }>()

const accounts = useAccountsStore()
const launcher = useLauncher()
const several = computed(() => accounts.accounts.length > 1)
</script>

<template>
  <ContextMenuSub v-if="several">
    <ContextMenuSubTrigger :disabled="!path">
      <PlusIcon />
      Neue Session hier
    </ContextMenuSubTrigger>
    <ContextMenuSubContent class="w-56">
      <ContextMenuItem v-for="account in accounts.accounts" :key="account.id" @select="launcher.newSession(account.id, path)">
        <AccountDot :color="account.color" />
        <span class="truncate">{{ account.name }}</span>
        <ContextMenuShortcut v-if="account.id === launcher.defaultAccountId()">Standard</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuSubContent>
  </ContextMenuSub>
  <ContextMenuItem v-else :disabled="!path" @select="launcher.newSession(undefined, path)">
    <PlusIcon />
    Neue Session hier
  </ContextMenuItem>
</template>
