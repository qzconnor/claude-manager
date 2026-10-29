<script setup lang="ts">
import { BookOpenIcon, CopyIcon, EyeIcon, EyeOffIcon, RefreshCwIcon } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { ApiStatus } from '@shared/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Switch } from '@/components/ui/switch'
import { useSetting } from '@/composables/useSetting'
import { attempt } from '@/lib/errors'
import { useUiStore } from '@/stores/ui'
import NumberControl from './NumberControl.vue'
import SettingField from './SettingField.vue'
import SettingsSection from './SettingsSection.vue'

const ui = useUiStore()

const enabled = useSetting(
  (s) => s.api.enabled,
  (enabled) => ({ api: { enabled } }),
)
const port = useSetting(
  (s) => s.api.port,
  (port) => ({ api: { port } }),
  600,
)

const status = ref<ApiStatus | null>(null)
const showToken = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  unsubscribe = window.api.api.onStatus((next) => (status.value = next))
  status.value = (await attempt(() => window.api.api.status())) ?? null
})
onBeforeUnmount(() => unsubscribe?.())

const baseUrl = computed(() => status.value?.url ?? `http://127.0.0.1:${port.value}`)
const example = computed(
  () => `curl -H "Authorization: Bearer ${showToken.value ? status.value?.token ?? '' : '<token>'}" ${baseUrl.value}/api/v1/accounts`,
)

async function copy(text: string, label: string) {
  await navigator.clipboard.writeText(text)
  toast.success(`${label} kopiert`)
}

async function regenerate() {
  const ok = await ui.confirm({
    title: 'Neuen Token erzeugen?',
    description: 'Apps, die den bisherigen Token verwenden, verlieren sofort den Zugriff.',
    confirmText: 'Neu erzeugen',
    destructive: true,
  })
  if (!ok) return
  const next = await attempt(() => window.api.api.regenerateToken(), 'Token konnte nicht erzeugt werden')
  if (next) {
    status.value = next
    toast.success('Neuer Token erzeugt')
  }
}

function openDocs() {
  void window.api.app.openExternal(`${baseUrl.value}/docs`)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SettingsSection
      title="Lokale API"
      description="HTTP-Schnittstelle für andere Apps – nur auf 127.0.0.1 erreichbar und per Token geschützt."
      reset-section="api"
    >
      <SettingField for="api-enabled" label="API aktivieren">
        <Badge v-if="status?.running" variant="outline">
          <span class="size-1.5 rounded-full bg-success" />
          Läuft
        </Badge>
        <Badge v-else-if="enabled && status?.error" variant="destructive">Fehler</Badge>
        <Badge v-else variant="secondary">Aus</Badge>
        <Switch id="api-enabled" v-model="enabled" />
      </SettingField>
      <SettingField for="api-port" label="Port">
        <NumberControl id="api-port" v-model="port" :min="1024" :max="65535" />
      </SettingField>

      <Alert v-if="enabled && status?.error" variant="destructive">
        <AlertTitle>Server konnte nicht starten</AlertTitle>
        <AlertDescription>{{ status.error }}</AlertDescription>
      </Alert>

      <SettingField for="api-url" label="Adresse">
        <InputGroup class="w-80">
          <InputGroupInput id="api-url" :model-value="baseUrl" readonly class="font-mono text-xs" />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="Adresse kopieren" @click="copy(baseUrl, 'Adresse')">
              <CopyIcon />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </SettingField>
      <SettingField for="api-token" label="Token" description="Als „Authorization: Bearer <token>“ mitsenden.">
        <InputGroup class="w-80">
          <InputGroupInput
            id="api-token"
            :model-value="status?.token ?? ''"
            :type="showToken ? 'text' : 'password'"
            readonly
            class="font-mono text-xs"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" :aria-label="showToken ? 'Verbergen' : 'Anzeigen'" @click="showToken = !showToken">
              <EyeOffIcon v-if="showToken" />
              <EyeIcon v-else />
            </InputGroupButton>
            <InputGroupButton
              size="icon-xs"
              aria-label="Token kopieren"
              :disabled="!status?.token"
              @click="copy(status?.token ?? '', 'Token')"
            >
              <CopyIcon />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <Button variant="outline" size="sm" @click="regenerate">
          <RefreshCwIcon data-icon="inline-start" />
          Neu
        </Button>
      </SettingField>
    </SettingsSection>

    <SettingsSection title="Dokumentation" description="Interaktive Referenz aller Endpunkte (OpenAPI 3.1).">
      <SettingField label="API-Dokumentation" :description="`${baseUrl}/docs`">
        <Button variant="outline" size="sm" :disabled="!status?.running" @click="openDocs">
          <BookOpenIcon data-icon="inline-start" />
          Im Browser öffnen
        </Button>
      </SettingField>
      <div class="flex flex-col gap-2">
        <span class="text-xs text-muted-foreground">Beispiel</span>
        <pre class="selectable overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs">{{ example }}</pre>
      </div>
    </SettingsSection>
  </div>
</template>
