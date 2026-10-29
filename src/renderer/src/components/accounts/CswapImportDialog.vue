<script setup lang="ts">
import { InfoIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { CswapAccount, CswapStatus } from '@shared/types'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { useLauncher } from '@/composables/useLauncher'
import { toastError } from '@/lib/errors'
import { expectedIdentity } from '@/lib/expected-login'
import { identityLabel } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'

/** Creates browser login accounts for the accounts claude-swap knows (name, email, organization). */
const props = defineProps<{ status: CswapStatus | null }>()
const open = defineModel<boolean>('open', { required: true })

const accounts = useAccountsStore()
const launcher = useLauncher()

const selected = ref<number[]>([])
const importSettings = ref(true)
const importing = ref(false)

const entries = computed(() => props.status?.accounts ?? [])

watch(open, (isOpen) => {
  if (!isOpen) return
  selected.value = entries.value.filter((entry) => !entry.existingAccountId).map((entry) => entry.number)
  importSettings.value = true
})

function toggle(number: number, checked: boolean) {
  selected.value = checked ? [...new Set([...selected.value, number])] : selected.value.filter((n) => n !== number)
}

function login(entry: CswapAccount): string {
  return identityLabel(expectedIdentity(entry)) ?? entry.email
}

function existingName(entry: CswapAccount): string | null {
  return entry.existingAccountId ? (accounts.get(entry.existingAccountId)?.name ?? null) : null
}

async function submit() {
  if (selected.value.length === 0) return
  importing.value = true
  try {
    const created = await window.api.cswap.import({ numbers: [...selected.value], importSettings: importSettings.value })
    await accounts.load()
    open.value = false
    if (created.length === 1) {
      toast.success(`Account „${created[0].name}“ angelegt`, { description: 'Melde dich im neuen Tab im Browser an.' })
      void launcher.login(created[0].id)
    } else {
      toast.success(`${created.length} Accounts angelegt`, {
        description: 'Melde jeden Account einmal über „Anmelden“ im Browser an.',
      })
    }
  } catch (error) {
    toastError(error, 'Import fehlgeschlagen')
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Accounts aus cswap übernehmen</DialogTitle>
        <DialogDescription>
          Übernommen werden Name, E-Mail und Organisation. Jeder Account bekommt eine eigene Anmeldung, cswap und seine
          gespeicherten Logins bleiben unberührt.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">Accounts</FieldLegend>
          <FieldGroup class="gap-2">
            <FieldLabel v-for="entry in entries" :key="entry.number" :for="`cswap-${entry.number}`">
              <Field orientation="horizontal" :data-disabled="!!entry.existingAccountId || undefined">
                <Checkbox
                  :id="`cswap-${entry.number}`"
                  :model-value="selected.includes(entry.number)"
                  :disabled="!!entry.existingAccountId"
                  @update:model-value="toggle(entry.number, $event === true)"
                />
                <FieldContent class="min-w-0">
                  <FieldTitle class="w-full min-w-0">
                    <span class="truncate">{{ entry.name }}</span>
                    <Badge
                      v-if="entry.active"
                      variant="secondary"
                      title="cswap hat ~/.claude gerade auf diesen Account geschaltet (Standard-Account)."
                    >
                      Aktiv
                    </Badge>
                  </FieldTitle>
                  <FieldDescription class="truncate" :title="login(entry)">{{ login(entry) }}</FieldDescription>
                  <FieldDescription v-if="entry.existingAccountId">
                    Schon vorhanden{{ existingName(entry) ? ` als „${existingName(entry)}“` : '' }}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          </FieldGroup>
        </FieldSet>

        <Field orientation="horizontal">
          <Checkbox id="cswap-import-settings" v-model="importSettings" />
          <FieldContent>
            <FieldLabel for="cswap-import-settings">Einstellungen aus ~/.claude übernehmen</FieldLabel>
            <FieldDescription>Kopiert settings.json, CLAUDE.md, Skills, Commands und Agents, keine Anmeldedaten.</FieldDescription>
          </FieldContent>
        </Field>

        <Alert>
          <InfoIcon />
          <AlertDescription>
            Danach meldest du jeden Account einmal über „Anmelden“ an, mit dem angezeigten Konto. Gehört eine E-Mail zu
            mehreren Organisationen, wähl im Browser die passende aus.
          </AlertDescription>
        </Alert>
      </FieldGroup>

      <DialogFooter>
        <Button variant="outline" @click="open = false">Abbrechen</Button>
        <Button :disabled="importing || selected.length === 0" @click="submit">
          <Spinner v-if="importing" data-icon="inline-start" />
          {{ selected.length === 0 ? 'Accounts anlegen' : selected.length === 1 ? '1 Account anlegen' : `${selected.length} Accounts anlegen` }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
