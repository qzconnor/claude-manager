<script setup lang="ts">
import { KeyRoundIcon, LoaderCircleIcon, RefreshCwIcon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { Account, LoginRenewResult } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useClock } from '@/composables/useClock'
import { useLauncher } from '@/composables/useLauncher'
import { errorMessage } from '@/lib/errors'
import { formatDateTime, formatRelative, identityLabel } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/stores/accounts'

/**
 * The logins of all accounts at a glance: how long the access token works, when the browser login
 * ends and when its tokens were saved last. "Jetzt erneuern" gets a new access token right away.
 */
const props = defineProps<{ accounts: Account[] }>()

const store = useAccountsStore()
const launcher = useLauncher()
const now = useClock()
const renewing = ref(new Set<string>())

const isBrowserLogin = (account: Account) => account.kind === 'oauth' || account.kind === 'system'

function status(account: Account): { text: string; tone: string } {
  switch (account.authState) {
    case 'ok':
      return { text: isBrowserLogin(account) ? 'Angemeldet' : 'Secret hinterlegt', tone: 'text-success' }
    case 'expired':
      return { text: 'Token abgelaufen', tone: 'text-warning' }
    case 'dead':
      return { text: 'Login abgelaufen', tone: 'text-destructive' }
    default:
      return { text: isBrowserLogin(account) ? 'Nicht angemeldet' : 'Kein Secret', tone: 'text-destructive' }
  }
}

/** "läuft ab in 3 Stunden", "abgelaufen vor 2 Stunden". */
function tokenText(account: Account): string {
  if (!isBrowserLogin(account)) return account.kind === 'token' ? 'langlebig' : '–'
  const iso = account.tokenExpiresAt
  if (!iso) return '–'
  const ahead = Date.parse(iso) > now.value
  return `${ahead ? 'läuft ab' : 'abgelaufen'} ${formatRelative(iso, now.value)}`
}

function loginEndText(account: Account): string {
  if (!isBrowserLogin(account) || account.authState === 'missing') return '–'
  if (!account.renewable) return account.authState === 'dead' ? 'beendet' : 'mit dem Token'
  if (!account.loginEndsAt) return 'unbekannt'
  return formatRelative(account.loginEndsAt, now.value)
}

function loginEndHint(account: Account): string | null {
  if (!isBrowserLogin(account) || account.authState === 'missing') return null
  if (!account.renewable) return 'Kein Refresh-Token, der noch geht: Läuft der Access-Token ab, hilft nur neu anmelden.'
  if (!account.loginEndsAt) return 'Claude Code hat kein Ende des Logins gespeichert.'
  const until = formatDateTime(account.loginEndsAt)
  return `Bis ${until} erneuern Claude Code und die App den Access-Token selbst, danach hilft nur neu anmelden.`
}

async function renew(account: Account) {
  if (renewing.value.has(account.id)) return
  renewing.value = new Set(renewing.value).add(account.id)
  let result: LoginRenewResult
  try {
    result = await store.renewLogin(account.id)
  } catch (error) {
    toast.error('Login konnte nicht erneuert werden', { description: errorMessage(error) })
    return
  } finally {
    const next = new Set(renewing.value)
    next.delete(account.id)
    renewing.value = next
  }
  if (result === 'renewed') {
    toast.success(`Login von „${account.name}“ erneuert`)
  } else if (result === 'busy') {
    toast.info('Claude Code erneuert den Login gerade', { description: 'Gleich zeigt die Liste den neuen Access-Token.' })
  } else if (result === 'rejected') {
    toast.error(`Login von „${account.name}“ lässt sich nicht erneuern`, {
      description: 'Anthropic nimmt den Refresh-Token nicht mehr an. Nur neu anmelden hilft.',
      action: { label: 'Neu anmelden', onClick: () => void launcher.login(account.id) },
    })
  } else {
    toast.error('Erneuern fehlgeschlagen', { description: 'Netzwerk oder Server haben nicht geantwortet. Versuch es gleich noch einmal.' })
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Logins</CardTitle>
      <CardDescription>
        Claude Code erneuert den Access-Token eines Browser-Logins selbst, die App auch für Accounts, die gerade nicht laufen. Erst wenn der
        Login endet, muss man sich neu anmelden.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Table class="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead class="w-36">Status</TableHead>
            <TableHead class="w-48">Access-Token</TableHead>
            <TableHead class="w-32">Login endet</TableHead>
            <TableHead class="w-36">Zuletzt erneuert</TableHead>
            <TableHead class="w-40"><span class="sr-only">Aktion</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="account in props.accounts" :key="account.id">
            <TableCell>
              <div class="flex min-w-0 items-center gap-2">
                <span class="size-2.5 shrink-0 rounded-full" :style="{ backgroundColor: account.color }" />
                <span class="shrink-0 truncate font-medium">{{ account.name }}</span>
                <span v-if="account.identity.email" class="min-w-0 truncate text-xs text-muted-foreground">
                  {{ identityLabel(account.identity) }}
                </span>
              </div>
            </TableCell>
            <TableCell :class="cn('text-xs', status(account).tone)">{{ status(account).text }}</TableCell>
            <TableCell class="truncate text-xs" v-tooltip="account.tokenExpiresAt ? formatDateTime(account.tokenExpiresAt) : null">
              {{ tokenText(account) }}
            </TableCell>
            <TableCell class="truncate text-xs" v-tooltip="loginEndHint(account)">{{ loginEndText(account) }}</TableCell>
            <TableCell
              class="truncate text-xs"
              v-tooltip="
                account.tokenSavedAt ? `Tokens gespeichert ${formatDateTime(account.tokenSavedAt)}, von Claude Code oder der App` : null
              "
            >
              {{ account.tokenSavedAt ? formatRelative(account.tokenSavedAt, now) : '–' }}
            </TableCell>
            <TableCell class="text-right">
              <Button
                v-if="isBrowserLogin(account) && (account.authState === 'missing' || account.authState === 'dead')"
                size="sm"
                variant="outline"
                @click="launcher.login(account.id)"
              >
                <KeyRoundIcon data-icon="inline-start" />
                {{ account.authState === 'dead' ? 'Neu anmelden' : 'Anmelden' }}
              </Button>
              <Button
                v-else-if="isBrowserLogin(account) && account.renewable"
                size="sm"
                variant="ghost"
                :disabled="renewing.has(account.id)"
                v-tooltip="'Holt mit dem Refresh-Token jetzt einen neuen Access-Token, wie Claude Code beim Start einer Session'"
                @click="renew(account)"
              >
                <LoaderCircleIcon v-if="renewing.has(account.id)" data-icon="inline-start" class="animate-spin" />
                <RefreshCwIcon v-else data-icon="inline-start" />
                Jetzt erneuern
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
</template>
