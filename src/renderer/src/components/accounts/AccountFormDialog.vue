<script setup lang="ts">
import { ChevronRightIcon, EyeIcon, EyeOffIcon } from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { ACCOUNT_COLORS } from '@shared/defaults'
import type { Account, AccountKind } from '@shared/types'
import ColorPicker from '@/components/common/ColorPicker.vue'
import DirectoryInput from '@/components/common/DirectoryInput.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useLauncher } from '@/composables/useLauncher'
import { formatArgs, parseArgs } from '@/lib/args'
import { errorMessage } from '@/lib/errors'
import { accountKindLabel } from '@/lib/format'
import { useAccountsStore } from '@/stores/accounts'

type CreatableKind = Exclude<AccountKind, 'system'>

const props = defineProps<{ account?: Account | null }>()
const open = defineModel<boolean>('open', { required: true })

const accounts = useAccountsStore()
const launcher = useLauncher()

const KIND_OPTIONS: { value: CreatableKind; label: string }[] = [
  { value: 'oauth', label: 'OAuth-Login' },
  { value: 'token', label: 'Long-lived Token' },
  { value: 'apiKey', label: 'API-Key' },
]
const KIND_INFO: Record<CreatableKind, string> = {
  oauth:
    'Eigener Konfigurationsordner, Anmeldung im Browser über „claude auth login“. Claude Code erneuert den Token selbst; Usage-Limits sind live abrufbar.',
  token:
    'Long-lived Token aus „claude setup-token“, wird als CLAUDE_CODE_OAUTH_TOKEN übergeben. Ein Jahr gültig; die Usage-API akzeptiert diesen Token-Typ nicht.',
  apiKey: 'Anthropic-API-Key aus der Console, wird als ANTHROPIC_API_KEY übergeben. Abrechnung nach Verbrauch.',
}

const form = reactive({
  name: '',
  kind: 'oauth' as CreatableKind,
  color: ACCOUNT_COLORS[0],
  secret: '',
  useCustomDir: false,
  configDir: '',
  defaultCwd: '',
  extraArgs: '',
  importSettings: true,
})
const showSecret = ref(false)
const advancedOpen = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const submitted = ref(false)

const editing = computed(() => !!props.account)
const kind = computed<AccountKind>(() => props.account?.kind ?? form.kind)
const needsSecret = computed(() => kind.value === 'token' || kind.value === 'apiKey')

const nameError = computed(() => (submitted.value && !form.name.trim() ? 'Bitte gib einen Namen an.' : null))
const secretError = computed(() => {
  if (!submitted.value || !needsSecret.value) return null
  const secret = form.secret.trim()
  if (!secret) return editing.value ? null : 'Bitte trage den Token bzw. API-Key ein.'
  return secret.startsWith('sk-ant-') ? null : 'Muss mit „sk-ant-“ beginnen.'
})
const dirError = computed(() =>
  submitted.value && form.useCustomDir && !form.configDir.trim() ? 'Bitte wähle einen Ordner.' : null,
)

function nextColor(): string {
  const used = new Set(accounts.accounts.map((a) => a.color.toLowerCase()))
  return ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[accounts.accounts.length % ACCOUNT_COLORS.length]
}

watch(open, (isOpen) => {
  if (!isOpen) return
  const a = props.account
  Object.assign(form, {
    name: a?.name ?? '',
    kind: a && a.kind !== 'system' ? a.kind : 'oauth',
    color: a?.color ?? nextColor(),
    secret: '',
    useCustomDir: false,
    configDir: '',
    defaultCwd: a?.defaultCwd ?? '',
    extraArgs: formatArgs(a?.extraArgs ?? []),
    importSettings: true,
  })
  showSecret.value = false
  advancedOpen.value = !!(a?.defaultCwd || a?.extraArgs.length)
  error.value = null
  submitted.value = false
})

function onKindChange(value: unknown) {
  if (value === 'oauth' || value === 'token' || value === 'apiKey') form.kind = value
}

async function submit() {
  submitted.value = true
  error.value = null
  if (nameError.value || secretError.value || dirError.value) return
  saving.value = true
  try {
    const common = {
      name: form.name.trim(),
      color: form.color,
      defaultCwd: form.defaultCwd.trim() || null,
      extraArgs: parseArgs(form.extraArgs),
    }
    const secret = form.secret.trim()
    if (props.account) {
      await accounts.update(props.account.id, { ...common, ...(secret ? { secret } : {}) })
      toast.success('Account gespeichert')
    } else {
      const created = await accounts.create({
        ...common,
        kind: form.kind,
        secret: needsSecret.value ? secret : undefined,
        configDir: form.useCustomDir ? form.configDir.trim() : null,
        importSettings: form.importSettings,
      })
      toast.success(`Account „${created.name}“ angelegt`)
      if (created.kind === 'oauth' && created.authState === 'missing') {
        toast.info('Anmeldung gestartet', { description: 'Folge den Anweisungen im neuen Tab.' })
        void launcher.login(created.id)
      }
    }
    open.value = false
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ editing ? 'Account bearbeiten' : 'Account hinzufügen' }}</DialogTitle>
        <DialogDescription>
          {{ editing ? accountKindLabel(kind) : 'Jeder Account startet Claude Code mit eigener Anmeldung.' }}
        </DialogDescription>
      </DialogHeader>

      <form id="account-form" class="flex flex-col gap-5" @submit.prevent="submit">
        <FieldGroup>
          <Field v-if="!editing">
            <FieldLabel>Anmeldeart</FieldLabel>
            <SegmentedControl
              block
              :model-value="form.kind"
              :options="KIND_OPTIONS"
              aria-label="Anmeldeart"
              @update:model-value="onKindChange"
            />
            <FieldDescription>{{ KIND_INFO[form.kind] }}</FieldDescription>
          </Field>

          <Field :data-invalid="!!nameError || undefined">
            <FieldLabel for="account-name">Name</FieldLabel>
            <Input
              id="account-name"
              v-model="form.name"
              placeholder="z. B. Privat, Firma, Max-Abo"
              :aria-invalid="!!nameError || undefined"
              autofocus
            />
            <FieldError v-if="nameError">{{ nameError }}</FieldError>
          </Field>

          <Field v-if="needsSecret" :data-invalid="!!secretError || undefined">
            <FieldLabel for="account-secret">{{ kind === 'token' ? 'Token' : 'API-Key' }}</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="account-secret"
                v-model="form.secret"
                :type="showSecret ? 'text' : 'password'"
                :placeholder="
                  editing && account?.secretHint
                    ? `${account.secretHint} (leer lassen = unverändert)`
                    : kind === 'token'
                      ? 'sk-ant-oat01-…'
                      : 'sk-ant-api03-…'
                "
                autocomplete="off"
                spellcheck="false"
                class="font-mono"
                :aria-invalid="!!secretError || undefined"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  :aria-label="showSecret ? 'Verbergen' : 'Anzeigen'"
                  @click="showSecret = !showSecret"
                >
                  <EyeOffIcon v-if="showSecret" />
                  <EyeIcon v-else />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription v-if="kind === 'token'">
              Erzeugen mit <code class="font-mono">claude setup-token</code>. Wird verschlüsselt (Windows DPAPI) gespeichert.
            </FieldDescription>
            <FieldDescription v-else>Wird verschlüsselt (Windows DPAPI) gespeichert.</FieldDescription>
            <FieldError v-if="secretError">{{ secretError }}</FieldError>
          </Field>

          <Field>
            <FieldLabel>Farbe</FieldLabel>
            <ColorPicker v-model="form.color" />
          </Field>
        </FieldGroup>

        <Collapsible v-model:open="advancedOpen">
          <CollapsibleTrigger as-child>
            <Button type="button" variant="ghost" size="sm" class="-ml-2 self-start">
              <ChevronRightIcon data-icon="inline-start" :class="advancedOpen && 'rotate-90'" class="transition-transform" />
              Erweitert
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <FieldGroup class="pt-3">
              <Field>
                <FieldLabel for="account-cwd">Standard-Arbeitsordner</FieldLabel>
                <DirectoryInput id="account-cwd" v-model="form.defaultCwd" placeholder="Globaler Standard" />
              </Field>
              <Field>
                <FieldLabel for="account-args">Zusätzliche Argumente</FieldLabel>
                <Input
                  id="account-args"
                  v-model="form.extraArgs"
                  placeholder="z. B. --model opus"
                  spellcheck="false"
                  class="font-mono"
                />
                <FieldDescription>Werden bei jedem Start von Claude Code mit diesem Account angehängt.</FieldDescription>
              </Field>
              <template v-if="!editing">
                <Field orientation="horizontal">
                  <Checkbox id="account-custom-dir" v-model="form.useCustomDir" />
                  <FieldContent>
                    <FieldLabel for="account-custom-dir">Vorhandenen Konfigurationsordner verwenden</FieldLabel>
                    <FieldDescription>
                      Statt eines neuen Profils einen bestehenden CLAUDE_CONFIG_DIR übernehmen (inkl. Login und Verlauf).
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <Field v-if="form.useCustomDir" :data-invalid="!!dirError || undefined">
                  <FieldLabel for="account-config-dir">Konfigurationsordner</FieldLabel>
                  <DirectoryInput id="account-config-dir" v-model="form.configDir" placeholder="C:\Users\…\.claude-work" />
                  <FieldError v-if="dirError">{{ dirError }}</FieldError>
                </Field>
                <Field v-else orientation="horizontal">
                  <Checkbox id="account-import" v-model="form.importSettings" />
                  <FieldContent>
                    <FieldLabel for="account-import">Einstellungen aus ~/.claude übernehmen</FieldLabel>
                    <FieldDescription>
                      Kopiert settings.json, CLAUDE.md, Skills, Commands und Agents – keine Anmeldedaten.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </template>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>

        <Alert v-if="error" variant="destructive">
          <AlertTitle>Speichern fehlgeschlagen</AlertTitle>
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
      </form>

      <DialogFooter>
        <Button variant="outline" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="account-form" :disabled="saving">
          <Spinner v-if="saving" data-icon="inline-start" />
          {{ editing ? 'Speichern' : 'Hinzufügen' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
