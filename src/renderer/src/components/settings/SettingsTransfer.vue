<script setup lang="ts">
import { FileInputIcon, FileOutputIcon } from '@lucide/vue'
import { ref, shallowRef } from 'vue'
import { toast } from 'vue-sonner'
import type { SettingsImportPreview } from '@shared/types'
import SettingsImportDialog from '@/components/settings/SettingsImportDialog.vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { attempt } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'

/** Export and import of the settings, e.g. to take them to another computer. Accounts stay out. */
const settings = useSettingsStore()
const busy = ref(false)
const preview = shallowRef<SettingsImportPreview | null>(null)
const previewOpen = ref(false)

async function run(action: () => Promise<void>, title: string) {
  if (busy.value) return
  busy.value = true
  try {
    await attempt(action, title)
  } finally {
    busy.value = false
  }
}

function exportSettings() {
  void run(async () => {
    const file = await settings.exportToFile()
    if (file) toast.success('Einstellungen exportiert', { description: file })
  }, 'Export fehlgeschlagen')
}

/** Shows what the file would change; the dialog takes over what the user picks. */
function importSettings() {
  void run(async () => {
    const next = await settings.previewImport()
    if (!next) return
    if (next.changes.length === 0) {
      const missing = next.skipped.join(', ')
      toast.info('Nichts zu übernehmen', {
        description: missing
          ? `Nicht übernommen, weil es das auf diesem Computer nicht gibt: ${missing}`
          : 'Die Datei hat dieselben Einstellungen wie jetzt.',
      })
      return
    }
    preview.value = next
    previewOpen.value = true
  }, 'Import fehlgeschlagen')
}
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button variant="outline" :disabled="busy" @click="importSettings">
        <FileInputIcon data-icon="inline-start" />
        Importieren
      </Button>
    </TooltipTrigger>
    <TooltipContent>Zeigt, was eine Datei ändern würde, und übernimmt, was du auswählst</TooltipContent>
  </Tooltip>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button variant="outline" :disabled="busy" @click="exportSettings">
        <FileOutputIcon data-icon="inline-start" />
        Exportieren
      </Button>
    </TooltipTrigger>
    <TooltipContent>Einstellungen in einer Datei sichern, ohne Accounts</TooltipContent>
  </Tooltip>
  <SettingsImportDialog v-model:open="previewOpen" :preview="preview" />
</template>
