<script setup lang="ts">
import { FolderOpenIcon, HistoryIcon, KeyRoundIcon, SquareTerminalIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AccountDot from '@/components/common/AccountDot.vue'
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useLauncher } from '@/composables/useLauncher'
import { useAccountsStore } from '@/stores/accounts'

// The menu behind the new-session chevron; side and alignment fall through to the content.
const router = useRouter()
const accounts = useAccountsStore()
const launcher = useLauncher()

/** Token / API-key accounts can't use `claude auth login`. */
const loginAccounts = computed(() => accounts.accounts.filter((a) => a.kind === 'oauth' || a.kind === 'system'))
</script>

<template>
  <DropdownMenuContent class="w-64" @close-auto-focus.prevent>
    <DropdownMenuLabel>Neue Claude-Session</DropdownMenuLabel>
    <DropdownMenuGroup>
      <DropdownMenuItem v-for="account in accounts.accounts" :key="account.id" @select="launcher.newSession(account.id)">
        <AccountDot :color="account.color" />
        <span class="truncate">{{ account.name }}</span>
        <DropdownMenuShortcut v-if="account.id === launcher.defaultAccountId()">Standard</DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuGroup>
    <DropdownMenuSeparator />
    <DropdownMenuGroup>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <FolderOpenIcon />
          In Ordner starten…
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-56">
          <DropdownMenuItem
            v-for="account in accounts.accounts"
            :key="account.id"
            @select="launcher.newSessionInFolder(account.id)"
          >
            <AccountDot :color="account.color" />
            <span class="truncate">{{ account.name }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <SquareTerminalIcon />
          PowerShell mit Account
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-56">
          <DropdownMenuItem v-for="account in accounts.accounts" :key="account.id" @select="launcher.shell(account.id)">
            <AccountDot :color="account.color" />
            <span class="truncate">{{ account.name }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub v-if="loginAccounts.length">
        <DropdownMenuSubTrigger>
          <KeyRoundIcon />
          Anmelden
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-56">
          <DropdownMenuItem v-for="account in loginAccounts" :key="account.id" @select="launcher.login(account.id)">
            <AccountDot :color="account.color" />
            <span class="truncate">{{ account.name }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuGroup>
    <DropdownMenuSeparator />
    <DropdownMenuGroup>
      <DropdownMenuItem @select="router.push({ name: 'sessions' })">
        <HistoryIcon />
        Session fortsetzen…
      </DropdownMenuItem>
    </DropdownMenuGroup>
  </DropdownMenuContent>
</template>
