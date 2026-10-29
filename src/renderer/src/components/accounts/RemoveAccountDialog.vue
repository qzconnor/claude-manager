<script setup lang="ts">
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { Account } from '@shared/types'
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
import { useAccountsStore } from '@/stores/accounts'

const props = defineProps<{ account: Account | null }>()
const open = defineModel<boolean>('open', { required: true })

const accounts = useAccountsStore()
const deleteConfigDir = ref(false)
const removing = ref(false)

watch(open, (isOpen) => {
  if (isOpen) deleteConfigDir.value = false
})

async function remove() {
  if (!props.account) return
  removing.value = true
  try {
    const name = props.account.name
    // The main process only ever deletes app-managed profile folders.
    await accounts.remove(props.account.id, deleteConfigDir.value && !props.account.customConfigDir)
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
      <Field v-if="!account.customConfigDir" orientation="horizontal">
        <Checkbox id="remove-config-dir" v-model="deleteConfigDir" />
        <FieldContent>
          <FieldLabel for="remove-config-dir">Profilordner ebenfalls löschen</FieldLabel>
          <FieldDescription>Enthält Anmeldung, Einstellungen und den Session-Verlauf dieses Accounts.</FieldDescription>
        </FieldContent>
      </Field>
      <AlertDialogFooter>
        <Button variant="outline" :disabled="removing" @click="open = false">Abbrechen</Button>
        <Button variant="destructive" :disabled="removing" @click="remove">
          <Spinner v-if="removing" data-icon="inline-start" />
          Entfernen
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
