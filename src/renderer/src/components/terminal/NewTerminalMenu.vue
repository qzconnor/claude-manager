<script setup lang="ts">
import { ChevronDownIcon, FolderOpenIcon, HistoryIcon, KeyRoundIcon, PlusIcon, SquareTerminalIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AccountDot from '@/components/common/AccountDot.vue'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLauncher } from '@/composables/useLauncher'
import { useAccountsStore } from '@/stores/accounts'

const router = useRouter()
const accounts = useAccountsStore()
const launcher = useLauncher()

/** Token / API-key accounts can't use `claude auth login`. */
const loginAccounts = computed(() => accounts.accounts.filter((a) => a.kind === 'oauth' || a.kind === 'system'))
</script>

<template>
  <ButtonGroup class="app-no-drag shrink-0">
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="outline" size="icon" aria-label="Neue Session" @click="launcher.newSession()">
          <PlusIcon class="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Neue Session (Strg+Umschalt+T)</TooltipContent>
    </Tooltip>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="icon" class="w-7" aria-label="Weitere Optionen">
          <ChevronDownIcon class="size-4.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64" @close-auto-focus.prevent>
        <DropdownMenuLabel>Neue Claude-Session</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            v-for="account in accounts.accounts"
            :key="account.id"
            @select="launcher.newSession(account.id)"
          >
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
              <DropdownMenuItem
                v-for="account in accounts.accounts"
                :key="account.id"
                @select="launcher.shell(account.id)"
              >
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
    </DropdownMenu>
  </ButtonGroup>
</template>
