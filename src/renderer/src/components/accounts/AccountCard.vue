<script setup lang="ts">
import {
  EllipsisIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  SquareTerminalIcon,
  StarIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from '@lucide/vue'
import { computed } from 'vue'
import { SYSTEM_ACCOUNT_ID } from '@shared/defaults'
import type { Account } from '@shared/types'
import AccountDot from '@/components/common/AccountDot.vue'
import AccountIdentityLine from '@/components/common/AccountIdentityLine.vue'
import UsageMeter from '@/components/dashboard/UsageMeter.vue'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLauncher } from '@/composables/useLauncher'
import { attempt } from '@/lib/errors'
import { expectedIdentity, isUnexpectedLogin } from '@/lib/expected-login'
import { accountKindLabel, identityLabel, planLabel, shortenPath } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'
import { useUsageStore } from '@/stores/usage'
import AccountAuthStatus from './AccountAuthStatus.vue'

const props = defineProps<{ account: Account }>()
const emit = defineEmits<{ edit: []; remove: [] }>()

const app = useAppStore()
const accounts = useAccountsStore()
const settings = useSettingsStore()
const usageStore = useUsageStore()
const launcher = useLauncher()

const usage = computed(() => usageStore.byAccount.get(props.account.id))
const plan = computed(() => planLabel(props.account.identity.subscriptionType))
const canLogin = computed(() => props.account.kind === 'oauth' || props.account.kind === 'system')
const isDefault = computed(() => settings.settings.general.defaultAccountId === props.account.id)
/** Before the first login an imported account shows who it is meant for. */
const shownIdentity = computed(() => {
  const { identity, expectedLogin } = props.account
  return !identity.email && expectedLogin ? expectedIdentity(expectedLogin) : identity
})
const unexpectedLogin = computed(() => isUnexpectedLogin(props.account))
const expectedLabel = computed(() => {
  const expected = props.account.expectedLogin
  return expected ? identityLabel(expectedIdentity(expected)) : null
})

function openConfigDir() {
  void attempt(() => window.api.app.openPath(props.account.configDir), 'Ordner konnte nicht geöffnet werden')
}

function makeDefault() {
  void attempt(() => settings.update({ general: { defaultAccountId: props.account.id } }))
}

/** Keeps the current login and stops comparing it with the expected one. */
function keepLogin() {
  void attempt(() => accounts.update(props.account.id, { expectedLogin: null }))
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex min-w-0 items-center gap-2">
        <AccountDot :color="account.color" class="size-2.5" />
        <span class="truncate">{{ account.name }}</span>
        <Badge v-if="plan" variant="secondary">{{ plan }}</Badge>
        <Badge v-if="isDefault" variant="outline">Standard</Badge>
      </CardTitle>
      <CardDescription class="min-w-0">
        <AccountIdentityLine :identity="shownIdentity" :fallback="accountKindLabel(account.kind)" />
      </CardDescription>
      <CardAction>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" aria-label="Account-Aktionen">
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem @select="emit('edit')">
                <PencilIcon />
                Bearbeiten
              </DropdownMenuItem>
              <DropdownMenuItem v-if="canLogin" @select="launcher.login(account.id)">
                <KeyRoundIcon />
                Neu anmelden
              </DropdownMenuItem>
              <DropdownMenuItem @select="launcher.shell(account.id)">
                <SquareTerminalIcon />
                PowerShell mit Account
              </DropdownMenuItem>
              <DropdownMenuItem @select="openConfigDir">
                <FolderOpenIcon />
                Konfigurationsordner öffnen
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="isDefault" @select="makeDefault">
                <StarIcon />
                Als Standard verwenden
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <template v-if="account.id !== SYSTEM_ACCOUNT_ID">
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" @select="emit('remove')">
                  <Trash2Icon />
                  Entfernen
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardAction>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
      <Alert v-if="unexpectedLogin" variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Anderer Login als erwartet</AlertTitle>
        <AlertDescription>
          Gedacht für {{ expectedLabel }}. Melde dich neu an und wähl im Browser den passenden Login.
        </AlertDescription>
        <AlertAction>
          <Button variant="ghost" size="xs" title="Login behalten und nicht mehr vergleichen" @click="keepLogin">
            Ignorieren
          </Button>
        </AlertAction>
      </Alert>
      <div class="flex flex-col gap-1.5">
        <AccountAuthStatus :account="account" />
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt class="text-muted-foreground">Typ</dt>
          <dd class="truncate">{{ accountKindLabel(account.kind) }}</dd>
          <template v-if="account.secretHint">
            <dt class="text-muted-foreground">Secret</dt>
            <dd class="truncate font-mono">{{ account.secretHint }}</dd>
          </template>
          <dt class="text-muted-foreground">Konfiguration</dt>
          <dd class="selectable truncate font-mono" :title="account.configDir">
            {{ shortenPath(account.configDir, app.info?.homeDir) }}
          </dd>
          <template v-if="account.defaultCwd">
            <dt class="text-muted-foreground">Arbeitsordner</dt>
            <dd class="selectable truncate font-mono" :title="account.defaultCwd">
              {{ shortenPath(account.defaultCwd, app.info?.homeDir) }}
            </dd>
          </template>
        </dl>
      </div>

      <div v-if="usage?.fiveHour || usage?.sevenDay" class="grid grid-cols-2 gap-4">
        <UsageMeter v-if="usage.fiveHour" :window="usage.fiveHour" compact />
        <UsageMeter v-if="usage.sevenDay" :window="usage.sevenDay" compact />
      </div>
      <p v-else-if="usage?.message" class="text-xs text-muted-foreground">{{ usage.message }}</p>
    </CardContent>

    <CardFooter class="mt-auto gap-2">
      <Button size="sm" @click="launcher.newSession(account.id)">
        <PlusIcon data-icon="inline-start" />
        Neue Session
      </Button>
      <Button v-if="canLogin && account.authState === 'missing'" size="sm" variant="outline" @click="launcher.login(account.id)">
        <KeyRoundIcon data-icon="inline-start" />
        Anmelden
      </Button>
      <Button v-else-if="unexpectedLogin" size="sm" variant="outline" @click="launcher.login(account.id)">
        <KeyRoundIcon data-icon="inline-start" />
        Neu anmelden
      </Button>
      <Button
        v-else-if="!canLogin && account.authState === 'missing'"
        size="sm"
        variant="outline"
        @click="emit('edit')"
      >
        <KeyRoundIcon data-icon="inline-start" />
        Secret eintragen
      </Button>
    </CardFooter>
  </Card>
</template>
