<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { WORKSPACE_PROMPT_FILE, workspaceNameError } from '@shared/workspaces'
import DirectoryInput from '@/components/common/DirectoryInput.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { toastError } from '@/lib/errors'
import { shortenPath } from '@/lib/format'
import { splitFolder } from '@/lib/recent-folders'
import { useAppStore } from '@/stores/app'
import { useUiStore } from '@/stores/ui'
import { useWorkspacesStore } from '@/stores/workspaces'

/**
 * A new workspace (a folder with `cm_prompts.md`), an existing folder made one, or the prompt of a
 * workspace: what every session in its projects gets appended to its system prompt.
 */
const ui = useUiStore()
const app = useAppStore()
const workspaces = useWorkspacesStore()

/** Where the last workspace was made, as the place for the next one. */
const PARENT_KEY = 'claude-manager.workspaceParent'

const open = computed({
  get: () => ui.workspaceRequest !== null,
  set: (value) => {
    if (!value) ui.workspaceRequest = null
  },
})
/** Kept while the dialog closes, so its text doesn't change during the animation. */
const mode = ref<'create' | 'adopt' | 'edit'>('create')
const path = ref('')
const name = ref('')
const parent = ref('')
const prompt = ref('')
const loadingPrompt = ref(false)
const saving = ref(false)
const touched = ref(false)

function rememberedParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? ''
  } catch {
    return ''
  }
}

let request = 0
watch(
  () => ui.workspaceRequest,
  async (next) => {
    if (!next) return
    const current = ++request
    mode.value = next.mode
    saving.value = false
    touched.value = false
    prompt.value = ''
    if (next.mode === 'create') {
      path.value = ''
      name.value = ''
      const last = workspaces.workspaces.at(-1)?.path
      parent.value = next.parent ?? (rememberedParent() || (last ? splitFolder(last).parent : ''))
      return
    }
    path.value = next.path
    name.value = splitFolder(next.path).name
    // What is there already: the prompt of a workspace, or a `cm_prompts.md` that came with the folder.
    loadingPrompt.value = true
    const text = await workspaces.readPrompt(next.path).catch(() => '')
    if (current !== request) return
    prompt.value = text.trimEnd()
    loadingPrompt.value = false
  },
  { immediate: true },
)

const nameError = computed(() => (mode.value === 'create' && touched.value ? workspaceNameError(name.value) : null))
const target = computed(() => {
  if (mode.value !== 'create') return path.value
  const dir = parent.value.trim()
  const trimmed = name.value.trim()
  if (!dir || !trimmed) return ''
  return /[\\/]$/.test(dir) ? `${dir}${trimmed}` : `${dir}${dir.includes('/') && !dir.includes('\\') ? '/' : '\\'}${trimmed}`
})
const canSave = computed(() => {
  if (saving.value || loadingPrompt.value) return false
  if (mode.value !== 'create') return true
  return !workspaceNameError(name.value) && parent.value.trim().length > 0
})

const title = computed(() =>
  mode.value === 'create' ? 'Neuer Workspace' : mode.value === 'adopt' ? `„${name.value}“ zum Workspace machen` : `Prompt von „${name.value}“`,
)
const action = computed(() => (mode.value === 'create' ? 'Anlegen' : mode.value === 'adopt' ? 'Zum Workspace machen' : 'Speichern'))

function focusFirstField() {
  document.getElementById(mode.value === 'create' ? 'workspace-name' : 'workspace-prompt')?.focus()
}

async function save() {
  touched.value = true
  if (!canSave.value) return
  saving.value = true
  try {
    if (mode.value === 'create') {
      const dir = parent.value.trim()
      const created = await workspaces.create({ parent: dir, name: name.value.trim(), prompt: prompt.value })
      try {
        localStorage.setItem(PARENT_KEY, dir)
      } catch {
        // Only a convenience for the next time.
      }
      toast.success(`Workspace „${created.name}“ angelegt`)
      ui.folderToShow = { path: created.path }
    } else if (mode.value === 'adopt') {
      const adopted = await workspaces.adopt(path.value, prompt.value)
      toast.success(`„${adopted.name}“ ist jetzt ein Workspace`, {
        description: adopted.projects.length
          ? `${adopted.projects.length} ${adopted.projects.length === 1 ? 'Projekt' : 'Projekte'}`
          : undefined,
      })
      ui.folderToShow = { path: adopted.path }
    } else {
      await workspaces.writePrompt(path.value, prompt.value)
      toast.success('Prompt gespeichert', { description: 'Gilt für Sessions, die ab jetzt starten.' })
    }
    open.value = false
  } catch (error) {
    toastError(error, mode.value === 'edit' ? 'Prompt konnte nicht gespeichert werden' : 'Workspace konnte nicht angelegt werden')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-xl" @open-auto-focus.prevent="focusFirstField">
      <DialogHeader>
        <DialogTitle class="truncate">{{ title }}</DialogTitle>
        <DialogDescription v-if="mode === 'edit'">
          Jede Session in diesem Workspace und seinen Projekten bekommt den Text zusätzlich als System-Prompt. Er gilt für
          Sessions, die ab jetzt starten; fortgesetzte behalten ihren bis zum nächsten Zusammenfassen.
        </DialogDescription>
        <DialogDescription v-else>
          Jeder Unterordner {{ mode === 'adopt' ? 'des Ordners' : 'des Workspaces' }} ist ein Projekt. Was im Prompt steht,
          bekommt jede Session darin zusätzlich als System-Prompt, egal mit welchem Account.
        </DialogDescription>
      </DialogHeader>

      <form id="workspace-form" class="flex flex-col gap-5" @submit.prevent="save">
        <FieldGroup>
          <template v-if="mode === 'create'">
            <Field :data-invalid="!!nameError || undefined">
              <FieldLabel for="workspace-name">Name</FieldLabel>
              <Input
                id="workspace-name"
                v-model="name"
                placeholder="z. B. Webseiten"
                spellcheck="false"
                autocomplete="off"
                :disabled="saving"
                @blur="touched = name.trim().length > 0 || touched"
              />
              <FieldError v-if="nameError">{{ nameError }}</FieldError>
            </Field>
            <Field>
              <FieldLabel for="workspace-parent">Ort</FieldLabel>
              <DirectoryInput id="workspace-parent" v-model="parent" placeholder="Ordner, in dem er entsteht" :disabled="saving" />
              <!-- Wrapped, not cut: the name of the new folder is at the end. -->
              <FieldDescription v-if="target" class="font-mono text-xs break-all">
                {{ shortenPath(target, app.info?.homeDir) }}
              </FieldDescription>
            </Field>
          </template>
          <Field v-else>
            <FieldLabel>Ordner</FieldLabel>
            <p class="font-mono text-xs break-all text-muted-foreground">{{ shortenPath(path, app.info?.homeDir) }}</p>
          </Field>

          <Field>
            <FieldLabel for="workspace-prompt">Prompt</FieldLabel>
            <div class="relative">
              <Textarea
                id="workspace-prompt"
                v-model="prompt"
                :placeholder="loadingPrompt ? '' : 'z. B. Nutze nur Open-Source-Bibliotheken.'"
                spellcheck="false"
                :disabled="saving || loadingPrompt"
                class="max-h-[45vh] min-h-36 overflow-y-auto"
              />
              <Spinner v-if="loadingPrompt" class="absolute top-3 right-3 size-4 text-muted-foreground" />
            </div>
            <FieldDescription>
              {{ mode === 'edit' ? 'Steht' : 'Kommt' }} als <span class="font-mono">{{ WORKSPACE_PROMPT_FILE }}</span> in den
              Ordner{{ mode === 'edit' ? '' : ', leer wenn du nichts einträgst' }}.
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="open = false">Abbrechen</Button>
        <Button type="submit" form="workspace-form" :disabled="!canSave">
          <Spinner v-if="saving" data-icon="inline-start" />
          {{ action }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
