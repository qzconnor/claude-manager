<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Artifact } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toastError } from '@/lib/errors'
import { useArtifactsStore } from '@/stores/artifacts'

/** Another title for an artifact, on claude.ai: everyone it is shared with sees it. */
const props = defineProps<{ accountId: string; artifact: Artifact | null }>()
const open = defineModel<boolean>('open', { required: true })

const store = useArtifactsStore()
const title = ref('')
const saving = ref(false)
/** Kept while the dialog closes, so its text doesn't change during the animation. */
const id = ref('')

watch(
  () => [open.value, props.artifact] as const,
  ([isOpen, artifact]) => {
    if (!isOpen || !artifact) return
    id.value = artifact.id
    title.value = artifact.title
    saving.value = false
  },
  { immediate: true },
)

async function save() {
  if (saving.value) return
  if (title.value.trim() === props.artifact?.title) {
    open.value = false
    return
  }
  saving.value = true
  try {
    await store.rename(props.accountId, id.value, title.value)
    open.value = false
  } catch (error) {
    toastError(error, 'Umbenennen fehlgeschlagen')
  } finally {
    saving.value = false
  }
}

function selectAll(event: Event) {
  event.preventDefault()
  const input = document.getElementById('artifact-title')
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md" @open-auto-focus="selectAll">
      <DialogHeader>
        <DialogTitle>Artefakt umbenennen</DialogTitle>
        <DialogDescription>Der Titel ändert sich auf claude.ai, auch für alle, mit denen es geteilt ist.</DialogDescription>
      </DialogHeader>
      <form id="artifact-rename-form" @submit.prevent="save">
        <FieldGroup>
          <Field>
            <FieldLabel for="artifact-title">Titel</FieldLabel>
            <Input id="artifact-title" v-model="title" maxlength="300" spellcheck="false" autocomplete="off" :disabled="saving" />
          </Field>
        </FieldGroup>
      </form>
      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="artifact-rename-form" :disabled="saving || !title.trim()">
          <Spinner v-if="saving" data-icon="inline-start" />
          Speichern
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
