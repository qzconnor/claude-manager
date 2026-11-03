<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import DirectoryInput from '@/components/common/DirectoryInput.vue'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { attempt } from '@/lib/errors'
import { useAppStore } from '@/stores/app'
import { useSettingsStore } from '@/stores/settings'

/**
 * Asked once on the first start: the folder new sessions start in. Not the home folder by
 * default, where Claude Code asks for trust with every session. Put off, it stays the Downloads folder.
 */
const settings = useSettingsStore()
const app = useAppStore()

const open = computed(
  () => settings.loaded && !settings.settings.claude.defaultCwdAsked && !settings.settings.claude.defaultCwd,
)
const folder = ref('')
const saving = ref(false)

watch(
  () => [open.value, app.info?.fallbackCwd] as const,
  ([isOpen, fallback]) => {
    if (isOpen && !folder.value) folder.value = fallback ?? ''
  },
  { immediate: true },
)

async function answer(chosen: string | null) {
  saving.value = true
  await attempt(
    () => settings.update({ claude: { defaultCwdAsked: true, ...(chosen ? { defaultCwd: chosen } : {}) } }),
    'Ordner konnte nicht gespeichert werden',
  )
  saving.value = false
}
</script>

<template>
  <AlertDialog :open="open">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Wo sollen neue Sessions starten?</AlertDialogTitle>
        <AlertDialogDescription>
          In diesem Ordner öffnet Claude Code eine neue Session, wenn du keinen anderen wählst. Der Benutzerordner ist
          dafür ungünstig: Dort fragt Claude Code bei jeder Session, ob es dem Ordner vertrauen darf.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <Field>
        <FieldLabel for="default-folder">Standard-Arbeitsordner</FieldLabel>
        <DirectoryInput id="default-folder" v-model="folder" :disabled="saving" />
        <FieldDescription>Später änderbar unter Einstellungen → Claude Code, Accounts können eigene Ordner haben.</FieldDescription>
      </Field>
      <AlertDialogFooter>
        <Button variant="outline" :disabled="saving" @click="answer(null)">Später</Button>
        <Button :disabled="saving || !folder.trim()" @click="answer(folder.trim())">Übernehmen</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
