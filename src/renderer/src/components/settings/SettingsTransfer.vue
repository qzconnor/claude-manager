<script setup lang="ts">
import { FileInputIcon, FileOutputIcon } from '@lucide/vue'
import { ref, toRaw } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { attempt } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

/** Export and import of the settings, e.g. to take them to another computer. Accounts stay out. */
const settings = useSettingsStore()
const ui = useUiStore()
const busy = ref(false)

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

function importSettings() {
  const previous = structuredClone(toRaw(settings.settings))
  void run(async () => {
    const result = await settings.importFromFile()
    if (!result) return
    // What runs and what Claude may do without asking only comes along once the user agrees.
    let heldTaken = false
    if (result.held) {
      heldTaken = await ui.confirm({
        title: 'Auch diese Einstellungen übernehmen?',
        description:
          'Sie bestimmen, welches Programm startet und was Claude ohne Nachfrage darf. Übernimm sie nur aus einer Datei, der du vertraust; ohne sie bleiben deine bisherigen Werte.',
        code: result.held.changes.map((change) => `${change.label}: ${change.value}`).join('\n'),
        confirmText: 'Übernehmen',
        cancelText: 'Weglassen',
        warning: true,
      })
      if (heldTaken) await settings.update(result.held.patch)
    }
    const left = result.held && !heldTaken ? `Weggelassen: ${result.held.changes.map((change) => change.label).join(', ')}` : null
    const missing = result.skipped.length ? `Nicht übernommen, weil es das auf diesem Computer nicht gibt: ${result.skipped.join(', ')}` : null
    toast.success('Einstellungen importiert', {
      description: [missing, left].filter(Boolean).join('. ') || undefined,
      action: {
        label: 'Rückgängig',
        onClick: () => void attempt(() => settings.update(previous), 'Rückgängig fehlgeschlagen'),
      },
    })
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
    <TooltipContent>Einstellungen aus einer Datei übernehmen</TooltipContent>
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
</template>
