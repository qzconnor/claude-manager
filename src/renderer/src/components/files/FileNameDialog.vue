<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/errors'
import { childPath, stemEnd, typedPath, type NameRequest } from '@/lib/tree-names'

/**
 * Asks the file tree for a name: of a new file or folder in a folder of the tree, or a new one for an
 * entry. What is wrong with the name shows while typing; what the disk refuses (the name is taken),
 * after the click.
 */
const props = defineProps<{
  /** The tree's folder (absolute). */
  root: string
  rootName: string
  /** Opens the dialog; null closes it. */
  request: NameRequest | null
}>()
const emit = defineEmits<{
  close: []
  /** Made or renamed: the entry's path in the tree now. */
  done: [path: string, request: NameRequest]
}>()

const platform = window.api.platform

const open = computed({
  get: () => props.request !== null,
  set: (value) => {
    if (!value) emit('close')
  },
})
/** Kept while the dialog closes, so its text doesn't change during the animation. */
const shown = ref<NameRequest>({ kind: 'file', parent: '', name: '', dir: false })
const name = ref('')
/** What the disk refused, until the name changes. */
const failed = ref<string | null>(null)
const saving = ref(false)

watch(
  () => props.request,
  (request) => {
    if (!request) return
    shown.value = request
    name.value = request.name
    failed.value = null
    saving.value = false
  },
  { immediate: true },
)
watch(name, () => (failed.value = null))

const typed = computed(() => typedPath(shown.value, name.value, platform))
/** Nothing typed yet isn't wrong: the button waits. */
const problem = computed(() => failed.value ?? (name.value.trim() ? typed.value.problem : null))

const title = computed(() => {
  const { kind, dir } = shown.value
  if (kind === 'file') return 'Neue Datei'
  if (kind === 'folder') return 'Neuer Ordner'
  return dir ? 'Ordner umbenennen' : 'Datei umbenennen'
})
const where = computed(() => (shown.value.parent ? `${props.rootName}/${shown.value.parent}` : props.rootName))

async function submit() {
  const request = shown.value
  const { path, problem: wrong } = typed.value
  if (wrong || saving.value) return
  const from = childPath(request.parent, request.name)
  if (request.kind === 'rename' && path === from) return emit('close')
  saving.value = true
  try {
    if (request.kind === 'rename') await window.api.files.rename(props.root, from, path)
    else await window.api.files.create(props.root, path, request.kind === 'folder')
    emit('done', path, request)
  } catch (error) {
    failed.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

/** Renaming selects the name up to its extension, like VS Code. */
function onOpen(event: Event) {
  const input = document.getElementById('file-tree-name')
  event.preventDefault()
  if (!(input instanceof HTMLInputElement)) return
  input.focus()
  input.setSelectionRange(0, stemEnd(input.value, shown.value.dir))
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md" @open-auto-focus="onOpen">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription class="[overflow-wrap:anywhere]">
          <template v-if="shown.kind === 'rename'">„{{ shown.name }}“ in {{ where }}</template>
          <template v-else>In {{ where }}</template>
        </DialogDescription>
      </DialogHeader>

      <form id="file-tree-name-form" class="flex flex-col gap-5" @submit.prevent="submit">
        <FieldGroup>
          <Field :data-invalid="!!problem || undefined">
            <FieldLabel for="file-tree-name">Name</FieldLabel>
            <Input
              id="file-tree-name"
              v-model="name"
              spellcheck="false"
              autocomplete="off"
              :aria-invalid="!!problem || undefined"
              :disabled="saving"
            />
            <FieldError v-if="problem">{{ problem }}</FieldError>
            <FieldDescription v-else-if="shown.kind !== 'rename'">
              Mit „/“ entstehen Ordner darin gleich mit, etwa <code class="font-mono">lib/neu.ts</code>.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="file-tree-name-form" :disabled="saving || !name.trim() || !!problem">
          <Spinner v-if="saving" data-icon="inline-start" />
          {{ shown.kind === 'rename' ? 'Umbenennen' : 'Anlegen' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
