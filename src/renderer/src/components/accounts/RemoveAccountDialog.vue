<script setup lang="ts">
import { TriangleAlertIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { Account } from '@shared/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { toastError } from '@/lib/errors'
import { shortenPath } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'
import { useAppStore } from '@/stores/app'
import { useTerminalsStore } from '@/stores/terminals'

const props = defineProps<{ account: Account | null }>()
const open = defineModel<boolean>('open', { required: true })

const accounts = useAccountsStore()
const terminals = useTerminalsStore()
const app = useAppStore()
const deleteConfigDir = ref(false)
const removing = ref(false)

watch(open, (isOpen) => {
  if (isOpen) deleteConfigDir.value = false
})

/** Tabs whose session lies in the account's folder or runs with its login. They can't go on without it. */
const tabs = computed(() =>
  props.account
    ? terminals.terminals.filter((t) => t.mode !== 'browser' && (t.accountId === props.account!.id || t.authAccountId === props.account!.id))
    : [],
)
const running = computed(() => tabs.value.filter((t) => t.status === 'running'))
const tabNames = computed(() => {
  const names = tabs.value.slice(0, 3).map((t) => `„${t.title}“`)
  const more = tabs.value.length - names.length
  return more > 0 ? `${names.join(', ')} und ${more} weitere` : names.join(names.length === 2 ? ' und ' : ', ')
})
const runningText = computed(() => {
  const count = running.value.length
  if (count === 0) return ''
  if (count === tabs.value.length) return count === 1 ? 'Sein Prozess läuft noch und wird beendet.' : 'Ihre Prozesse laufen noch und werden beendet.'
  return count === 1 ? 'Einer davon läuft noch und wird beendet.' : `${count} davon laufen noch und werden beendet.`
})
const folder = computed(() => (props.account ? shortenPath(props.account.configDir, app.info?.homeDir) : ''))

async function remove() {
  if (!props.account) return
  removing.value = true
  try {
    const { id, name } = props.account
    // Main refuses an account whose terminals still run; the dialog said that they close.
    for (const tab of tabs.value) await terminals.close(tab.id)
    // The main process only ever deletes app-managed profile folders.
    await accounts.remove(id, deleteConfigDir.value && !props.account.customConfigDir)
    toast.success(`Account „${name}“ entfernt`)
    open.value = false
  } catch (error) {
    toastError(error, 'Entfernen fehlgeschlagen')
  } finally {
    removing.value = false
  }
}
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent v-if="account">
      <AlertDialogHeader>
        <AlertDialogTitle>„{{ account.name }}“ entfernen?</AlertDialogTitle>
        <AlertDialogDescription>
          Der Account verschwindet aus der App, gespeicherte Tokens werden gelöscht.
          {{ account.customConfigDir ? 'Der eigene Konfigurationsordner bleibt unangetastet.' : '' }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <Alert v-if="tabs.length" :variant="running.length ? 'destructive' : 'default'">
        <TriangleAlertIcon />
        <AlertTitle>
          {{ tabs.length === 1 ? 'Ein Tab nutzt diesen Account' : `${tabs.length} Tabs nutzen diesen Account` }}
        </AlertTitle>
        <AlertDescription>
          {{ tabNames }} {{ tabs.length === 1 ? 'wird' : 'werden' }} beim Entfernen geschlossen.
          {{ runningText }}
        </AlertDescription>
      </Alert>
      <Field v-if="!account.customConfigDir" orientation="horizontal">
        <Checkbox id="remove-config-dir" v-model="deleteConfigDir" />
        <FieldContent class="min-w-0">
          <FieldLabel for="remove-config-dir">Profilordner endgültig löschen</FieldLabel>
          <FieldDescription>
            Enthält Anmeldung, Einstellungen und den Session-Verlauf dieses Accounts. Er wird sofort gelöscht, nicht in
            den Papierkorb verschoben. Ohne Haken bleibt er erhalten.
          </FieldDescription>
          <span class="selectable block font-mono text-xs break-all text-muted-foreground" v-tooltip="account.configDir">
            {{ folder }}
          </span>
        </FieldContent>
      </Field>
      <AlertDialogFooter>
        <Button variant="outline" :disabled="removing" @click="open = false">Abbrechen</Button>
        <Button variant="destructive" :disabled="removing" @click="remove">
          <Spinner v-if="removing" data-icon="inline-start" />
          {{ deleteConfigDir && !account.customConfigDir ? 'Entfernen und Ordner löschen' : 'Entfernen' }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
