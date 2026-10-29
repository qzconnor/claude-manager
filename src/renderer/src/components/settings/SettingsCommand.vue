<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { CommandStatus } from '@shared/types'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { attempt } from '@/lib/errors'
import SettingField from './SettingField.vue'
import SettingsSection from './SettingsSection.vue'

const EXAMPLES = [
  ['cm', 'Session im aktuellen Ordner'],
  ['cm C:\\Projekte\\demo', 'Session in einem anderen Ordner'],
  ['cm -a Firma', 'mit bestimmtem Account'],
  ['cm -c', 'letzte Session hier fortsetzen'],
  ['cm -r', 'Session auswählen und fortsetzen'],
  ['cm -- --model opus', 'Argumente an claude weitergeben'],
] as const

const status = ref<CommandStatus | null>(null)
const busy = ref(false)

onMounted(async () => {
  status.value = (await attempt(() => window.api.command.status(), 'Status von „cm“ unbekannt')) ?? null
})

async function setRegistered(registered: boolean) {
  busy.value = true
  const next = await attempt(() => window.api.command.setRegistered(registered), 'Ändern fehlgeschlagen')
  busy.value = false
  if (!next) return
  status.value = next
  if (next.registered) toast.success('„cm“ ist eingerichtet', { description: 'In neu geöffneten Terminals verfügbar.' })
}
</script>

<template>
  <SettingsSection title="Befehl „cm“" description="Öffnet eine Claude-Session im Manager – aus jedem Terminal oder der Explorer-Adressleiste.">
    <SettingField
      for="command-registered"
      label="Befehl einrichten"
      :description="
        status && !status.available
          ? 'Nur in der installierten App verfügbar.'
          : 'Wird bei der Installation eingerichtet: Benutzer-PATH und App-Pfad für den Explorer.'
      "
    >
      <Spinner v-if="busy" class="text-muted-foreground" />
      <Switch
        id="command-registered"
        :model-value="status?.registered ?? false"
        :disabled="busy || !status?.available"
        @update:model-value="setRegistered"
      />
    </SettingField>
    <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
      <template v-for="[command, meaning] in EXAMPLES" :key="command">
        <dt><code class="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{{ command }}</code></dt>
        <dd class="text-muted-foreground">{{ meaning }}</dd>
      </template>
    </dl>
  </SettingsSection>
</template>
